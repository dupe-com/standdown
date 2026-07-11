import { classifyReferrer, detect } from './detect';
import type {
  AuditEntry,
  Decision,
  Detection,
  SessionRecord,
  Signals,
  StanddownPolicy,
  StanddownState,
  StateStore,
} from './types';
import { validatePolicies } from './validation';

export class MemoryStateStore implements StateStore {
  #state: StanddownState | undefined;

  constructor(initialState?: StanddownState) {
    this.#state = initialState ? cloneState(initialState) : undefined;
  }

  async load(): Promise<StanddownState | undefined> {
    return this.#state ? cloneState(this.#state) : undefined;
  }

  async save(state: StanddownState): Promise<void> {
    this.#state = cloneState(state);
  }
}

export class StanddownSession {
  readonly #store: StateStore;
  readonly #auditLog: boolean;
  readonly #maxAuditEntries: number;
  readonly #readOnlyAuditLog: AuditEntry[] = [];

  constructor(
    store: StateStore,
    opts?: { auditLog?: boolean; maxAuditEntries?: number },
  ) {
    this.#store = store;
    this.#auditLog = opts?.auditLog ?? true;
    this.#maxAuditEntries = Math.max(0, opts?.maxAuditEntries ?? 1_000);
  }

  async ingest(
    signals: Signals,
    policies: readonly StanddownPolicy[],
  ): Promise<Decision> {
    const advertiserHost = hostFromUrl(signals.url);

    try {
      validatePolicies(policies);
    } catch (error) {
      return this.#failClosedWithAudit(
        signals.now,
        'ingest',
        advertiserHost,
        `malformed-policy: ${messageFromError(error)}`,
      );
    }

    const detection = detect(signals, policies);

    if (detection.failClosedReason) {
      return this.#failClosedWithAudit(
        signals.now,
        'ingest',
        advertiserHost,
        detection.failClosedReason,
        detection,
      );
    }

    return this.#withState(signals.now, (state) => {
      pruneExpiredSessions(state, signals.now);

      if (detection.strongest) {
        const matchedPolicies = policiesForDetection(policies, detection);

        if (matchedPolicies.length === 0) {
          return {
            decision: failClosedDecision('matched-policy-missing'),
            detection,
          };
        }

        const record = upsertSessionRecord(
          state,
          detection.strongest.advertiserHost,
          detection.strongest.policyId,
          matchedPolicies,
          signals.now,
        );

        return {
          decision: decisionFromRecord(record, signals.now, {
            reason: detection.strongest.reason,
            referrerClass: classifyReferrer(signals, record.advertiserHost),
          }),
          detection,
        };
      }

      const activeDecision = advertiserHost
        ? activeDecisionForHost(state, advertiserHost, signals.now)
        : undefined;

      return {
        decision:
          activeDecision ??
          ({
            standDown: false,
            reason: detection.selfMatch
              ? 'self-exempted-no-active-standdown'
              : 'no-active-standdown',
            behaviors: [],
            referrerClass: advertiserHost
              ? classifyReferrer(signals, advertiserHost)
              : 'other',
          } satisfies Decision),
        detection,
      };
    }, 'ingest');
  }

  async shouldStandDown(
    advertiserHost: string,
    now: number,
  ): Promise<Decision> {
    return this.#withState(
      now,
      (state) => {
        pruneExpiredSessions(state, now);

        return {
          decision:
            activeDecisionForHost(state, advertiserHost, now) ??
            ({
              standDown: false,
              reason: 'no-active-standdown',
              behaviors: [],
            } satisfies Decision),
        };
      },
      'shouldStandDown',
      normalizeHost(advertiserHost),
      { persist: false },
    );
  }

  async recordActivity(now: number): Promise<void> {
    await this.#withState(
      now,
      (state) => {
        pruneExpiredSessions(state, now);

        for (const record of Object.values(state.sessions)) {
          if (record.sessionRule === 'inactivity-window') {
            record.lastActivityAt = now;
            const expiresAt = computeExpiresAt(record);

            if (expiresAt !== undefined) {
              record.expiresAt = expiresAt;
            }
          }
        }

        return {
          decision: {
            standDown: false,
            reason: 'activity-recorded',
            behaviors: [],
          },
        };
      },
      'recordActivity',
    );
  }

  async exportAuditLog(): Promise<AuditEntry[]> {
    const state = await this.#loadState();
    return trimAuditLog(
      [...state.auditLog, ...this.#readOnlyAuditLog],
      this.#maxAuditEntries,
    ).map(cloneAuditEntry);
  }

  async #withState(
    now: number,
    fn: (state: StanddownState) => {
      decision: Decision;
      detection?: Detection;
    },
    action: AuditEntry['action'],
    advertiserHost?: string,
    opts: { persist?: boolean } = {},
  ): Promise<Decision> {
    let state: StanddownState;

    try {
      state = await this.#loadState();
    } catch {
      return failClosedDecision('store-error');
    }

    const result = fn(state);

    if (this.#auditLog) {
      const entry = auditEntry({
        time: now,
        action,
        advertiserHost:
          advertiserHost ?? result.detection?.strongest?.advertiserHost,
        detection: result.detection,
        decision: result.decision,
      });

      if (opts.persist === false) {
        appendAuditEntry(this.#readOnlyAuditLog, entry, this.#maxAuditEntries);
      } else {
        appendAuditEntry(state.auditLog, entry, this.#maxAuditEntries);
      }
    }

    if (opts.persist === false) {
      return result.decision;
    }

    try {
      await this.#store.save(state);
    } catch {
      return failClosedDecision('store-error');
    }

    return result.decision;
  }

  async #failClosedWithAudit(
    now: number,
    action: AuditEntry['action'],
    advertiserHost: string | undefined,
    reason: string,
    detection?: Detection,
  ): Promise<Decision> {
    const decision = failClosedDecision(reason);

    if (!this.#auditLog) {
      return decision;
    }

    try {
      const state = await this.#loadState();
      appendAuditEntry(
        state.auditLog,
        auditEntry({
          time: now,
          action,
          advertiserHost,
          detection,
          decision,
        }),
        this.#maxAuditEntries,
      );
      await this.#store.save(state);
    } catch {
      return failClosedDecision('store-error');
    }

    return decision;
  }

  async #loadState(): Promise<StanddownState> {
    return (await this.#store.load()) ?? { sessions: {}, auditLog: [] };
  }
}

function appendAuditEntry(
  auditLog: AuditEntry[],
  entry: AuditEntry,
  maxEntries: number,
): void {
  if (maxEntries === 0) {
    auditLog.length = 0;
    return;
  }

  auditLog.push(entry);

  if (auditLog.length > maxEntries) {
    auditLog.splice(0, auditLog.length - maxEntries);
  }
}

function trimAuditLog(
  auditLog: readonly AuditEntry[],
  maxEntries: number,
): AuditEntry[] {
  if (maxEntries === 0) {
    return [];
  }

  return auditLog.slice(Math.max(0, auditLog.length - maxEntries));
}

function upsertSessionRecord(
  state: StanddownState,
  advertiserHost: string,
  primaryPolicyId: string,
  policies: readonly StanddownPolicy[],
  now: number,
): SessionRecord {
  const key = normalizeHost(advertiserHost);
  const existing = state.sessions[key];
  const startedAt = existing?.startedAt ?? now;
  const lastActivityAt = now;
  const sessionRule =
    existing?.sessionRule === 'session-or-min' ||
    policies.some((policy) => policy.standdown.sessionRule === 'session-or-min')
      ? 'session-or-min'
      : 'inactivity-window';
  const baseRecord: SessionRecord = {
    advertiserHost: key,
    policyId: primaryPolicyId,
    startedAt,
    lastActivityAt,
    sessionRule,
    minDurationMs: Math.max(
      existing?.minDurationMs ?? 0,
      ...policies.map((policy) => policy.standdown.minDurationMs),
    ),
    behaviors: unionBehaviors([
      ...(existing?.behaviors ?? []),
      ...policies.flatMap((policy) => policy.standdown.behaviors),
    ]),
  };

  if (sessionRule === 'inactivity-window') {
    const inactivityMs = Math.max(
      existing?.inactivityMs ?? 0,
      ...policies.flatMap((policy) =>
        policy.standdown.inactivityMs === undefined
          ? []
          : [policy.standdown.inactivityMs],
      ),
    );

    if (inactivityMs > 0) {
      baseRecord.inactivityMs = inactivityMs;
    }
  }

  const computedExpiresAt = computeExpiresAt(baseRecord);

  if (computedExpiresAt !== undefined) {
    baseRecord.expiresAt = Math.max(existing?.expiresAt ?? 0, computedExpiresAt);
  }

  state.sessions[key] = baseRecord;

  return baseRecord;
}

function policiesForDetection(
  policies: readonly StanddownPolicy[],
  detection: Detection,
): StanddownPolicy[] {
  if (detection.strongest === undefined) {
    return [];
  }

  const matchingPolicyIds = new Set(
    detection.matched
      .filter(
        (match) => match.advertiserHost === detection.strongest?.advertiserHost,
      )
      .map((match) => match.policyId),
  );

  return policies.filter((policy) => matchingPolicyIds.has(policy.id));
}

function unionBehaviors(behaviors: readonly SessionRecord['behaviors'][number][]) {
  return [...new Set(behaviors)];
}

function activeDecisionForHost(
  state: StanddownState,
  advertiserHost: string,
  now: number,
): Decision | undefined {
  const record = state.sessions[normalizeHost(advertiserHost)];

  if (!record || !isActive(record, now)) {
    return undefined;
  }

  return decisionFromRecord(record, now);
}

function decisionFromRecord(
  record: SessionRecord,
  now: number,
  overrides?: { reason?: string; referrerClass?: Decision['referrerClass'] },
): Decision {
  const expiresAt = computeExpiresAt(record);
  const decision: Decision = {
    standDown: true,
    policyId: record.policyId,
    reason: overrides?.reason ?? `active-standdown:${record.policyId}`,
    behaviors: [...record.behaviors],
  };

  if (expiresAt !== undefined) {
    decision.expiresAt = expiresAt;
  }

  if (overrides?.referrerClass !== undefined) {
    decision.referrerClass = overrides.referrerClass;
  }

  if (!isActive({ ...record, ...(expiresAt === undefined ? {} : { expiresAt }) }, now)) {
    return {
      standDown: false,
      reason: 'standdown-expired',
      behaviors: [],
    };
  }

  return decision;
}

function computeExpiresAt(record: SessionRecord): number | undefined {
  if (
    record.sessionRule === 'inactivity-window' &&
    record.inactivityMs !== undefined
  ) {
    return Math.max(
      record.startedAt + record.minDurationMs,
      record.lastActivityAt + record.inactivityMs,
    );
  }

  return record.expiresAt;
}

function isActive(record: SessionRecord, now: number): boolean {
  if (record.sessionRule === 'session-or-min') {
    return true;
  }

  const expiresAt = computeExpiresAt(record);

  return expiresAt === undefined ? false : now < expiresAt;
}

function pruneExpiredSessions(state: StanddownState, now: number): void {
  for (const [host, record] of Object.entries(state.sessions)) {
    if (!isActive(record, now)) {
      delete state.sessions[host];
    }
  }
}

function failClosedDecision(reason: string): Decision {
  return {
    standDown: true,
    reason,
    behaviors: [
      'suppress-prompts',
      'no-cookie-write',
      'no-redirect',
      'no-background-tracking',
    ],
  };
}

function auditEntry(value: {
  time: number;
  action: AuditEntry['action'];
  advertiserHost: string | undefined;
  detection: Detection | undefined;
  decision: Decision | undefined;
}): AuditEntry {
  const entry: AuditEntry = {
    time: value.time,
    action: value.action,
  };

  if (value.advertiserHost !== undefined) {
    entry.advertiserHost = value.advertiserHost;
  }

  if (value.detection !== undefined) {
    entry.detection = value.detection;
  }

  if (value.decision !== undefined) {
    entry.decision = value.decision;
  }

  return entry;
}

function cloneState(state: StanddownState): StanddownState {
  return {
    sessions: Object.fromEntries(
      Object.entries(state.sessions).map(([host, record]) => [
        host,
        {
          ...record,
          behaviors: [...record.behaviors],
        },
      ]),
    ),
    auditLog: state.auditLog.map(cloneAuditEntry),
  };
}

function cloneAuditEntry(entry: AuditEntry): AuditEntry {
  const cloned: AuditEntry = {
    time: entry.time,
    action: entry.action,
  };

  if (entry.advertiserHost !== undefined) {
    cloned.advertiserHost = entry.advertiserHost;
  }

  if (entry.detection !== undefined) {
    const detection: Detection = {
      matched: entry.detection.matched.map((match) => ({ ...match })),
      selfMatch: entry.detection.selfMatch,
    };

    if (entry.detection.strongest !== undefined) {
      detection.strongest = { ...entry.detection.strongest };
    }

    if (entry.detection.failClosedReason !== undefined) {
      detection.failClosedReason = entry.detection.failClosedReason;
    }

    cloned.detection = detection;
  }

  if (entry.decision !== undefined) {
    cloned.decision = {
      ...entry.decision,
      behaviors: [...entry.decision.behaviors],
    };
  }

  return cloned;
}

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/\.$/, '');
}

function hostFromUrl(value: string): string | undefined {
  try {
    return normalizeHost(new URL(value).hostname);
  } catch {
    return undefined;
  }
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
