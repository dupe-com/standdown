import { classifyReferrer, detect, domainRuleMatchesUrl } from './detect';
import type {
  AuditEntry,
  Decision,
  Detection,
  ExemptionRecord,
  MatchedRule,
  SelfExemptScope,
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

/** Session options an adapter passes straight through to `StanddownSession`. */
export interface AdapterSessionOptions {
  readonly auditLog?: boolean;
  readonly selfExemptionScope?: 'policy' | 'session';
  readonly sessionExemptionTtlMs?: number;
  readonly sessionKey?: (url: string) => string | undefined;
  readonly selfClickLift?: 'off' | 'same-network';
}

// Every adapter-facing option, once. `satisfies` makes adding an option to
// AdapterSessionOptions without listing it here a compile error, so no adapter
// can silently drop a new option (the relay once missed `sessionKey` that way).
const ADAPTER_SESSION_OPTION_KEYS = {
  auditLog: true,
  selfExemptionScope: true,
  sessionExemptionTtlMs: true,
  sessionKey: true,
  selfClickLift: true,
} as const satisfies Record<keyof AdapterSessionOptions, true>;

/** The session options set on an adapter's options object, or `undefined` if none. */
export function pickSessionOptions(opts: AdapterSessionOptions): AdapterSessionOptions | undefined {
  const picked: Record<string, unknown> = {};

  for (const key of Object.keys(ADAPTER_SESSION_OPTION_KEYS) as (keyof AdapterSessionOptions)[]) {
    if (opts[key] !== undefined) {
      picked[key] = opts[key];
    }
  }

  return Object.keys(picked).length > 0 ? (picked as AdapterSessionOptions) : undefined;
}

export class StanddownSession {
  readonly #store: StateStore;
  readonly #auditLog: boolean;
  readonly #maxAuditEntries: number;
  readonly #selfExemptionScope: 'policy' | 'session';
  readonly #sessionExemptionTtlMs: number;
  readonly #sessionKey: ((url: string) => string | undefined) | undefined;
  readonly #selfClickLift: 'off' | 'same-network';
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
      /**
       * How long a `selfExemptionScope: 'session'` exemption persists for a
       * host, measured from when it was first granted (fixed, not sliding).
       * Defaults to 30 minutes. Set to `0` or any non-positive value to disable
       * expiry and hold the exemption for the lifetime of the session state.
       */
      sessionExemptionTtlMs?: number;
      /**
       * Resolves the key a navigation's stand-down state is filed under.
       * Defaults to the landing hostname, which keeps every host separate.
       * Return a stable advertiser key to share one session across a
       * merchant's hosts — `www`, checkout subdomains, alternate ccTLDs.
       * Returning `undefined` or an empty string falls back to the landing
       * hostname. The key is normalized (lower-cased, trailing dot stripped)
       * before use, and a resolver that throws fails the navigation closed.
       * It must be deterministic: the same URL must always produce the same
       * key, or a read resolves a different bucket than the write filed.
       *
       * Detection is unaffected: policy `advertiserHosts` rules and referrer
       * classification always see the real hostname.
       *
       * `shouldStandDown` does not call this resolver — it looks up state by
       * whatever string it is given. Pass it
       * {@link StanddownSession.resolveSessionKey}'s result rather than the raw
       * landing hostname, or the lookup misses the bucket and silently returns
       * `no-active-standdown`.
       *
       * Scope this narrowly. A key groups both stand-down sessions *and*
       * self-exemptions. Widening it widens suppression (safe), but it also
       * widens any self-exemption granted under it (not safe) — so return a
       * key no broader than the advertiser whose attribution you control.
       */
      sessionKey?: (url: string) => string | undefined;
      /**
       * Whether the host's own click can lift an active stand-down. Off by
       * default: a stand-down then holds for its whole session, whatever the
       * shopper clicks next. `'same-network'` lifts it when a scoped
       * `selfPatterns` match shows the shopper's LATEST click on that network is
       * the host's own, which is when the network's own last-click rule has
       * already moved the credit. It never lifts: another network's stand-down,
       * a record any other network contributed to, a referral newer than the own
       * click, a navigation that also carries a competing param, or a
       * `disabled-host`. A later competitor referral stands down again.
       */
      selfClickLift?: 'off' | 'same-network';
    },
  ) {
    this.#store = store;
    this.#auditLog = opts?.auditLog ?? true;
    this.#maxAuditEntries = Math.max(0, opts?.maxAuditEntries ?? 1_000);
    this.#selfExemptionScope = opts?.selfExemptionScope ?? 'policy';
    this.#sessionExemptionTtlMs = opts?.sessionExemptionTtlMs ?? 1_800_000;
    this.#sessionKey = opts?.sessionKey;
    this.#selfClickLift = opts?.selfClickLift ?? 'off';
  }

  async ingest(
    signals: Signals,
    policies: readonly StanddownPolicy[],
  ): Promise<Decision> {
    const advertiserHost = hostFromUrl(signals.url);

    let resolvedKey: string | undefined;

    try {
      resolvedKey = this.#sessionKey?.(signals.url);
    } catch (error) {
      return this.#failClosedWithAudit(
        signals.now,
        'ingest',
        advertiserHost,
        `session-key-error: ${messageFromError(error)}`,
      );
    }

    // Normalize what the resolver returns: the write paths key state by
    // normalizeHost, so an un-normalized key would file state under one string
    // and read it back under another. An empty string is not a key.
    const stateKey = resolvedKey ? normalizeHost(resolvedKey) : advertiserHost;

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
      pruneExpiredState(state, signals.now);

      // Lift first, so a session-scope exemption for the own click is recorded
      // below (none is recorded while a stand-down is active). Only when nothing
      // else matched this navigation: a competing signal blocks the lift.
      const lifted =
        this.#selfClickLift === 'same-network' &&
        signals.selfClickAt !== undefined &&
        advertiserHost !== undefined &&
        stateKey !== undefined &&
        detection.strongest === undefined &&
        liftSelfClick(
          state,
          stateKey,
          advertiserHost,
          detection.selfExemptScopes ?? [],
          policies,
          Math.min(signals.selfClickAt, signals.now),
        );

      let effective = detection;

      if (this.#selfExemptionScope === 'session' && stateKey && advertiserHost) {
        recordSessionExemptions(
          state,
          stateKey,
          advertiserHost,
          detection,
          signals.now,
          this.#sessionExemptionTtlMs,
        );
        // The record is looked up by the bucket key, but the first argument is
        // the real detected host: applySessionExemptions compares it against
        // each match's advertiserHost, which detect() always sets to the actual
        // landing hostname. Both sides were the same host before this option
        // existed, so that comparison never filtered anything; handing it the
        // bucket key instead would make it differ for every match and silently
        // stop exemptions from suppressing anything whenever a resolver
        // collapses hosts.
        effective = applySessionExemptions(
          advertiserHost,
          detection,
          state.exemptions?.[stateKey],
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

        const evidence = effective.matched.filter(
          (match) => match.advertiserHost === effective.strongest?.advertiserHost,
        );
        const record = upsertSessionRecord(
          state,
          stateKey ?? effective.strongest.advertiserHost,
          effective.strongest.advertiserHost,
          effective.strongest.policyId,
          matchedPolicies,
          signals.now,
          effective.matched.some((match) => match.kind === 'disabled-host'),
          sharedOnlyPolicies(evidence),
        );

        return {
          decision: withMatchedParams(
            decisionFromRecord(record, signals.now, {
              reason: effective.strongest.reason,
              referrerClass: classifyReferrer(signals, record.advertiserHost),
            }),
            evidence,
          ),
          detection: effective,
        };
      }

      if (lifted && advertiserHost) {
        return {
          decision: {
            standDown: false,
            reason: 'self-click-lifted',
            behaviors: [],
            referrerClass: classifyReferrer(signals, advertiserHost),
            ...(signals.signalCoverage === 'partial' ? { degraded: true } : {}),
          } satisfies Decision,
          detection: effective,
        };
      }

      const activeDecision = stateKey
        ? activeDecisionForHost(state, stateKey, signals.now)
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

  /**
   * The state key `ingest` files this navigation under: the `sessionKey`
   * resolver's value, normalized, or the landing hostname when no resolver is
   * configured or it returns `undefined`/an empty string.
   *
   * Feed it to {@link StanddownSession.shouldStandDown}, which never runs the
   * resolver itself. `undefined` means no key could be resolved — an
   * unparseable URL, or a resolver that threw. `ingest` fails closed in both
   * cases, so treat it as "stand down", not as "nothing to look up".
   */
  resolveSessionKey(url: string): string | undefined {
    let resolvedKey: string | undefined;

    try {
      resolvedKey = this.#sessionKey?.(url);
    } catch {
      return undefined;
    }

    return resolvedKey ? normalizeHost(resolvedKey) : hostFromUrl(url);
  }

  async shouldStandDown(
    advertiserHost: string,
    now: number,
  ): Promise<Decision> {
    return this.#withState(
      now,
      (state) => {
        pruneExpiredState(state, now);

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

  /**
   * Lift the stand-down on `url`'s host for an own click seen at `clickAt` on
   * the given policies, when `selfClickLift` is on. For adapters that observe
   * the own click on one page and decide on a later one (`standdown/relay`).
   * Same rules as the in-`ingest` lift; only referrals strictly older than
   * `clickAt` are lifted. Resolves `true` when a stand-down was lifted.
   */
  async liftForSelfClick(
    input: { url: string; policyIds: readonly string[]; clickAt: number; now: number },
    policies: readonly StanddownPolicy[],
  ): Promise<boolean> {
    const host = hostFromUrl(input.url);

    if (this.#selfClickLift !== 'same-network' || host === undefined) {
      return false;
    }

    // Same bucket ingest files under (sessionKey); undefined if the resolver threw.
    const key = this.resolveSessionKey(input.url);

    const scopes = policies
      .filter((policy) => input.policyIds.includes(policy.id))
      .map((policy) => ({ policyId: policy.id, networkId: policy.network.id }));
    let lifted = false;

    await this.#withState(
      input.now,
      (state) => {
        pruneExpiredState(state, input.now);
        lifted = key !== undefined && liftSelfClick(state, key, host, scopes, policies, input.clickAt);

        return {
          decision: {
            standDown: !lifted,
            reason: lifted ? 'self-click-lifted' : 'self-click-not-lifted',
            behaviors: [],
          } satisfies Decision,
        };
      },
      // Audited as an ingest (a state change, reason says what happened): a new
      // action name would make older releases reject the whole saved state on a
      // rollback, and widen AuditEntry['action'] for hosts that switch on it.
      'ingest',
      key ?? normalizeHost(host),
    );

    return lifted;
  }

  async recordActivity(now: number): Promise<void> {
    await this.#withState(
      now,
      (state) => {
        pruneExpiredState(state, now);

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
  stateKey: string,
  advertiserHost: string,
  primaryPolicyId: string,
  policies: readonly StanddownPolicy[],
  now: number,
  viaDisabledHost = false,
  sharedNow: ReadonlySet<string> = new Set(),
): SessionRecord {
  const key = normalizeHost(stateKey);
  const existing = state.sessions[key];
  // A policy stays shared-only while every match that fed it was shared. A
  // record saved before this field existed counts its contributors as specific.
  const earlierShared = new Set(existing?.sharedOnlyPolicyIds ?? []);
  const earlierIds = new Set(existing ? (existing.policyIds ?? [UNKNOWN_CONTRIBUTORS]) : []);
  const sharedOnlyPolicyIds = [
    ...new Set([
      ...[...earlierShared].filter((id) => !policies.some((policy) => policy.id === id)),
      ...policies
        .map((policy) => policy.id)
        .filter((id) => sharedNow.has(id) && (!earlierIds.has(id) || earlierShared.has(id))),
    ]),
  ];
  const startedAt = existing?.startedAt ?? now;
  const lastActivityAt = now;
  const sessionRule =
    existing?.sessionRule === 'session-or-min' ||
    policies.some((policy) => policy.standdown.sessionRule === 'session-or-min')
      ? 'session-or-min'
      : 'inactivity-window';
  const baseRecord: SessionRecord = {
    advertiserHost: normalizeHost(advertiserHost),
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
    // A record from before this field existed has unknown contributors: mark
    // it so it can never be lifted, rather than guess from its primary policy.
    policyIds: [
      ...new Set([
        ...(existing ? (existing.policyIds ?? [UNKNOWN_CONTRIBUTORS]) : []),
        ...policies.map((policy) => policy.id),
      ]),
    ],
    lastReferralAt: now,
    ...(existing?.disabledHost || viaDisabledHost ? { disabledHost: true as const } : {}),
    ...(sharedOnlyPolicyIds.length > 0 ? { sharedOnlyPolicyIds } : {}),
    ...(existing?.sharedReferral ||
    (policies.length > 0 && policies.every((policy) => sharedNow.has(policy.id)))
      ? { sharedReferral: true as const }
      : {}),
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
 * Persist scoped self-exemptions seen on this navigation under its state key, so
 * later param-less navigations re-apply them. Monotone: never grant an exemption
 * while a stand-down is already active for that key (that would reduce existing
 * suppression, which a self-exemption may never do).
 *
 * Keyed by `stateKey` like {@link upsertSessionRecord}; `advertiserHost` is the
 * real detected hostname the record carries.
 */
function recordSessionExemptions(
  state: StanddownState,
  stateKey: string,
  advertiserHost: string,
  detection: Detection,
  now: number,
  ttlMs: number,
): void {
  const scopes = detection.selfExemptScopes;

  if (!scopes || scopes.length === 0) {
    return;
  }

  if (activeDecisionForHost(state, stateKey, now) !== undefined) {
    return;
  }

  const key = normalizeHost(stateKey);

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

  const grantedAt = existing?.grantedAt ?? now;
  const record: ExemptionRecord = {
    advertiserHost: normalizeHost(advertiserHost),
    policyIds: [...policyIds],
    networkIds: [...networkIds],
    grantedAt,
  };

  if (ttlMs > 0) {
    record.expiresAt = grantedAt + ttlMs;
  }

  exemptions[key] = record;
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

/** Policies whose every match here rests only on shared signals (`afsrc=1`). */
function sharedOnlyPolicies(matches: readonly MatchedRule[]): Set<string> {
  const shared = new Set<string>();
  const specific = new Set<string>();

  for (const match of matches) {
    (match.sharedOnly === true ? shared : specific).add(match.policyId);
  }

  return new Set([...shared].filter((id) => !specific.has(id)));
}

/** Adds the matched landing param names (never values) to a fresh stand-down. */
function withMatchedParams(decision: Decision, matches: readonly MatchedRule[]): Decision {
  if (!decision.standDown || matches.length === 0) {
    return decision;
  }

  const params = [...new Set(matches.flatMap((match) => match.params ?? []))];
  const sharedOnly = matches.every((match) => match.sharedOnly === true);

  return {
    ...decision,
    ...(params.length > 0 ? { matchedParams: params } : {}),
    ...(sharedOnly ? { sharedOnly: true as const } : {}),
  };
}

function unionBehaviors(behaviors: readonly SessionRecord['behaviors'][number][]) {
  return [...new Set(behaviors)];
}

/**
 * Marks a session record whose contributing policies are unknown (saved before
 * `policyIds` existed). Such a record is never lifted by `selfClickLift`.
 */
const UNKNOWN_CONTRIBUTORS = 'standdown:unknown-contributors';

/** The bundled catch-all policy's network (`afsrc=1` from any network). */
const UNIVERSAL_NETWORK_ID = 'universal';

/**
 * Delete the stand-down filed under `stateKey` (the real `host` decides
 * `disableHosts`) when an own click at `clickAt` covers every policy
 * that fed it (same policy, or same network) and the latest referral predates
 * the click. Returns whether it deleted one.
 */
function liftSelfClick(
  state: StanddownState,
  stateKey: string,
  host: string,
  scopes: readonly SelfExemptScope[],
  policies: readonly StanddownPolicy[],
  clickAt: number,
): boolean {
  const key = normalizeHost(stateKey);
  const record = state.sessions[key];

  if (
    !record ||
    scopes.length === 0 ||
    record.disabledHost === true ||
    record.sharedReferral === true ||
    record.policyIds === undefined ||
    record.policyIds.includes(UNKNOWN_CONTRIBUTORS)
  ) {
    return false;
  }

  // The own click must name exactly one network. A click that matches own-click
  // patterns for two networks (a marker shared across networks, or one scoped
  // to every policy reading the shared afsrc=1) can't say whose credit it
  // moved, so it only exempts. The catch-all `universal` network doesn't count.
  const ownNetworks = new Set(
    scopes.map((scope) => scope.networkId).filter((id) => id !== UNIVERSAL_NETWORK_ID),
  );

  if (ownNetworks.size !== 1) {
    return false;
  }

  // An unconditional disabled-host stand-down is never the shopper's to lift.
  const disabled = policies.some(
    (policy) =>
      record.policyIds?.includes(policy.id) &&
      (policy.detection.disableHosts ?? []).some((rule) =>
        domainRuleMatchesUrl(rule, normalizeHost(host)),
      ),
  );

  if (disabled) {
    return false;
  }

  const networkOf = new Map(policies.map((policy) => [policy.id, policy.network.id]));

  // Shared-only contributors (afsrc=1 that rode with a network's own param)
  // name no network, so they neither need covering nor can carry a lift: at
  // least one network-specific contributor must, and the own click must cover
  // all of those. A referral of shared signals alone set `sharedReferral` above.
  const sharedOnly = new Set(record.sharedOnlyPolicyIds ?? []);
  const specific = record.policyIds.filter((id) => !sharedOnly.has(id));

  if (specific.length === 0) {
    return false;
  }

  // A record the universal catch-all fed through a non-shared rule (a redirect
  // domain, network unknown) can't be attributed to the own click's network.
  if (specific.some((id) => networkOf.get(id) === UNIVERSAL_NETWORK_ID)) {
    return false;
  }
  const covered = specific.every((id) =>
    scopes.some((scope) => scope.policyId === id || scope.networkId === networkOf.get(id)),
  );
  const latestReferral = record.lastReferralAt ?? Math.max(record.startedAt, record.lastActivityAt);

  if (!covered || latestReferral >= clickAt) {
    return false;
  }

  delete state.sessions[key];
  return true;
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

function pruneExpiredState(state: StanddownState, now: number): void {
  for (const [host, record] of Object.entries(state.sessions)) {
    if (!isActive(record, now)) {
      delete state.sessions[host];
    }
  }

  if (state.exemptions) {
    for (const [host, record] of Object.entries(state.exemptions)) {
      if (record.expiresAt !== undefined && record.expiresAt <= now) {
        delete state.exemptions[host];
      }
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
          ...(record.policyIds ? { policyIds: [...record.policyIds] } : {}),
          ...(record.sharedOnlyPolicyIds
            ? { sharedOnlyPolicyIds: [...record.sharedOnlyPolicyIds] }
            : {}),
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
