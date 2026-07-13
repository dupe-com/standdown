import { MemoryStateStore, StanddownSession } from './session';
import type {
  Behavior,
  Decision,
  SelfExemption,
  Signals,
  StanddownPolicy,
  StateStore,
} from './types';

export { MemoryStateStore } from './session';

const FAIL_CLOSED_BEHAVIORS = [
  'suppress-prompts',
  'no-cookie-write',
  'no-redirect',
  'no-background-tracking',
] as const satisfies readonly Behavior[];

export interface CreateUrlStanddownOptions {
  readonly policies: readonly StanddownPolicy[];
  readonly selfPatterns?: readonly SelfExemption[];
  readonly publisherSites?: readonly string[];
  /**
   * Where stand-down state persists across calls. Defaults to an in-memory
   * store — appropriate for background workers / side panels that decide from a
   * URL and don't share a page's storage. Pass a durable {@link StateStore} to
   * carry stand-downs across worker restarts.
   */
  readonly store?: StateStore;
  readonly now?: () => number;
  readonly auditLog?: boolean;
  /**
   * How long a `selfPatterns` match suppresses stand-down for its advertiser
   * host. `'policy'` (default) exempts only the navigation carrying the param;
   * `'session'` persists the exemption for the host across later param-less
   * decisions (Dupe's `ignore_param` semantics).
   */
  readonly selfExemptionScope?: 'policy' | 'session';
  readonly onDecision?: (decision: Decision, signals: Signals) => void;
}

/**
 * Optional signals a caller already knows about a URL. Both feed referrer
 * classification (`classifyReferrer`); neither is required.
 */
export interface UrlDecisionContext {
  readonly referrer?: string;
  readonly initiator?: string;
}

export interface UrlStanddownController {
  readonly session: StanddownSession;
  readonly store: StateStore;
  /**
   * Decide whether to stand down for a URL alone. Collects signals from the URL
   * (+ optional referrer/initiator) only — no `document`, no cookies, no
   * redirect chain — so a non-stand-down decision carries `degraded: true`.
   * Fails toward standing down on a missing/malformed URL or any collection
   * error.
   */
  decideForUrl(url: string, ctx?: UrlDecisionContext): Promise<Decision>;
}

export interface CollectUrlSignalsOptions {
  readonly referrer?: string;
  readonly initiator?: string;
  readonly selfPatterns?: readonly SelfExemption[];
  readonly publisherSites?: readonly string[];
  readonly now?: () => number;
}

export function createUrlStanddown(
  opts: CreateUrlStanddownOptions,
): UrlStanddownController {
  const now = opts.now ?? Date.now;
  const store = opts.store ?? new MemoryStateStore();
  const session = new StanddownSession(store, urlSessionOptions(opts));

  async function decideForUrl(
    url: string,
    ctx: UrlDecisionContext = {},
  ): Promise<Decision> {
    let signals: Signals;

    try {
      const signalOptions: {
        referrer?: string;
        initiator?: string;
        selfPatterns?: readonly SelfExemption[];
        publisherSites?: readonly string[];
        now: () => number;
      } = { now };

      if (ctx.referrer !== undefined) {
        signalOptions.referrer = ctx.referrer;
      }

      if (ctx.initiator !== undefined) {
        signalOptions.initiator = ctx.initiator;
      }

      if (opts.selfPatterns !== undefined) {
        signalOptions.selfPatterns = opts.selfPatterns;
      }

      if (opts.publisherSites !== undefined) {
        signalOptions.publisherSites = opts.publisherSites;
      }

      signals = collectUrlSignals(url, signalOptions);
    } catch {
      const decision = failClosedDecision('signal-collection-error');
      opts.onDecision?.(decision, {
        url: typeof url === 'string' ? url : '',
        now: now(),
      });
      return decision;
    }

    const decision = await session.ingest(signals, opts.policies);
    opts.onDecision?.(decision, signals);
    return decision;
  }

  return {
    session,
    store,
    decideForUrl,
  };
}

export function collectUrlSignals(
  url: string,
  opts: CollectUrlSignalsOptions = {},
): Signals {
  const now = opts.now ?? Date.now;

  if (typeof url !== 'string' || url.length === 0) {
    throw new Error('url required');
  }

  const signals: Signals = {
    url,
    now: now(),
    // A bare URL carries no redirect-chain or cookie plane, so a non-stand-down
    // here can miss redirect-only or cookie-only attribution.
    signalCoverage: 'partial',
  };

  if (opts.referrer !== undefined && opts.referrer.length > 0) {
    signals.referrer = opts.referrer;
  }

  if (opts.initiator !== undefined && opts.initiator.length > 0) {
    signals.initiator = opts.initiator;
  }

  if (opts.selfPatterns !== undefined) {
    signals.selfPatterns = opts.selfPatterns;
  }

  if (opts.publisherSites !== undefined) {
    signals.publisherSites = opts.publisherSites;
  }

  return signals;
}

function urlSessionOptions(
  opts: CreateUrlStanddownOptions,
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

function failClosedDecision(reason: string): Decision {
  return {
    standDown: true,
    reason,
    behaviors: [...FAIL_CLOSED_BEHAVIORS],
  };
}
