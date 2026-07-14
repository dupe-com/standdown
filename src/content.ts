import { StanddownSession } from './session';
import {
  LocalStorageTtlStateStore,
  SessionStorageStateStore,
  type WebStorageLike,
} from './stores';
import type {
  Behavior,
  Decision,
  SelfExemption,
  Signals,
  StanddownPolicy,
  StateStore,
} from './types';
import { lintPolicies } from './validation';

export {
  LocalStorageTtlStateStore,
  SessionStorageStateStore,
  type WebStorageLike,
} from './stores';

const DEFAULT_LOCAL_STORAGE_TTL_MS = 24 * 60 * 60 * 1_000;
const FAIL_CLOSED_BEHAVIORS = [
  'suppress-prompts',
  'no-cookie-write',
  'no-redirect',
  'no-background-tracking',
] as const satisfies readonly Behavior[];

export type ContentStorageMode = 'session' | 'local-ttl';

export interface CreateContentStanddownOptions {
  readonly policies: readonly StanddownPolicy[];
  readonly selfPatterns?: readonly SelfExemption[];
  readonly publisherSites?: readonly string[];
  readonly store?: StateStore;
  readonly storage?: ContentStorageMode;
  /**
   * Sliding envelope TTL for `storage: 'local-ttl'`. Defaults to 24 hours.
   * Every save refreshes the envelope; expiry clears session records but keeps
   * audit entries. Per-policy stand-down durations are still enforced by core.
   */
  readonly ttlMs?: number;
  readonly window?: ContentWindowLike;
  readonly now?: () => number;
  readonly auditLog?: boolean;
  /**
   * How long a `selfPatterns` match suppresses stand-down for its advertiser
   * host. `'policy'` (default) exempts only the navigation carrying the param;
   * `'session'` persists the exemption for the host across later param-less
   * navigations (Dupe's `ignore_param` semantics).
   */
  readonly selfExemptionScope?: 'policy' | 'session';
  readonly onDecision?: (decision: Decision, signals: Signals) => void;
}

export interface ContentStanddownController {
  readonly session: StanddownSession;
  readonly store: StateStore;
  readonly ready: Promise<Decision>;
  evaluate(): Promise<Decision>;
  shouldStandDown(advertiserHost?: string, now?: number): Promise<Decision>;
  dispose(): void;
}

export interface CollectContentSignalsOptions {
  readonly window?: ContentWindowLike;
  readonly selfPatterns?: readonly SelfExemption[];
  readonly publisherSites?: readonly string[];
  readonly now?: () => number;
}

export interface ContentWindowLike {
  readonly location: { readonly href: string };
  readonly document: {
    readonly referrer?: string;
    readonly cookie: string;
  };
  readonly sessionStorage?: WebStorageLike | undefined;
  readonly localStorage?: WebStorageLike | undefined;
  readonly history?: ContentHistoryLike;
  readonly setTimeout?: (handler: () => void, timeout?: number) => unknown;
  addEventListener?(type: 'popstate', listener: () => void): void;
  removeEventListener?(type: 'popstate', listener: () => void): void;
}

export interface ContentHistoryLike {
  pushState(data: unknown, unused: string, url?: string | URL | null): void;
  replaceState(data: unknown, unused: string, url?: string | URL | null): void;
}

export function createContentStanddown(
  opts: CreateContentStanddownOptions,
): ContentStanddownController {
  // Surface config footguns (e.g. a bare-label `suffix` disableHost that matches
  // no real host) once, at wiring time — not buried in per-navigation console
  // noise. Advisory only; never throws. Malformed policies still fail closed at
  // ingest (see StanddownSession.ingest).
  for (const warning of lintPolicies(opts.policies)) {
    console.warn(warning);
  }

  const windowLike = opts.window ?? currentWindow();
  const now = opts.now ?? Date.now;
  const store = opts.store ?? createContentStore(windowLike, opts, now);
  const session = new StanddownSession(store, contentSessionOptions(opts));

  let disposed = false;
  let pending = false;
  const restoreHistory = patchHistory(windowLike, scheduleEvaluation);
  const onPopState = () => {
    scheduleEvaluation();
  };

  windowLike?.addEventListener?.('popstate', onPopState);

  async function evaluate(): Promise<Decision> {
    if (disposed) {
      return failClosedDecision('controller-disposed');
    }

    let signals: Signals;

    try {
      const signalOptions: {
        window?: ContentWindowLike;
        selfPatterns?: readonly SelfExemption[];
        publisherSites?: readonly string[];
        now: () => number;
      } = { now };

      if (windowLike !== undefined) {
        signalOptions.window = windowLike;
      }

      if (opts.selfPatterns !== undefined) {
        signalOptions.selfPatterns = opts.selfPatterns;
      }

      if (opts.publisherSites !== undefined) {
        signalOptions.publisherSites = opts.publisherSites;
      }

      signals = collectContentSignals(signalOptions);
    } catch {
      const decision = failClosedDecision('signal-collection-error');
      opts.onDecision?.(decision, {
        url: '',
        now: now(),
      });
      return decision;
    }

    const decision = await session.ingest(signals, opts.policies);
    opts.onDecision?.(decision, signals);
    return decision;
  }

  function scheduleEvaluation(): void {
    if (disposed || pending) {
      return;
    }

    pending = true;
    const run = () => {
      pending = false;

      if (!disposed) {
        void evaluate();
      }
    };

    if (windowLike?.setTimeout !== undefined) {
      windowLike.setTimeout(run, 0);
      return;
    }

    queueMicrotask(run);
  }

  async function shouldStandDown(
    advertiserHost?: string,
    at = now(),
  ): Promise<Decision> {
    const host =
      advertiserHost ??
      (windowLike === undefined ? undefined : hostFromUrl(windowLike.location.href));

    if (host === undefined) {
      return failClosedDecision('missing-advertiser-host');
    }

    return session.shouldStandDown(host, at);
  }

  function dispose(): void {
    disposed = true;
    restoreHistory();
    windowLike?.removeEventListener?.('popstate', onPopState);
  }

  const ready = evaluate();

  return {
    session,
    store,
    ready,
    evaluate,
    shouldStandDown,
    dispose,
  };
}

export function collectContentSignals(
  opts: CollectContentSignalsOptions = {},
): Signals {
  const windowLike = opts.window ?? currentWindow();
  const now = opts.now ?? Date.now;

  if (windowLike === undefined) {
    throw new Error('content window unavailable');
  }

  const signals: Signals = {
    url: windowLike.location.href,
    now: now(),
    // The content plane never observes redirect chains, so a non-stand-down
    // here can miss redirect-only attribution.
    signalCoverage: 'partial',
  };
  const referrer = windowLike.document.referrer;
  const cookieNames = cookieNamesFromString(windowLike.document.cookie);

  if (referrer !== undefined && referrer.length > 0) {
    signals.referrer = referrer;
  }

  if (cookieNames.length > 0) {
    signals.cookieNames = cookieNames;
  }

  if (opts.selfPatterns !== undefined) {
    signals.selfPatterns = opts.selfPatterns;
  }

  if (opts.publisherSites !== undefined) {
    signals.publisherSites = opts.publisherSites;
  }

  return signals;
}

export function cookieNamesFromString(cookie: string): string[] {
  if (cookie.trim().length === 0) {
    return [];
  }

  return cookie
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => part.split('=')[0]?.trim() ?? '')
    .filter((name) => name.length > 0);
}

function contentSessionOptions(
  opts: CreateContentStanddownOptions,
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

function createContentStore(
  windowLike: ContentWindowLike | undefined,
  opts: CreateContentStanddownOptions,
  now: () => number,
): StateStore {
  if (windowLike === undefined) {
    return new UnavailableStateStore('content window unavailable');
  }

  if (opts.storage === 'local-ttl') {
    if (windowLike.localStorage === undefined) {
      return new UnavailableStateStore('localStorage unavailable');
    }

    const storeOptions: {
      ttlMs: number;
      sessionStorage?: WebStorageLike;
      now: () => number;
    } = {
      ttlMs: opts.ttlMs ?? DEFAULT_LOCAL_STORAGE_TTL_MS,
      now,
    };

    if (windowLike.sessionStorage !== undefined) {
      storeOptions.sessionStorage = windowLike.sessionStorage;
    }

    return new LocalStorageTtlStateStore(windowLike.localStorage, storeOptions);
  }

  if (windowLike.sessionStorage === undefined) {
    return new UnavailableStateStore('sessionStorage unavailable');
  }

  return new SessionStorageStateStore(windowLike.sessionStorage);
}

function patchHistory(
  windowLike: ContentWindowLike | undefined,
  onNavigation: () => void,
): () => void {
  const history = windowLike?.history;

  if (history === undefined) {
    return () => {};
  }

  const originalPushState = history.pushState.bind(history);
  const originalReplaceState = history.replaceState.bind(history);

  history.pushState = (...args) => {
    originalPushState(...args);
    onNavigation();
  };

  history.replaceState = (...args) => {
    originalReplaceState(...args);
    onNavigation();
  };

  return () => {
    history.pushState = originalPushState;
    history.replaceState = originalReplaceState;
  };
}

function currentWindow(): ContentWindowLike | undefined {
  const value = (globalThis as typeof globalThis & {
    window?: ContentWindowLike;
  }).window;

  return value;
}

function hostFromUrl(value: string): string | undefined {
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

class UnavailableStateStore implements StateStore {
  readonly #reason: string;

  constructor(reason: string) {
    this.#reason = reason;
  }

  async load(): Promise<never> {
    throw new Error(this.#reason);
  }

  async save(): Promise<never> {
    throw new Error(this.#reason);
  }
}
