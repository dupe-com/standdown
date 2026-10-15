export type Behavior =
  | 'suppress-prompts'
  | 'no-cookie-write'
  | 'no-redirect'
  | 'no-background-tracking';

/**
 * How a param's value is compared. `'pattern'`: `value` is a JavaScript
 * regular-expression SOURCE (no flags), anchored with `^` and `$`, at most 256
 * characters; it matches when any of the param's values satisfies it. Avoid
 * nested quantifiers like `(a+)+` (catastrophic backtracking).
 */
export type ParamMatchMode = 'exists' | 'equals' | 'contains' | 'pattern';

export interface ParamMatcher {
  name: string;
  value?: string;
  match?: ParamMatchMode;
  /**
   * `'pattern'` only: a sample value the pattern matches. Validation checks it;
   * graders and docs use it to build a matching landing. Never a real ID.
   */
  example?: string;
  /**
   * Marks a signal several networks append, like `afsrc=1`, so it does not say
   * which network referred the shopper. It still stands down on its own. Two
   * things change when a param group is made only of shared matchers: when the
   * same URL carries the host's own scoped click (`selfPatterns`), the group is
   * explained by that click and does not match; and `selfClickLift` never
   * counts it as a network's own evidence. Ignored in `selfPatterns`.
   */
  shared?: boolean;
}

export interface ParamGroup {
  allOf: readonly ParamMatcher[];
}

export interface ParamRule {
  anyOf: readonly ParamGroup[];
  reason?: string;
}

export interface CookieRule {
  name: string;
  match: 'exact' | 'substring';
  reason?: string;
}

export interface DomainRule {
  pattern: string;
  kind: 'suffix' | 'regex';
  comment?: string;
  /**
   * `redirectDomains` only: the rule matches a shared signal (a URL carrying
   * `afsrc=1`), not one network's domain. Treated like a shared
   * {@link ParamMatcher}: explained by the host's own scoped click in the
   * landing URL, and never counted as a network's own evidence.
   */
  shared?: boolean;
}

export type ReferrerClass =
  | 'own-site'
  | 'organic'
  | 'direct'
  | 'advertiser-internal'
  | 'other';

export interface InitiatorRule {
  referrerClass: ReferrerClass;
  reason?: string;
}

export interface StanddownPolicy {
  id: string;
  schemaVersion: 3;
  policyVersion: string;
  network: {
    id: string;
    name: string;
    policyUrl?: string;
  };
  detection: {
    advertiserHosts?: readonly DomainRule[];
    landingParams?: readonly ParamRule[];
    redirectDomains?: readonly DomainRule[];
    cookiePatterns?: readonly CookieRule[];
    initiatorRules?: readonly InitiatorRule[];
    /**
     * Hosts on which this network is treated as unconditionally attributed:
     * any navigation whose advertiser host matches stands down regardless of
     * params, cookies, or self-exemption. This is the "we do not operate here
     * at all" primitive (the extension's `disable_domains`), for merchants
     * where competing activation is never acceptable.
     */
    disableHosts?: readonly DomainRule[];
    /**
     * Hosts that forward to the advertiser by script after the page loads
     * (an interstitial click or link host). Used only by `standdown/relay`: a
     * landing param seen on one of these hosts carries over to the next host
     * the same tab lands on within the relay's hop window. Hosts sharing the
     * advertiser's base domain always carry over and need no entry here.
     * Server-side redirect hops load no page and are not covered.
     */
    trackingHosts?: readonly DomainRule[];
  };
  standdown: {
    scope: 'advertiser';
    sessionRule: 'session-or-min' | 'inactivity-window';
    minDurationMs: number;
    inactivityMs?: number;
    behaviors: readonly Behavior[];
  };
  activation: {
    mode: 'user-click' | 'never';
    allowedReferrerClasses?: readonly ('own-site' | 'organic' | 'direct')[];
  };
  metadata: {
    sourceUrl: string;
    lastVerified: string;
    notes?: string;
  };
}

export interface SelfExemption extends ParamMatcher {
  /**
   * Self-exemptions only suppress a policy when scoped to that policy or network.
   * Unscoped matches are reported as selfMatch but do not clear third-party matches.
   */
  policyId?: string;
  networkId?: string;
}

export interface Signals {
  url: string;
  referrer?: string;
  cookieNames?: readonly string[];
  redirectChain?: readonly string[];
  initiator?: string;
  selfPatterns?: readonly SelfExemption[];
  publisherSites?: readonly string[];
  /**
   * How complete the collected signal set is. `'partial'` means the collector
   * could not observe the full set (e.g. no redirect-chain / `webRequest`
   * plane, as in the content adapter or a webNavigation-only webext adapter),
   * so a *non*-stand-down decision may be a false negative. Defaults to `'full'`
   * when omitted. Never carries user data.
   */
  signalCoverage?: 'full' | 'partial';
  /**
   * When the host's own click carried in `url` actually landed. Only
   * `selfClickLift` reads it, and it lifts only when this is set: a reload,
   * back/forward or later re-check of a URL that still carries the own param is
   * not a new click, so collectors leave it unset there. Clamped to `now`.
   */
  selfClickAt?: number;
  now: number;
}

export type MatchedRuleKind =
  | 'disabled-host'
  | 'landing-param'
  | 'redirect-domain'
  | 'cookie'
  | 'initiator';

export interface MatchedRule {
  policyId: string;
  networkId: string;
  networkName: string;
  kind: MatchedRuleKind;
  rule: string;
  advertiserHost: string;
  reason: string;
  sourceUrl: string;
  /** `landing-param` only: the matched param names, as the policy spells them. */
  params?: string[];
  /**
   * The match rests only on shared signals (`afsrc=1`): every matched group is
   * made of shared matchers, or the redirect rule is a shared one.
   */
  sharedOnly?: true;
}

export interface SelfExemptScope {
  policyId: string;
  networkId: string;
}

export interface Detection {
  matched: MatchedRule[];
  selfMatch: boolean;
  /**
   * Highest-priority match for state decisions.
   *
   * Ordering is deterministic: disabled-host > redirect-domain > landing-param >
   * cookie > initiator. Ties keep the policy array order, then the rule order
   * inside that policy.
   */
  strongest?: {
    policyId: string;
    advertiserHost: string;
    reason: string;
  };
  /**
   * Policy/network scopes for which a scoped self-exemption matched this
   * navigation. Used by `selfExemptionScope: 'session'` to persist the
   * exemption for the advertiser host across later param-less navigations.
   */
  selfExemptScopes?: readonly SelfExemptScope[];
  failClosedReason?: string;
}

export interface Decision {
  standDown: boolean;
  policyId?: string;
  reason: string;
  expiresAt?: number;
  behaviors: Behavior[];
  referrerClass?: ReferrerClass;
  /**
   * Set when this is a `standDown: false` decision reached from a partial signal
   * set (`Signals.signalCoverage === 'partial'`): the "no stand-down" may be a
   * false negative because the collector couldn't see everything. Integrators
   * that want to fail fully closed can treat a degraded non-stand-down as a
   * stand-down. Not set on stand-down decisions (over-suppression is safe).
   */
  degraded?: boolean;
  /**
   * Set only by `standdown/relay` on a stand-down triggered by a landing param
   * the relay captured at `document_start` that is no longer in the current
   * URL (stripped by the page, or left behind on a same-site / tracking host
   * that forwarded here). Absent when the param is still in the URL.
   */
  matchKind?: 'landing';
  /**
   * On a stand-down this navigation's own params triggered: the landing param
   * names that matched, as the policy spells them (never values). Absent when
   * no landing param matched, or the decision comes from an earlier referral.
   */
  matchedParams?: string[];
  /**
   * Set with `matchedParams` when every signal behind the stand-down is a
   * shared one (`afsrc=1`), so `policyId` names a network that may not be the
   * one that referred the shopper.
   */
  sharedOnly?: true;
}

export interface UserGesture {
  isTrusted: boolean;
  type: string;
  timeStamp: number;
}

export interface ActivationBenefit {
  kind: 'coupon-applied' | 'cashback' | 'donation';
  description: string;
}

export interface AuditEntry {
  time: number;
  action: 'ingest' | 'shouldStandDown' | 'recordActivity' | 'refresh';
  advertiserHost?: string;
  detection?: Detection;
  decision?: Decision;
}

export interface SessionRecord {
  advertiserHost: string;
  policyId: string;
  startedAt: number;
  lastActivityAt: number;
  expiresAt?: number;
  sessionRule: StanddownPolicy['standdown']['sessionRule'];
  minDurationMs: number;
  inactivityMs?: number;
  behaviors: Behavior[];
  /**
   * Every policy whose detection fed this record. `selfClickLift` lifts a
   * record only when all of them are covered by the own click; a record
   * without this field (written before it existed) is never lifted.
   */
  policyIds?: string[];
  /** When a referral last matched this record; `recordActivity` never moves it. */
  lastReferralAt?: number;
  /** Set once a `disableHosts` match fed this record; such a record is never lifted. */
  disabledHost?: true;
  /**
   * The subset of `policyIds` that only ever matched through shared signals
   * (`afsrc=1`). `selfClickLift` doesn't need the own click to cover these, but
   * never lifts a record whose contributors are all shared-only.
   */
  sharedOnlyPolicyIds?: string[];
}

/**
 * A session-scoped self-exemption grant for one advertiser host: the integrator's
 * own attribution (via `selfPatterns`) was seen for these policies/networks, so
 * later navigations to the host re-apply the exemption for those same scopes.
 * Bounded by `sessionExemptionTtlMs`, measured from `grantedAt`: once `expiresAt`
 * passes the record is pruned and a later self-navigation starts a fresh window.
 * With the TTL disabled the record is held for the lifetime of the session state.
 * Never lifts an already-active stand-down and never covers a `disabled-host`
 * match.
 */
export interface ExemptionRecord {
  advertiserHost: string;
  policyIds: string[];
  networkIds: string[];
  grantedAt: number;
  /** Absolute time the exemption lapses. Omitted when the TTL is disabled. */
  expiresAt?: number;
}

export interface StanddownState {
  sessions: Record<string, SessionRecord>;
  auditLog: AuditEntry[];
  exemptions?: Record<string, ExemptionRecord>;
}

export interface StateStore {
  load(): Promise<StanddownState | undefined>;
  save(state: StanddownState): Promise<void>;
}

export type SignedBundleSignatureAlgorithm = 'Ed25519' | 'ECDSA-P256';

export interface SignedPolicyBundle {
  schemaVersion: 1;
  policies: readonly StanddownPolicy[];
  signature: {
    algorithm: SignedBundleSignatureAlgorithm;
    value: string;
  };
}

export type PolicyBundleVerificationResult =
  | { ok: true; policies: StanddownPolicy[] }
  | { ok: false; violation: string };

export interface RakutenNetworkPolicyV2 {
  id: string;
  schemaVersion: 2;
  policyVersion: string;
  network: {
    id: string;
    name: string;
    description?: string;
    sessionDuration?: number;
  };
  rules: readonly RakutenPolicyRuleV2[];
}

export interface RakutenPolicyRuleV2 {
  domain?: string;
  paths?: readonly string[];
  params?: readonly string[] | Readonly<Record<string, string>>;
  pattern?: string;
  reason?: string;
}
