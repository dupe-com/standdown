import { classifyReferrer, detect } from './detect';
import type {
  AuditEntry,
  Decision,
  Detection,
  ExemptionRecord,
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
  readonly #selfExemptionScope: 'policy' | 'session';
  readonly #readOnlyAuditLog: AuditEntry[] = [];
  #stateLock: Promise<unknown> = Promise.resolve();

  constructor(
    store: StateStore,
    opts?: {
      auditLog?: boolean;
      maxAuditEntries?: number;
      /**
       * How long a `selfPatterns` match suppresses stand-down for its
       * advertiser host. `'policy'` (default) exempts only the navigation that
       * carries the param. `'session'` persists the exemption for the host and
       * re-applies it to that same network's detections on later param-less
       * navigations — Dupe's `ignore_param` semantics. A session exemption never
       * lifts an already-active stand-down and never covers a `disabled-host`.
       */
      selfExemptionScope?: 'policy' | 'session';
    },
  ) {
    this.#store = store;
    this.#auditLog = opts?.auditLog ?? true;
    this.#maxAuditEntries = Math.max(0, opts?.maxAuditEntries ?? 1_000);
    this.#selfExemptionScope = opts?.selfExemptionScope ?? 'policy';
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

      let effective = detection;

      if (this.#selfExemptionScope === 'session' && advertiserHost) {
        recordSessionExemptions(state, advertiserHost, detection, signals.now);
        effective = applySessionExemptions(
          advertiserHost,
          detection,
          state.exemptions?.[advertiserHost],
        );
      }

      if (effective.strongest) {
        const matchedPolicies = policiesForDetection(policies, effective);

        if (matchedPolicies.length === 0) {
          return {
            decision: failClosedDecision('matched-policy-missing'),
            detection: effective,
          };
        }

        const record = upsertSessionRecord(
          state,
          effective.strongest.advertiserHost,
          effective.strongest.policyId,
          matchedPolicies,
          signals.now,
        );

        return {
          decision: decisionFromRecord(record, signals.now, {
            reason: effective.strongest.reason,
            referrerClass: classifyReferrer(signals, record.advertiserHost),
          }),
          detection: effective,
        };
      }

      const activeDecision = advertiserHost
        ? activeDecisionForHost(state, advertiserHost, signals.now)
        : undefined;

      // A session exemption filtered out what would otherwise have stood down.
      const sessionExempted =
        detection.strongest !== undefined && effective.strongest === undefined;

      return {
        decision:
          activeDecision ??
          ({
            standDown: false,
            reason: sessionExempted
              ? 'self-exempted-session'
              : detection.selfMatch
                ? 'self-exempted-no-active-standdown'
                : 'no-active-standdown',
            behaviors: [],
            referrerClass: advertiserHost
              ? classifyReferrer(signals, advertiserHost)
              : 'other',
            ...(signals.signalCoverage === 'partial' ? { degraded: true } : {}),
          } satisfies Decision),
        detection: effective,
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
    return this.#serialize(async () => {
      const state = await this.#loadState();
      return trimAuditLog(
        [...state.auditLog, ...this.#readOnlyAuditLog],
        this.#maxAuditEntries,
      ).map(cloneAuditEntry);
    });
  }

  /**
   * Serializes every state read-modify-write onto a single FIFO chain.
   * #withState and #failClosedWithAudit each do an async load -> mutate -> save;
   * without this, two overlapping evaluations both load the pre-write snapshot
   * and the second save clobbers the first, so a just-recorded stand-down can be
   * lost. The adapter's own hooks coalesce via a `pending` flag, but external
   * callers driving evaluate()/ingest() concurrently are not otherwise
   * serialized, so this lock is what makes them safe. It also gives
   * read-after-write consistency: a shouldStandDown queued after an ingest reads
   * that ingest's committed state.
   */
  #serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#stateLock.then(task, task);
    this.#stateLock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
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
    return this.#serialize(async () => {
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
    });
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

    return this.#serialize(async () => {
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
    });
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

/**
 * Persist scoped self-exemptions seen on this navigation for the host, so later
 * param-less navigations re-apply them. Monotone: never grant an exemption while
 * a stand-down is already active for the host (that would reduce existing
 * suppression, which a self-exemption may never do).
 */
function recordSessionExemptions(
  state: StanddownState,
  advertiserHost: string,
  detection: Detection,
  now: number,
): void {
  const scopes = detection.selfExemptScopes;

  if (!scopes || scopes.length === 0) {
    return;
  }

  if (activeDecisionForHost(state, advertiserHost, now) !== undefined) {
    return;
  }

  const key = normalizeHost(advertiserHost);

  if (state.exemptions === undefined) {
    state.exemptions = {};
  }

  const exemptions = state.exemptions;
  const existing = exemptions[key];
  const policyIds = new Set(existing?.policyIds ?? []);
  const networkIds = new Set(existing?.networkIds ?? []);

  for (const scope of scopes) {
    policyIds.add(scope.policyId);
    networkIds.add(scope.networkId);
  }

  exemptions[key] = {
    advertiserHost: key,
    policyIds: [...policyIds],
    networkIds: [...networkIds],
    grantedAt: existing?.grantedAt ?? now,
  };
}

/**
 * Re-apply a host's persisted session exemptions: drop matched rules whose
 * policy/network was exempted for this host, then recompute the strongest match.
 *
 * Two matches are never dropped, even when their scope is exempted:
 * - `disabled-host` — a hard-disabled host stands down regardless of any
 *   self-exemption.
 * - a *fresh competing attribution param* (`landing-param` / `redirect-domain`)
 *   that is not itself a self-match on this navigation. A persisted exemption
 *   means "our attribution owns this host's session", which is meant to re-cover
 *   ambient lingering signals (a first-party cookie, the initiator). It must not
 *   swallow a later click that carries *someone else's* attribution id for the
 *   same network, or a competitor could hijack an already-exempted host. This
 *   only bites when self-patterns are value-specific (the documented, correct
 *   way to author them); a name-only self-pattern already claims every value of
 *   that param as ours, so a competing value looks like a self-match and is
 *   suppressed — the same footgun the self-exemption docs already warn about.
 */
function applySessionExemptions(
  advertiserHost: string,
  detection: Detection,
  record: ExemptionRecord | undefined,
): Detection {
  if (!record) {
    return detection;
  }

  const host = normalizeHost(advertiserHost);
  const policyIds = new Set(record.policyIds);
  const networkIds = new Set(record.networkIds);

  // Scopes for which THIS navigation carried our own (value-matched) attribution.
  const selfPolicyIds = new Set(
    detection.selfExemptScopes?.map((scope) => scope.policyId),
  );
  const selfNetworkIds = new Set(
    detection.selfExemptScopes?.map((scope) => scope.networkId),
  );

  const filtered = detection.matched.filter((match) => {
    if (match.kind === 'disabled-host') {
      return true;
    }

    if (normalizeHost(match.advertiserHost) !== host) {
      return true;
    }

    if (!(policyIds.has(match.policyId) || networkIds.has(match.networkId))) {
      return true;
    }

    const isAttributionParam =
      match.kind === 'landing-param' || match.kind === 'redirect-domain';
    const isSelfThisNavigation =
      selfPolicyIds.has(match.policyId) || selfNetworkIds.has(match.networkId);

    // Keep (do not suppress) a competing attribution param that isn't ours.
    if (isAttributionParam && !isSelfThisNavigation) {
      return true;
    }

    return false;
  });

  if (filtered.length === detection.matched.length) {
    return detection;
  }

  const strongest = filtered[0]
    ? {
        policyId: filtered[0].policyId,
        advertiserHost: filtered[0].advertiserHost,
        reason: filtered[0].reason,
      }
    : undefined;

  const next: Detection = { matched: filtered, selfMatch: detection.selfMatch };

  if (strongest) {
    next.strongest = strongest;
  }

  if (detection.selfExemptScopes) {
    next.selfExemptScopes = detection.selfExemptScopes;
  }

  return next;
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
  const cloned: StanddownState = {
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

  if (state.exemptions) {
    cloned.exemptions = Object.fromEntries(
      Object.entries(state.exemptions).map(([host, record]) => [
        host,
        {
          ...record,
          policyIds: [...record.policyIds],
          networkIds: [...record.networkIds],
        },
      ]),
    );
  }

  return cloned;
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

    if (entry.detection.selfExemptScopes !== undefined) {
      detection.selfExemptScopes = entry.detection.selfExemptScopes.map(
        (scope) => ({ ...scope }),
      );
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
