/**
 * Shared, dependency-free pieces of the relay entry points. Kept tiny so the
 * `document_start` capture bundle stays small.
 */

export const RELAY_CAPTURE_MESSAGE = 'standdown:relay:capture';
export const RELAY_SHOULD_STAND_DOWN_MESSAGE = 'standdown:relay:shouldStandDown';
export const RELAY_SESSION_STORAGE_KEY = 'standdown:relay:landing:v1';

/** Default for how long a landing record counts (see `maxAgeMs`). */
export const DEFAULT_RELAY_MAX_AGE_MS = 30 * 60 * 1_000;
/** Default for how quickly a cross-host forward must land (see `hopWindowMs`). */
export const DEFAULT_RELAY_HOP_WINDOW_MS = 10_000;

const MAX_MATCHES = 32;
const MAX_PARAMS = 16;
const MAX_NAME_LENGTH = 64;
const MAX_HOST_LENGTH = 253;

/**
 * What a capture keeps about one landing: the host, when, and which policy's
 * landing params matched — by param *name* only. Never a URL, a path, or a
 * param value.
 */
export interface LandingRecord {
  readonly v: 1;
  readonly host: string;
  readonly at: number;
  readonly matches: readonly LandingMatch[];
  /**
   * Policies whose host-own click (`selfPatterns`) matched on this landing, by
   * policy id only. Lets the background apply `selfClickLift` after the page
   * strips the param. Absent when there was none.
   */
  readonly self?: readonly string[];
}

export interface LandingMatch {
  readonly policyId: string;
  readonly params: readonly string[];
}

export interface RelayCaptureMessage {
  readonly type: typeof RELAY_CAPTURE_MESSAGE;
  readonly record: LandingRecord;
  /**
   * Send time. Not used by the relay; it makes the message well-formed for
   * message routers that throw on (and answer) anything without a `type` and
   * numeric `timestamp`, such as `@webext-core/messaging`. A router that
   * answers first would win the reply.
   */
  readonly timestamp: number;
}

/** The query a content script or popup sends; see {@link shouldStandDownMessage}. */
export interface RelayShouldStandDownMessage {
  readonly type: typeof RELAY_SHOULD_STAND_DOWN_MESSAGE;
  readonly url?: string;
  /** Only used when the sender is not a tab (e.g. a popup). */
  readonly tabId?: number;
  /** See {@link RelayCaptureMessage.timestamp}. */
  readonly timestamp?: number;
}

/**
 * Build the `standdown:relay:shouldStandDown` query. Prefer this over a literal:
 * it adds the `timestamp` that keeps routers like `@webext-core/messaging` from
 * answering the message before the relay does.
 */
export function shouldStandDownMessage(
  url?: string,
  tabId?: number,
): RelayShouldStandDownMessage {
  return {
    type: RELAY_SHOULD_STAND_DOWN_MESSAGE,
    timestamp: Date.now(),
    ...(url === undefined ? {} : { url }),
    ...(tabId === undefined ? {} : { tabId }),
  };
}

/**
 * Registrable-domain heuristic without a public-suffix list: the last two
 * labels, or three when the second-to-last is a common second-level label under
 * a two-letter country TLD (`shop.co.uk`). Hosts that need exact PSL behavior
 * can pass their own `baseDomain` function.
 */
export function baseDomain(host: string): string {
  const labels = normalizeHost(host).split('.');

  if (labels.length <= 2) {
    return labels.join('.');
  }

  const tld = labels[labels.length - 1] ?? '';
  const second = labels[labels.length - 2] ?? '';
  const take =
    tld.length === 2 && /^(co|com|net|org|ac|gov|edu|ne|or|go)$/.test(second) ? 3 : 2;

  return labels.slice(-take).join('.');
}

export function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/\.$/, '');
}

export function hostOf(value: string): string | undefined {
  try {
    const host = new URL(value).hostname;
    return host.length > 0 ? normalizeHost(host) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Strict shape check for a record arriving from a content script or
 * sessionStorage (page scripts can write to it). Rejects anything that isn't
 * exactly the documented shape, including extra keys that could smuggle data.
 */
export function isLandingRecord(value: unknown): value is LandingRecord {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ['v', 'host', 'at', 'matches', 'self'])) {
    return false;
  }

  if (
    value.self !== undefined &&
    (!Array.isArray(value.self) ||
      value.self.length === 0 ||
      value.self.length > MAX_MATCHES ||
      !value.self.every(isShortString))
  ) {
    return false;
  }

  if (
    value.v !== 1 ||
    typeof value.host !== 'string' ||
    value.host.length === 0 ||
    value.host.length > MAX_HOST_LENGTH ||
    !/^[a-z0-9.-]+$/.test(value.host) ||
    typeof value.at !== 'number' ||
    !Number.isFinite(value.at) ||
    !Array.isArray(value.matches) ||
    value.matches.length > MAX_MATCHES
  ) {
    return false;
  }

  return value.matches.every(
    (match: unknown) =>
      isPlainObject(match) &&
      hasOnlyKeys(match, ['policyId', 'params']) &&
      isShortString(match.policyId) &&
      Array.isArray(match.params) &&
      match.params.length > 0 &&
      match.params.length <= MAX_PARAMS &&
      match.params.every(isShortString),
  );
}

function isShortString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_NAME_LENGTH;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
