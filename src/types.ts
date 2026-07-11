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
    maxPromptsPerJourney?: number;
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
  now: number;
}

export type MatchedRuleKind =
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

export interface Detection {
  matched: MatchedRule[];
  selfMatch: boolean;
  /**
   * Highest-priority match for state decisions.
   *
   * Ordering is deterministic: redirect-domain > landing-param > cookie >
   * initiator. Ties keep the policy array order, then the rule order inside
   * that policy.
   */
  strongest?: {
    policyId: string;
    advertiserHost: string;
    reason: string;
  };
  failClosedReason?: string;
}

export interface Decision {
  standDown: boolean;
  policyId?: string;
  reason: string;
  expiresAt?: number;
  behaviors: Behavior[];
  promptCount?: number;
  referrerClass?: ReferrerClass;
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

export interface StanddownState {
  sessions: Record<string, SessionRecord>;
  auditLog: AuditEntry[];
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
