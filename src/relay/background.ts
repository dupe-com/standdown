import { detect, domainRuleMatchesUrl } from '../detect';
import { StanddownSession } from '../session';
import {
  ChromeLocalStateStore,
  type ChromeRuntimeLike,
  type ChromeStorageAreaLike,
  chromeGet,
  chromeRemove,
  chromeSet,
} from '../stores';
import type {
  Behavior,
  Decision,
  DomainRule,
  SelfExemption,
  Signals,
  StanddownPolicy,
  StateStore,
} from '../types';
import { lintPolicies } from '../validation';
import {
  DEFAULT_RELAY_HOP_WINDOW_MS,
  DEFAULT_RELAY_MAX_AGE_MS,
  baseDomain as defaultBaseDomain,
  hostOf,
  isLandingRecord,
  type LandingMatch,
  type LandingRecord,
  RELAY_CAPTURE_MESSAGE,
  RELAY_SHOULD_STAND_DOWN_MESSAGE,
} from './shared';

export {
  DEFAULT_RELAY_HOP_WINDOW_MS,
  DEFAULT_RELAY_MAX_AGE_MS,
  type LandingMatch,
  type LandingRecord,
  RELAY_CAPTURE_MESSAGE,
  RELAY_SHOULD_STAND_DOWN_MESSAGE,
} from './shared';

const TAB_KEY_PREFIX = 'standdown:relay:tab:';
/** Value appended for an `exists` matcher when replaying a captured param. */
const RELAY_PLACEHOLDER = 'standdown-relay';
const FAIL_CLOSED_BEHAVIORS = [
  'suppress-prompts',
  'no-cookie-write',
  'no-redirect',
  'no-background-tracking',
] as const satisfies readonly Behavior[];

export interface CreateRelayStanddownOptions {
  readonly policies: readonly StanddownPolicy[];
  /** Decision state. Defaults to `ChromeLocalStateStore` over `chrome.storage.local`. */
  readonly store?: StateStore;
  readonly selfPatterns?: readonly SelfExemption[];
  readonly publisherSites?: readonly string[];
  /** Extra tracking hosts on top of each policy's `detection.trackingHosts`. */
  readonly trackingHosts?: readonly DomainRule[];
  /**
   * How long a landing record counts for its tab, from the landing. The record
   * also ends earlier when the tab moves to an unrelated site or closes.
   * Defaults to 30 minutes.
   */
  readonly maxAgeMs?: number;
  /**
   * How soon after the last page on the landing host a forward to another
   * same-base or tracking host must arrive to carry the record. Defaults to 10s.
   */
  readonly hopWindowMs?: number;
  /** Registrable-domain function. Defaults to a two/three-label heuristic. */
  readonly baseDomain?: (host: string) => string;
  /** Where per-tab landing records live. Defaults to `chrome.storage.session`. */
  readonly relayStorage?: ChromeStorageAreaLike;
  readonly chrome?: RelayChromeLike;
  readonly now?: () => number;
  readonly auditLog?: boolean;
  readonly selfExemptionScope?: 'policy' | 'session';
  readonly sessionExemptionTtlMs?: number;
  /**
   * Resolves the key a navigation's stand-down state is filed under, to share
   * one session across a merchant's hosts. See `StanddownSession`'s `sessionKey`.
   */
  readonly sessionKey?: (url: string) => string | undefined;
}

export interface RelayStanddownController {
  readonly session: StanddownSession;
  readonly store: StateStore;
  /** Record a capture for a tab (what the runtime message listener calls). */
  ingestCapture(tabId: number, record: LandingRecord, at?: number): Promise<void>;
  /** Decide for the page `url` currently loaded in `tabId`. */
  shouldStandDown(tabId: number, url: string, at?: number): Promise<Decision>;
  /** The tab's live landing record, if any (for diagnostics). */
  landingFor(tabId: number, at?: number): Promise<TabLanding | undefined>;
  forgetTab(tabId: number): Promise<void>;
  handleMessage(
    message: unknown,
    sender?: RelaySenderLike,
  ): Promise<RelayMessageResponse | undefined>;
  dispose(): void;
}

/** A landing record bound to one tab, as kept in `chrome.storage.session`. */
export interface TabLanding {
  readonly host: string;
  /** When the referral landing happened; bounds the record by `maxAgeMs`. */
  readonly at: number;
  /** Last capture seen on `host` in this tab; a hop must follow within `hopWindowMs`. */
  readonly lastAt: number;
  readonly matches: readonly LandingMatch[];
}

export interface RelayShouldStandDownMessage {
  readonly type: typeof RELAY_SHOULD_STAND_DOWN_MESSAGE;
  readonly url?: string;
  /** Only used when the sender is not a tab (e.g. a popup). */
  readonly tabId?: number;
}

export interface RelayMessageResponse {
  readonly ok: boolean;
  readonly decision?: Decision;
}

export interface RelaySenderLike {
  readonly tab?: { readonly id?: number; readonly url?: string };
  readonly frameId?: number;
  readonly url?: string;
}

type RelayMessageListener = (
  message: unknown,
  sender: RelaySenderLike,
  sendResponse: (response: RelayMessageResponse | undefined) => void,
) => boolean | undefined;

interface EventLike<T> {
  addListener(listener: T): void;
  removeListener?(listener: T): void;
}

/** The chrome surface the relay uses. No `tabs`, `webNavigation`, `webRequest` or `scripting` permission. */
export interface RelayChromeLike {
  readonly runtime?: ChromeRuntimeLike & {
    readonly onMessage?: EventLike<RelayMessageListener>;
  };
  readonly storage?: {
    readonly local?: ChromeStorageAreaLike;
    readonly session?: ChromeStorageAreaLike;
  };
  readonly tabs?: {
    /** Fires without the `tabs` permission. */
    readonly onRemoved?: EventLike<(tabId: number) => void>;
  };
}

/**
 * Background half of the relay. Receives `document_start` captures from
 * `standdown/relay/capture`, keeps a short per-tab landing record, and answers
 * stand-down queries through the regular session engine, so a referral param
 * the page stripped before `document_idle` still stands the host down.
 */
export function createRelayStanddown(
  opts: CreateRelayStanddownOptions,
): RelayStanddownController {
  for (const warning of lintPolicies(opts.policies)) {
    console.warn(warning);
  }

  const chromeApi =
    opts.chrome ?? (globalThis as typeof globalThis & { chrome?: RelayChromeLike }).chrome;
  const runtime = chromeApi?.runtime;
  const now = opts.now ?? Date.now;
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_RELAY_MAX_AGE_MS;
  const hopWindowMs = opts.hopWindowMs ?? DEFAULT_RELAY_HOP_WINDOW_MS;
  const toBase = opts.baseDomain ?? defaultBaseDomain;
  const relayStorage = opts.relayStorage ?? chromeApi?.storage?.session;
  const store = opts.store ?? defaultStore(chromeApi, now);
  const session = new StanddownSession(store, sessionOptions(opts));
  const policyById = new Map(opts.policies.map((policy) => [policy.id, policy]));
  let lock: Promise<unknown> = Promise.resolve();

  function serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = lock.then(task, task);
    lock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function load(tabId: number, at: number): Promise<TabLanding | undefined> {
    if (relayStorage === undefined) {
      return undefined;
    }

    const key = tabKey(tabId);
    const value = (await chromeGet(relayStorage, key, runtime))[key];

    if (!isTabLanding(value)) {
      return undefined;
    }

    if (at - value.at > maxAgeMs || at < value.at - maxAgeMs) {
      await chromeRemove(relayStorage, key, runtime);
      return undefined;
    }

    return value;
  }

  async function save(tabId: number, landing: TabLanding | undefined): Promise<void> {
    if (relayStorage === undefined) {
      return;
    }

    if (landing === undefined) {
      await chromeRemove(relayStorage, tabKey(tabId), runtime);
      return;
    }

    await chromeSet(relayStorage, { [tabKey(tabId)]: landing }, runtime);
  }

  function isTracking(match: LandingMatch, host: string): boolean {
    const rules = [
      ...(policyById.get(match.policyId)?.detection.trackingHosts ?? []),
      ...(opts.trackingHosts ?? []),
    ];
    return rules.some((rule) => domainRuleMatchesUrl(rule, host));
  }

  /** Matches from `landing` that carry over to `host` at time `at`. */
  function carried(landing: TabLanding, host: string, at: number): LandingMatch[] {
    if (landing.host === host) {
      return [...landing.matches];
    }

    if (at - landing.lastAt > hopWindowMs) {
      return [];
    }

    const sameBase = toBase(landing.host) === toBase(host);
    return landing.matches.filter((match) => sameBase || isTracking(match, landing.host));
  }

  async function ingestCapture(
    tabId: number,
    record: LandingRecord,
    at = now(),
  ): Promise<void> {
    if (!isLandingRecord(record)) {
      return;
    }

    const known = record.matches.filter((match) => policyById.has(match.policyId));

    await serialize(async () => {
      const existing = await load(tabId, at);
      // Never trust a capture's clock beyond the background's own.
      const landedAt = Math.min(record.at, at);
      const fresh: TabLanding | undefined =
        known.length > 0 ? { host: record.host, at: landedAt, lastAt: at, matches: known } : undefined;

      if (existing === undefined) {
        await save(tabId, fresh);
        return;
      }

      if (existing.host === record.host) {
        await save(tabId, {
          host: existing.host,
          at: fresh ? Math.max(existing.at, fresh.at) : existing.at,
          lastAt: at,
          matches: mergeMatches(existing.matches, known),
        });
        return;
      }

      const carry = carried(existing, record.host, at);

      if (carry.length > 0) {
        await save(tabId, {
          host: record.host,
          at: fresh ? Math.max(existing.at, fresh.at) : existing.at,
          lastAt: at,
          matches: mergeMatches(carry, known),
        });
        return;
      }

      if (fresh !== undefined) {
        await save(tabId, fresh);
        return;
      }

      // Same base domain but too late to count as a forward: keep the record for
      // its own host. Anything else is an unrelated navigation: drop it.
      if (toBase(existing.host) !== toBase(record.host)) {
        await save(tabId, undefined);
      }
    });
  }

  async function shouldStandDown(
    tabId: number,
    url: string,
    at = now(),
  ): Promise<Decision> {
    const host = hostOf(url);

    if (host === undefined) {
      return failClosedDecision('invalid-tab-url');
    }

    let relayed: LandingMatch[];

    try {
      const landing = await serialize(() => load(tabId, at));
      relayed = landing ? carried(landing, host, at) : [];
    } catch {
      return failClosedDecision('relay-store-error');
    }

    const signals: Signals = {
      url,
      now: at,
      signalCoverage: 'partial',
    };

    if (opts.selfPatterns !== undefined) {
      signals.selfPatterns = opts.selfPatterns;
    }

    if (opts.publisherSites !== undefined) {
      signals.publisherSites = opts.publisherSites;
    }

    const replayed: Signals = { ...signals, url: replayUrl(url, relayed, policyById) };
    const decision = await session.ingest(replayed, opts.policies);

    if (!decision.standDown || relayed.length === 0) {
      return decision;
    }

    try {
      const before = detect(signals, opts.policies);
      const after = detect(replayed, opts.policies);

      if (before.strongest === undefined && after.strongest !== undefined) {
        return { ...decision, matchKind: 'landing' };
      }
    } catch {
      // Detection already ran inside ingest; a failure here only loses the label.
    }

    return decision;
  }

  async function landingFor(tabId: number, at = now()): Promise<TabLanding | undefined> {
    return serialize(() => load(tabId, at));
  }

  async function forgetTab(tabId: number): Promise<void> {
    await serialize(() => save(tabId, undefined));
  }

  async function handleMessage(
    message: unknown,
    sender?: RelaySenderLike,
  ): Promise<RelayMessageResponse | undefined> {
    if (isCaptureMessage(message)) {
      const tabId = sender?.tab?.id;
      const senderHost = sender?.url === undefined ? undefined : hostOf(sender.url);

      if (
        typeof tabId !== 'number' ||
        tabId < 0 ||
        sender?.frameId !== 0 ||
        !isLandingRecord(message.record) ||
        (senderHost !== undefined && senderHost !== message.record.host)
      ) {
        return { ok: false };
      }

      await ingestCapture(tabId, message.record);
      return { ok: true };
    }

    if (isShouldStandDownMessage(message)) {
      const tabId = sender?.tab?.id ?? message.tabId;
      const url = message.url ?? sender?.url ?? sender?.tab?.url;

      if (typeof tabId !== 'number' || url === undefined) {
        return { ok: true, decision: failClosedDecision('missing-tab-context') };
      }

      return { ok: true, decision: await shouldStandDown(tabId, url) };
    }

    return undefined;
  }

  const onMessage: RelayMessageListener = (message, sender, sendResponse) => {
    if (!isCaptureMessage(message) && !isShouldStandDownMessage(message)) {
      return undefined;
    }

    void handleMessage(message, sender).then(sendResponse, () => {
      sendResponse({ ok: false, decision: failClosedDecision('message-handler-error') });
    });

    return true;
  };

  const onRemoved = (tabId: number) => {
    void forgetTab(tabId).catch(() => undefined);
  };

  runtime?.onMessage?.addListener(onMessage);
  chromeApi?.tabs?.onRemoved?.addListener(onRemoved);
  void sweep().catch(() => undefined);

  /** Drop records past `maxAgeMs` (e.g. tabs that closed while the worker slept). */
  async function sweep(): Promise<void> {
    if (relayStorage === undefined) {
      return;
    }

    const at = now();
    const items = await chromeGet(relayStorage, null, runtime);
    const stale = Object.entries(items)
      .filter(
        ([key, value]) =>
          key.startsWith(TAB_KEY_PREFIX) && (!isTabLanding(value) || at - value.at > maxAgeMs),
      )
      .map(([key]) => key);

    if (stale.length > 0) {
      await chromeRemove(relayStorage, stale, runtime);
    }
  }

  return {
    session,
    store,
    ingestCapture,
    shouldStandDown,
    landingFor,
    forgetTab,
    handleMessage,
    dispose() {
      runtime?.onMessage?.removeListener?.(onMessage);
      chromeApi?.tabs?.onRemoved?.removeListener?.(onRemoved);
    },
  };
}

/**
 * The current URL plus each relayed param, so the regular engine evaluates the
 * landing as if the param were still there. Values come from the policy itself
 * (`equals` / `contains` constants) or a placeholder for `exists`; the page's
 * real values were never captured.
 */
function replayUrl(
  url: string,
  relayed: readonly LandingMatch[],
  policyById: ReadonlyMap<string, StanddownPolicy>,
): string {
  if (relayed.length === 0) {
    return url;
  }

  const target = new URL(url);

  for (const match of relayed) {
    const names = new Set(match.params);

    for (const rule of policyById.get(match.policyId)?.detection.landingParams ?? []) {
      for (const group of rule.anyOf) {
        if (group.allOf.every((matcher) => names.has(matcher.name))) {
          for (const matcher of group.allOf) {
            target.searchParams.append(matcher.name, matcher.value ?? RELAY_PLACEHOLDER);
          }
        }
      }
    }
  }

  return target.href;
}

function mergeMatches(
  left: readonly LandingMatch[],
  right: readonly LandingMatch[],
): LandingMatch[] {
  const merged = new Map<string, Set<string>>();

  for (const match of [...left, ...right]) {
    const names = merged.get(match.policyId) ?? new Set<string>();
    for (const name of match.params) names.add(name);
    merged.set(match.policyId, names);
  }

  return [...merged].map(([policyId, names]) => ({ policyId, params: [...names] }));
}

function isTabLanding(value: unknown): value is TabLanding {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const landing = value as Record<string, unknown>;
  return (
    typeof landing.lastAt === 'number' &&
    isLandingRecord({ v: 1, host: landing.host, at: landing.at, matches: landing.matches })
  );
}

function isCaptureMessage(
  message: unknown,
): message is { type: typeof RELAY_CAPTURE_MESSAGE; record: unknown } {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { type?: unknown }).type === RELAY_CAPTURE_MESSAGE
  );
}

function isShouldStandDownMessage(message: unknown): message is RelayShouldStandDownMessage {
  if (typeof message !== 'object' || message === null) {
    return false;
  }

  const value = message as Record<string, unknown>;
  return (
    value.type === RELAY_SHOULD_STAND_DOWN_MESSAGE &&
    (value.url === undefined || typeof value.url === 'string') &&
    (value.tabId === undefined || typeof value.tabId === 'number')
  );
}

function tabKey(tabId: number): string {
  return `${TAB_KEY_PREFIX}${tabId}`;
}

function defaultStore(chromeApi: RelayChromeLike | undefined, now: () => number): StateStore {
  const local = chromeApi?.storage?.local;

  if (local === undefined) {
    return {
      load: () => Promise.reject(new Error('chrome.storage.local unavailable')),
      save: () => Promise.reject(new Error('chrome.storage.local unavailable')),
    };
  }

  const storeOptions: ConstructorParameters<typeof ChromeLocalStateStore>[1] = { now };

  if (chromeApi?.runtime !== undefined) {
    storeOptions.runtime = chromeApi.runtime;
  }

  if (chromeApi?.storage?.session !== undefined) {
    storeOptions.sessionStorage = chromeApi.storage.session;
  }

  return new ChromeLocalStateStore(local, storeOptions);
}

function sessionOptions(opts: CreateRelayStanddownOptions) {
  const sessionOpts: {
    auditLog?: boolean;
    selfExemptionScope?: 'policy' | 'session';
    sessionExemptionTtlMs?: number;
    sessionKey?: (url: string) => string | undefined;
  } = {};

  if (opts.auditLog !== undefined) {
    sessionOpts.auditLog = opts.auditLog;
  }

  if (opts.selfExemptionScope !== undefined) {
    sessionOpts.selfExemptionScope = opts.selfExemptionScope;
  }

  if (opts.sessionExemptionTtlMs !== undefined) {
    sessionOpts.sessionExemptionTtlMs = opts.sessionExemptionTtlMs;
  }

  if (opts.sessionKey !== undefined) {
    sessionOpts.sessionKey = opts.sessionKey;
  }

  return sessionOpts;
}

function failClosedDecision(reason: string): Decision {
  return { standDown: true, reason, behaviors: [...FAIL_CLOSED_BEHAVIORS] };
}
