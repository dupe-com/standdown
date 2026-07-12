import { verifyPolicyBundle } from './bundle';
import { StanddownSession } from './session';
import {
  ChromeLocalStateStore,
  type ChromeRuntimeLike,
  type ChromeStorageAreaLike,
} from './stores';
import type {
  AuditEntry,
  Behavior,
  Decision,
  SelfExemption,
  Signals,
  SignedPolicyBundle,
  StanddownPolicy,
  StanddownState,
  StateStore,
} from './types';

export {
  ChromeLocalStateStore,
  type ChromeRuntimeLike,
  type ChromeStorageAreaLike,
} from './stores';

const QUERY_MESSAGE_TYPE = 'standdown:shouldStandDown';
const FAIL_CLOSED_BEHAVIORS = [
  'suppress-prompts',
  'no-cookie-write',
  'no-redirect',
  'no-background-tracking',
] as const satisfies readonly Behavior[];
const DEFAULT_REFRESH_INTERVAL_MS = 60 * 60 * 1_000;
const MAX_ADAPTER_AUDIT_ENTRIES = 1_000;

export type StanddownWebextMode = 'webRequest' | 'webNavigation';

export interface StanddownRefreshConfig {
  readonly url: string;
  readonly publicKeyJwk: JsonWebKey;
  /** Set to 0 to disable the periodic timer while keeping refreshNow(). */
  readonly intervalMs?: number;
}

export interface CreateStanddownOptions {
  readonly policies: readonly StanddownPolicy[];
  readonly selfPatterns?: readonly SelfExemption[];
  readonly publisherSites?: readonly string[];
  readonly refresh?: StanddownRefreshConfig;
  readonly fetch?: FetchLike;
  readonly chrome?: ChromeLike;
  readonly store?: StateStore;
  readonly sessionId?: string;
  readonly now?: () => number;
  readonly auditLog?: boolean;
  /**
   * How long a `selfPatterns` match suppresses stand-down for its advertiser
   * host. `'policy'` (default) exempts only the navigation carrying the param;
   * `'session'` persists the exemption for the host across later param-less
   * navigations (Dupe's `ignore_param` semantics).
   */
  readonly selfExemptionScope?: 'policy' | 'session';
}

export interface StanddownWebextController {
  readonly mode: StanddownWebextMode;
  readonly session: StanddownSession;
  readonly store: StateStore;
  ingestNavigation(tabId: number, url: string): Promise<Decision>;
  shouldStandDown(tabId: number, now?: number): Promise<Decision>;
  shouldStandDownForUrl(url: string, now?: number): Promise<Decision>;
  refreshNow(): Promise<StanddownRefreshResult>;
  getPolicies(): readonly StanddownPolicy[];
  handleMessage(
    message: unknown,
    sender?: RuntimeMessageSenderLike,
  ): Promise<StanddownMessageResponse | undefined>;
  dispose(): void;
}

export interface StanddownShouldStandDownMessage {
  readonly type: typeof QUERY_MESSAGE_TYPE;
  readonly tabId?: number;
  readonly url?: string;
}

export interface StanddownMessageResponse {
  readonly ok: boolean;
  readonly decision: Decision;
}

export type StanddownRefreshResult =
  | { ok: true; applied: number }
  | { ok: false; violation: string };

export type FetchLike = (url: string) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface ChromeLike {
  readonly webRequest?: {
    readonly onBeforeRequest?: ChromeEventLike<WebRequestBeforeListener>;
  };
  readonly webNavigation?: {
    readonly onCommitted?: ChromeEventLike<WebNavigationCommittedListener>;
  };
  readonly runtime?: ChromeRuntimeLike & {
    readonly onMessage?: ChromeEventLike<RuntimeMessageListener>;
  };
  readonly storage?: {
    readonly local?: ChromeStorageAreaLike;
    readonly session?: ChromeStorageAreaLike;
  };
  readonly tabs?: {
    get?(
      tabId: number,
      callback?: (tab: TabLike | undefined) => void,
    ): undefined | Promise<TabLike | undefined>;
    readonly onRemoved?: ChromeEventLike<TabRemovedListener>;
  };
}

export interface ChromeEventLike<TListener> {
  addListener(listener: TListener, ...args: unknown[]): void;
  removeListener?(listener: TListener): void;
}

export interface WebRequestBeforeDetails {
  readonly tabId: number;
  readonly requestId?: string;
  readonly url: string;
  readonly type?: string;
  readonly frameId?: number;
  readonly initiator?: string;
  readonly originUrl?: string;
}

export interface WebNavigationCommittedDetails {
  readonly tabId: number;
  readonly url: string;
  readonly frameId?: number;
}

export interface RuntimeMessageSenderLike {
  readonly tab?: TabLike;
}

export interface TabLike {
  readonly id?: number;
  readonly url?: string;
  readonly pendingUrl?: string;
}

type WebRequestBeforeListener = (details: WebRequestBeforeDetails) => void;
type WebNavigationCommittedListener = (
  details: WebNavigationCommittedDetails,
) => void;
type TabRemovedListener = (tabId: number) => void;
type RuntimeMessageListener = (
  message: unknown,
  sender: RuntimeMessageSenderLike,
  sendResponse: (response: StanddownMessageResponse | undefined) => void,
) => boolean | undefined;

export function createStanddown(
  opts: CreateStanddownOptions,
): StanddownWebextController {
  const chromeApi = opts.chrome ?? currentChrome();
  const now = opts.now ?? Date.now;
  const fetchImpl = opts.fetch ?? currentFetch();
  let activePolicies = opts.policies.map((policy) => clonePolicy(policy));
  let refreshTimer: ReturnType<typeof setInterval> | undefined;

  const store =
    opts.store ??
    createChromeStore(chromeApi, {
      sessionId: opts.sessionId,
      now,
    });
  const session = new StanddownSession(store, sessionOptions(opts));
  const redirectChains = new Map<number, string[]>();
  const redirectRequestIds = new Map<number, string>();
  const initiators = new Map<number, string>();
  const tabHosts = new Map<number, string>();
  const hasWebRequest =
    typeof chromeApi?.webRequest?.onBeforeRequest?.addListener === 'function';
  const hasWebNavigation =
    typeof chromeApi?.webNavigation?.onCommitted?.addListener === 'function';

  if (!hasWebNavigation) {
    throw new TypeError(
      'standdown/webext requires chrome.webNavigation.onCommitted',
    );
  }

  const mode: StanddownWebextMode = hasWebRequest ? 'webRequest' : 'webNavigation';

  const onBeforeRequest: WebRequestBeforeListener = (details) => {
    if (!isTopLevelTabRequest(details.tabId, details.type, details.frameId)) {
      return;
    }

    const existingRequestId = redirectRequestIds.get(details.tabId);
    const startsNewRequest =
      details.requestId !== undefined &&
      existingRequestId !== undefined &&
      details.requestId !== existingRequestId;
    const chain = startsNewRequest
      ? []
      : redirectChains.get(details.tabId) ?? [];

    if (details.requestId !== undefined) {
      redirectRequestIds.set(details.tabId, details.requestId);
    }

    chain.push(details.url);
    redirectChains.set(details.tabId, chain.slice(-20));

    const initiator = details.initiator ?? details.originUrl;

    if (initiator !== undefined && !initiators.has(details.tabId)) {
      initiators.set(details.tabId, initiator);
    }
  };

  const onCommitted: WebNavigationCommittedListener = (details) => {
    if (details.tabId < 0 || (details.frameId ?? 0) !== 0) {
      return;
    }

    void ingestNavigation(details.tabId, details.url);
  };

  const onRemoved: TabRemovedListener = (tabId) => {
    redirectChains.delete(tabId);
    redirectRequestIds.delete(tabId);
    initiators.delete(tabId);
    tabHosts.delete(tabId);
  };

  const onMessage: RuntimeMessageListener = (message, sender, sendResponse) => {
    if (!isShouldStandDownMessage(message)) {
      return undefined;
    }

    void handleMessage(message, sender).then(sendResponse, () => {
      sendResponse({
        ok: false,
        decision: failClosedDecision('message-handler-error'),
      });
    });

    return true;
  };

  if (mode === 'webRequest') {
    chromeApi?.webRequest?.onBeforeRequest?.addListener(
      onBeforeRequest,
      { urls: ['<all_urls>'], types: ['main_frame'] },
    );
  }

  if (hasWebNavigation) {
    chromeApi?.webNavigation?.onCommitted?.addListener(onCommitted);
  }

  chromeApi?.runtime?.onMessage?.addListener(onMessage);
  chromeApi?.tabs?.onRemoved?.addListener(onRemoved);

  if (opts.refresh !== undefined) {
    if (opts.refresh.intervalMs !== 0) {
      refreshTimer = setInterval(
        () => {
          void refreshNow();
        },
        opts.refresh.intervalMs ?? DEFAULT_REFRESH_INTERVAL_MS,
      );
    }
  }

  async function ingestNavigation(
    tabId: number,
    url: string,
  ): Promise<Decision> {
    const host = hostFromUrl(url);

    if (host !== undefined) {
      tabHosts.set(tabId, host);
    }

    const redirectChain = mode === 'webRequest' ? redirectChains.get(tabId) : undefined;
    const initiator = initiators.get(tabId);

    redirectChains.delete(tabId);
    redirectRequestIds.delete(tabId);
    initiators.delete(tabId);

    const signals = navigationSignals({
      url,
      now: now(),
      redirectChain,
      initiator,
      selfPatterns: opts.selfPatterns,
      publisherSites: opts.publisherSites,
      // Without the webRequest plane we never observe redirect chains, so a
      // non-stand-down could be a false negative — mark the coverage partial.
      signalCoverage: mode === 'webRequest' ? 'full' : 'partial',
    });

    return session.ingest(signals, activePolicies);
  }

  async function shouldStandDown(
    tabId: number,
    at = now(),
  ): Promise<Decision> {
    const host = tabHosts.get(tabId) ?? (await hostForTab(chromeApi, tabId));

    if (host === undefined) {
      return failClosedDecision('missing-tab-url');
    }

    return session.shouldStandDown(host, at);
  }

  async function shouldStandDownForUrl(
    url: string,
    at = now(),
  ): Promise<Decision> {
    const host = hostFromUrl(url);

    if (host === undefined) {
      return failClosedDecision('invalid-tab-url');
    }

    return session.shouldStandDown(host, at);
  }

  async function handleMessage(
    message: unknown,
    sender?: RuntimeMessageSenderLike,
  ): Promise<StanddownMessageResponse | undefined> {
    if (!isShouldStandDownMessage(message)) {
      return undefined;
    }

    const senderUrl = sender?.tab?.url ?? sender?.tab?.pendingUrl;
    const decision =
      message.url !== undefined
        ? await shouldStandDownForUrl(message.url)
        : senderUrl !== undefined
          ? await shouldStandDownForUrl(senderUrl)
          : await shouldStandDown(message.tabId ?? sender?.tab?.id ?? -1);

    return { ok: true, decision };
  }

  async function refreshNow(): Promise<StanddownRefreshResult> {
    if (opts.refresh === undefined) {
      return { ok: false, violation: 'refresh-not-configured' };
    }

    if (fetchImpl === undefined) {
      const result = { ok: false, violation: 'refresh-fetch-unavailable' } as const;
      await auditRefresh(store, now(), result);
      return result;
    }

    try {
      const response = await fetchImpl(opts.refresh.url);

      if (!response.ok) {
        const result = {
          ok: false,
          violation: `refresh-fetch-failed:${response.status}`,
        } as const;
        await auditRefresh(store, now(), result);
        return result;
      }

      const bundle = (await response.json()) as SignedPolicyBundle;
      const verified = await verifyPolicyBundle(
        activePolicies,
        bundle,
        opts.refresh.publicKeyJwk,
      );

      if (!verified.ok) {
        const result = { ok: false, violation: verified.violation } as const;
        await auditRefresh(store, now(), result);
        return result;
      }

      activePolicies = verified.policies.map((policy) => clonePolicy(policy));
      const result = { ok: true, applied: activePolicies.length } as const;
      await auditRefresh(store, now(), result);
      return result;
    } catch (error) {
      const result = {
        ok: false,
        violation: `refresh-error:${messageFromError(error)}`,
      } as const;
      await auditRefresh(store, now(), result);
      return result;
    }
  }

  function getPolicies(): readonly StanddownPolicy[] {
    return activePolicies.map((policy) => clonePolicy(policy));
  }

  function dispose(): void {
    if (refreshTimer !== undefined) {
      clearInterval(refreshTimer);
    }

    chromeApi?.webRequest?.onBeforeRequest?.removeListener?.(onBeforeRequest);
    chromeApi?.webNavigation?.onCommitted?.removeListener?.(onCommitted);
    chromeApi?.runtime?.onMessage?.removeListener?.(onMessage);
    chromeApi?.tabs?.onRemoved?.removeListener?.(onRemoved);
    redirectChains.clear();
    redirectRequestIds.clear();
    initiators.clear();
    tabHosts.clear();
  }

  return {
    mode,
    session,
    store,
    ingestNavigation,
    shouldStandDown,
    shouldStandDownForUrl,
    refreshNow,
    getPolicies,
    handleMessage,
    dispose,
  };
}

function sessionOptions(
  opts: CreateStanddownOptions,
):
  | { auditLog?: boolean; selfExemptionScope?: 'policy' | 'session' }
  | undefined {
  const sessionOpts: {
    auditLog?: boolean;
    selfExemptionScope?: 'policy' | 'session';
  } = {};

  if (opts.auditLog !== undefined) {
    sessionOpts.auditLog = opts.auditLog;
  }

  if (opts.selfExemptionScope !== undefined) {
    sessionOpts.selfExemptionScope = opts.selfExemptionScope;
  }

  return Object.keys(sessionOpts).length > 0 ? sessionOpts : undefined;
}

function createChromeStore(
  chromeApi: ChromeLike | undefined,
  opts: { sessionId: string | undefined; now: () => number },
): StateStore {
  if (chromeApi?.storage?.local === undefined) {
    return new UnavailableStateStore();
  }

  const storeOptions: {
    runtime?: ChromeRuntimeLike;
    sessionStorage?: ChromeStorageAreaLike;
    sessionId?: string;
    now: () => number;
  } = { now: opts.now };

  if (chromeApi.runtime !== undefined) {
    storeOptions.runtime = chromeApi.runtime;
  }

  if (chromeApi.storage.session !== undefined) {
    storeOptions.sessionStorage = chromeApi.storage.session;
  }

  if (opts.sessionId !== undefined) {
    storeOptions.sessionId = opts.sessionId;
  }

  return new ChromeLocalStateStore(chromeApi.storage.local, storeOptions);
}

function navigationSignals(value: {
  url: string;
  now: number;
  redirectChain: readonly string[] | undefined;
  initiator: string | undefined;
  selfPatterns: readonly SelfExemption[] | undefined;
  publisherSites: readonly string[] | undefined;
  signalCoverage: Signals['signalCoverage'];
}): Signals {
  const signals: Signals = {
    url: value.url,
    now: value.now,
  };

  if (value.signalCoverage !== undefined) {
    signals.signalCoverage = value.signalCoverage;
  }

  if (value.redirectChain !== undefined && value.redirectChain.length > 0) {
    signals.redirectChain = [...value.redirectChain];
  }

  if (value.initiator !== undefined) {
    signals.initiator = value.initiator;
  }

  if (value.selfPatterns !== undefined) {
    signals.selfPatterns = value.selfPatterns;
  }

  if (value.publisherSites !== undefined) {
    signals.publisherSites = value.publisherSites;
  }

  return signals;
}

async function hostForTab(
  chromeApi: ChromeLike | undefined,
  tabId: number,
): Promise<string | undefined> {
  if (tabId < 0 || chromeApi?.tabs?.get === undefined) {
    return undefined;
  }

  return new Promise((resolve) => {
    try {
      const result = chromeApi.tabs?.get?.(tabId, (tab) => {
        resolve(hostFromUrl(tab?.url ?? tab?.pendingUrl));
      });

      if (isPromiseLike(result)) {
        result.then(
          (tab) => resolve(hostFromUrl(tab?.url ?? tab?.pendingUrl)),
          () => resolve(undefined),
        );
      }
    } catch {
      resolve(undefined);
    }
  });
}

function isTopLevelTabRequest(
  tabId: number,
  type: string | undefined,
  frameId: number | undefined,
): boolean {
  return tabId >= 0 && (type === undefined || type === 'main_frame') && (frameId ?? 0) === 0;
}

function isShouldStandDownMessage(
  message: unknown,
): message is StanddownShouldStandDownMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { type?: unknown }).type === QUERY_MESSAGE_TYPE
  );
}

function hostFromUrl(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  try {
    return new URL(value).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return undefined;
  }
}

function failClosedDecision(reason: string): Decision {
  return {
    standDown: true,
    reason,
    behaviors: [...FAIL_CLOSED_BEHAVIORS],
  };
}

function currentChrome(): ChromeLike | undefined {
  return (globalThis as typeof globalThis & { chrome?: ChromeLike }).chrome;
}

function currentFetch(): FetchLike | undefined {
  const fetchValue = (globalThis as typeof globalThis & { fetch?: FetchLike })
    .fetch;

  return typeof fetchValue === 'function' ? fetchValue : undefined;
}

async function auditRefresh(
  store: StateStore,
  time: number,
  result: StanddownRefreshResult,
): Promise<void> {
  const state = (await store.load()) ?? emptyState();
  const entry: AuditEntry = {
    time,
    action: 'refresh',
    decision: {
      standDown: false,
      reason: result.ok
        ? `refresh-applied:${result.applied}`
        : `refresh-rejected:${result.violation}`,
      behaviors: [],
    },
  };

  state.auditLog.push(entry);

  if (state.auditLog.length > MAX_ADAPTER_AUDIT_ENTRIES) {
    state.auditLog.splice(0, state.auditLog.length - MAX_ADAPTER_AUDIT_ENTRIES);
  }

  await store.save(state);
}

function emptyState(): StanddownState {
  return {
    sessions: {},
    auditLog: [],
  };
}

function clonePolicy(policy: StanddownPolicy): StanddownPolicy {
  return JSON.parse(JSON.stringify(policy)) as StanddownPolicy;
}

function isPromiseLike<T>(value: unknown): value is Promise<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class UnavailableStateStore implements StateStore {
  async load(): Promise<never> {
    throw new Error('chrome.storage.local unavailable');
  }

  async save(): Promise<never> {
    throw new Error('chrome.storage.local unavailable');
  }
}
