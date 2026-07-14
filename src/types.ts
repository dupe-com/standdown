export type Behavior =
  | 'suppress-prompts'
  | 'no-cookie-write'
  | 'no-redirect'
  | 'no-background-tracking';

export type ParamMatchMode = 'exists' | 'equals' | 'contains';

export interface ParamMatcher {
  name: string;
  value?: string;
  match?: ParamMatchMode;
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
