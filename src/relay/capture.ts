import {
  caseInsensitiveParams,
  domainRuleMatchesUrl,
  exactParams,
  paramMatcherMatches,
} from '../detect';
import type { DomainRule, SelfExemption, StanddownPolicy } from '../types';
import {
  baseDomain,
  DEFAULT_RELAY_MAX_AGE_MS,
  hostOf,
  isLandingRecord,
  type LandingMatch,
  type LandingRecord,
  RELAY_CAPTURE_MESSAGE,
  RELAY_SESSION_STORAGE_KEY,
  type RelayCaptureMessage,
} from './shared';

export {
  baseDomain,
  type LandingMatch,
  type LandingRecord,
  RELAY_CAPTURE_MESSAGE,
  RELAY_SESSION_STORAGE_KEY,
  type RelayCaptureMessage,
} from './shared';

export interface CaptureWindowLike {
  readonly location: { readonly href: string };
  readonly document: { readonly referrer?: string };
  readonly sessionStorage?: {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
  };
  readonly top?: unknown;
  readonly self?: unknown;
}

export interface CaptureLandingOptions {
  readonly policies: readonly StanddownPolicy[];
  /** The host's own attribution params. A scoped match exempts that policy. */
  readonly selfPatterns?: readonly SelfExemption[];
  /** Extra tracking hosts on top of each policy's `detection.trackingHosts`. */
  readonly trackingHosts?: readonly DomainRule[];
  /**
   * Must match the background's `selfClickLift`. When `'same-network'`, an own
   * click (a scoped `selfPatterns` match) is reported to the background as
   * `self` so it can lift that network's earlier stand-down. Off by default:
   * own clicks are then only exempted, exactly as before.
   */
  readonly selfClickLift?: 'off' | 'same-network';
  /** How long a stored record is re-sent after a same-tab reload. */
  readonly maxAgeMs?: number;
  /** Delay before the single retry when the background isn't listening yet. */
  readonly retryDelayMs?: number;
  readonly window?: CaptureWindowLike;
  readonly sendMessage?: (message: RelayCaptureMessage) => unknown;
  readonly now?: () => number;
}

export interface CaptureLandingResult {
  readonly record: LandingRecord;
  /** Resolves `true` once the background accepted the message. */
  readonly delivered: Promise<boolean>;
}

/**
 * Call from a content script declared at `document_start` in the top frame.
 * Reads the landing URL and referrer before page scripts can strip them, keeps
 * only matched param names + host + time, mirrors that to `sessionStorage`, and
 * relays it to `standdown/relay/background`. Returns `undefined` in sub-frames.
 */
export function captureLanding(opts: CaptureLandingOptions): CaptureLandingResult | undefined {
  const win = opts.window ?? (globalThis as { window?: CaptureWindowLike }).window;
  const now = opts.now ?? Date.now;

  if (win === undefined || (win.top !== undefined && win.top !== (win.self ?? win))) {
    return undefined;
  }

  const href = win.location.href;
  const host = hostOf(href);

  if (host === undefined) {
    return undefined;
  }

  const at = now();
  const found = matchLanding(opts, new URL(href), host, win.document.referrer);
  const matches = found.matches;
  const self = opts.selfClickLift === 'same-network' ? found.self : [];
  let record: LandingRecord =
    self.length > 0 ? { v: 1, host, at, matches, self } : { v: 1, host, at, matches };

  try {
    if (matches.length > 0 || self.length > 0) {
      win.sessionStorage?.setItem(RELAY_SESSION_STORAGE_KEY, JSON.stringify(record));
    } else {
      const stored = parseStored(win.sessionStorage?.getItem(RELAY_SESSION_STORAGE_KEY));
      const maxAgeMs = opts.maxAgeMs ?? DEFAULT_RELAY_MAX_AGE_MS;

      if (stored && stored.host === host && at - stored.at <= maxAgeMs) {
        record = stored;
      } else if (stored) {
        win.sessionStorage?.removeItem(RELAY_SESSION_STORAGE_KEY);
      }
    }
  } catch {
    // sessionStorage can be blocked; the background relay still works.
  }

  return { record, delivered: send(opts, { type: RELAY_CAPTURE_MESSAGE, record }) };
}

function matchLanding(
  opts: CaptureLandingOptions,
  url: URL,
  host: string,
  referrer: string | undefined,
): { matches: LandingMatch[]; self: string[] } {
  const referrerUrl = referrer ? safeUrl(referrer) : undefined;
  const referrerHost = referrerUrl?.hostname.toLowerCase();
  const matches: LandingMatch[] = [];
  const self: string[] = [];

  for (const policy of opts.policies) {
    const tracking = [...(policy.detection.trackingHosts ?? []), ...(opts.trackingHosts ?? [])];
    const isTracking = (h: string) => tracking.some((rule) => domainRuleMatchesUrl(rule, h));
    const hostEligible =
      isTracking(host) ||
      policy.detection.advertiserHosts === undefined ||
      policy.detection.advertiserHosts.some((rule) => domainRuleMatchesUrl(rule, host));
    const sources: URLSearchParams[] = hostEligible ? [url.searchParams] : [];

    if (
      referrerUrl &&
      referrerHost &&
      ((hostEligible && baseDomain(referrerHost) === baseDomain(host)) || isTracking(referrerHost))
    ) {
      sources.push(referrerUrl.searchParams);
    }

    // An own click in THIS page's URL exempts the network for this landing, as
    // detection does. One in the referrer only exempts the referrer's own
    // params: it must never hide a competitor's param in this page's URL.
    if (hostEligible && isSelfExempt(opts.selfPatterns, policy, url.searchParams)) {
      self.push(policy.id);
      continue;
    }

    const names = new Set<string>();

    for (const params of sources) {
      if (isSelfExempt(opts.selfPatterns, policy, params)) {
        continue;
      }

      // Names match in any casing (CJEVENT, CjEvent); values stay exact.
      const landing = caseInsensitiveParams(params);
      for (const rule of policy.detection.landingParams ?? []) {
        for (const group of rule.anyOf) {
          if (group.allOf.every((matcher) => paramMatcherMatches(matcher, landing))) {
            for (const matcher of group.allOf) names.add(matcher.name);
          }
        }
      }
    }

    if (names.size > 0) {
      matches.push({ policyId: policy.id, params: [...names] });
    }
  }

  return { matches, self };
}

function isSelfExempt(
  selfPatterns: readonly SelfExemption[] | undefined,
  policy: StanddownPolicy,
  params: URLSearchParams,
): boolean {
  return (selfPatterns ?? []).some(
    (pattern) =>
      (pattern.policyId === policy.id || pattern.networkId === policy.network.id) &&
      paramMatcherMatches(pattern, exactParams(params)),
  );
}

async function send(
  opts: CaptureLandingOptions,
  message: RelayCaptureMessage,
): Promise<boolean> {
  const sendMessage = opts.sendMessage ?? defaultSendMessage();

  if (sendMessage === undefined) {
    return false;
  }

  const attempt = async () => {
    await sendMessage(message);
    return true;
  };

  try {
    return await attempt();
  } catch {
    // The background may not be listening yet right after install or update.
    await new Promise<void>((resolve) => {
      globalThis.setTimeout(resolve, opts.retryDelayMs ?? 500);
    });
    return attempt().catch(() => false);
  }
}

function defaultSendMessage(): ((message: RelayCaptureMessage) => unknown) | undefined {
  const runtime = (
    globalThis as { chrome?: { runtime?: { sendMessage?: (message: unknown) => unknown } } }
  ).chrome?.runtime;

  return runtime?.sendMessage ? (message) => runtime.sendMessage?.(message) : undefined;
}

function parseStored(raw: string | null | undefined): LandingRecord | undefined {
  if (!raw) {
    return undefined;
  }

  try {
    const value: unknown = JSON.parse(raw);
    return isLandingRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function safeUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}
