import type {
  Behavior,
  CookieRule,
  DomainRule,
  InitiatorRule,
  StanddownPolicy,
} from './types';

const BEHAVIORS = new Set<Behavior>([
  'suppress-prompts',
  'no-cookie-write',
  'no-redirect',
  'no-background-tracking',
]);

const PARAM_MATCHES = new Set(['exists', 'equals', 'contains']);
const COOKIE_MATCHES = new Set(['exact', 'substring']);
const DOMAIN_KINDS = new Set(['suffix', 'regex']);
const REFERRER_CLASSES = new Set([
  'own-site',
  'organic',
  'direct',
  'advertiser-internal',
  'other',
]);
const ACTIVATION_REFERRER_CLASSES = new Set(['own-site', 'organic', 'direct']);

export function validatePolicy(value: unknown): asserts value is StanddownPolicy {
  const policy = object(value, 'policy');

  string(policy.id, 'policy.id');
  literal(policy.schemaVersion, 3, 'policy.schemaVersion');
  string(policy.policyVersion, 'policy.policyVersion');

  const network = object(policy.network, 'policy.network');
  string(network.id, 'policy.network.id');
  string(network.name, 'policy.network.name');

  if (network.policyUrl !== undefined) {
    urlString(network.policyUrl, 'policy.network.policyUrl');
  }

  const detection = object(policy.detection, 'policy.detection');
  optionalArray(detection.advertiserHosts, 'policy.detection.advertiserHosts').forEach(
    validateDomainRule,
  );
  optionalArray(detection.landingParams, 'policy.detection.landingParams').forEach(
    validateParamRule,
  );
  optionalArray(detection.redirectDomains, 'policy.detection.redirectDomains').forEach(
    validateDomainRule,
  );
  optionalArray(detection.cookiePatterns, 'policy.detection.cookiePatterns').forEach(
    validateCookieRule,
  );
  optionalArray(detection.initiatorRules, 'policy.detection.initiatorRules').forEach(
    validateInitiatorRule,
  );
  optionalArray(detection.disableHosts, 'policy.detection.disableHosts').forEach(
    validateDomainRule,
  );

  const standdown = object(policy.standdown, 'policy.standdown');
  literal(standdown.scope, 'advertiser', 'policy.standdown.scope');

  if (
    standdown.sessionRule !== 'session-or-min' &&
    standdown.sessionRule !== 'inactivity-window'
  ) {
    throw new TypeError('policy.standdown.sessionRule is invalid');
  }

  nonNegativeFiniteNumber(
    standdown.minDurationMs,
    'policy.standdown.minDurationMs',
  );

  if (standdown.inactivityMs !== undefined) {
    nonNegativeFiniteNumber(
      standdown.inactivityMs,
      'policy.standdown.inactivityMs',
    );
  }

  const behaviors = array(standdown.behaviors, 'policy.standdown.behaviors');
  for (const behavior of behaviors) {
    if (!BEHAVIORS.has(behavior as Behavior)) {
      throw new TypeError(`policy.standdown.behaviors contains invalid behavior`);
    }
  }

  const activation = object(policy.activation, 'policy.activation');

  if (activation.mode !== 'user-click' && activation.mode !== 'never') {
    throw new TypeError('policy.activation.mode is invalid');
  }

  for (const referrerClass of optionalArray(
    activation.allowedReferrerClasses,
    'policy.activation.allowedReferrerClasses',
  )) {
    if (!ACTIVATION_REFERRER_CLASSES.has(referrerClass as string)) {
      throw new TypeError(
        'policy.activation.allowedReferrerClasses contains invalid class',
      );
    }
  }

  const metadata = object(policy.metadata, 'policy.metadata');
  urlString(metadata.sourceUrl, 'policy.metadata.sourceUrl');
  dateString(metadata.lastVerified, 'policy.metadata.lastVerified');

  if (metadata.notes !== undefined) {
    string(metadata.notes, 'policy.metadata.notes');
  }
}

export function validatePolicies(
  values: readonly unknown[],
): asserts values is readonly StanddownPolicy[] {
  values.forEach(validatePolicy);
}

function validateParamRule(ruleValue: unknown): void {
  const rule = object(ruleValue, 'ParamRule');
  const anyOf = array(rule.anyOf, 'ParamRule.anyOf');

  if (anyOf.length === 0) {
    throw new TypeError('ParamRule.anyOf must not be empty');
  }

  for (const groupValue of anyOf) {
    const group = object(groupValue, 'ParamRule.anyOf[]');
    const allOf = array(group.allOf, 'ParamRule.anyOf[].allOf');

    if (allOf.length === 0) {
      throw new TypeError('ParamRule.anyOf[].allOf must not be empty');
    }

    allOf.forEach(validateParamMatcher);
  }

  if (rule.reason !== undefined) {
    string(rule.reason, 'ParamRule.reason');
  }
}

function validateParamMatcher(matcherValue: unknown): void {
  const matcher = object(matcherValue, 'ParamMatcher');
  string(matcher.name, 'ParamMatcher.name');

  if (matcher.name.trim() === '') {
    throw new TypeError('ParamMatcher.name must not be empty');
  }

  if (matcher.value !== undefined) {
    string(matcher.value, 'ParamMatcher.value');
  }

  if (matcher.match !== undefined && !PARAM_MATCHES.has(matcher.match as string)) {
    throw new TypeError('ParamMatcher.match is invalid');
  }

  if (
    (matcher.match === 'equals' || matcher.match === 'contains') &&
    matcher.value === undefined
  ) {
    throw new TypeError('ParamMatcher.value is required for equals/contains');
  }
}

function validateDomainRule(ruleValue: unknown): void {
  const rule = object(ruleValue, 'DomainRule') as Record<string, unknown> & DomainRule;
  string(rule.pattern, 'DomainRule.pattern');

  if (!DOMAIN_KINDS.has(rule.kind)) {
    throw new TypeError('DomainRule.kind is invalid');
  }

  if (rule.kind === 'suffix') {
    // A suffix rule matches a registrable domain (`ebay.com` matches `ebay.com`
    // and `*.ebay.com`). A bare single label — `ebay`, or `ebay.` which
    // normalizes to `ebay` — matches only `*.ebay`, i.e. no real host. This is
    // the classic mis-port of a substring domain list (`hostname.includes('ebay.')`)
    // onto suffix rules, which silently makes the rule inert. Warn, don't throw:
    // the rule is structurally valid, just almost certainly a mistake.
    const normalized = rule.pattern
      .toLowerCase()
      .replace(/^\.+/, '')
      .replace(/\.+$/, '');
    if (normalized.length === 0 || !normalized.includes('.')) {
      const example = normalized || 'example';
      console.warn(
        `standdown: DomainRule suffix pattern ${JSON.stringify(rule.pattern)} is a bare ` +
          `label — suffix rules match registrable domains, so it will not match hosts ` +
          `like "${example}.com". Did you port a substring rule? Use a full host ` +
          `(e.g. "${example}.com") or kind: "regex".`,
      );
    }
  }

  if (rule.kind === 'regex') {
    try {
      new RegExp(rule.pattern);
    } catch {
      throw new TypeError('DomainRule.pattern must be a valid regex');
    }
  }

  if (rule.comment !== undefined) {
    string(rule.comment, 'DomainRule.comment');
  }
}

function validateCookieRule(ruleValue: unknown): void {
  const rule = object(ruleValue, 'CookieRule') as Record<string, unknown> & CookieRule;
  string(rule.name, 'CookieRule.name');

  if (!COOKIE_MATCHES.has(rule.match)) {
    throw new TypeError('CookieRule.match is invalid');
  }

  if (rule.reason !== undefined) {
    string(rule.reason, 'CookieRule.reason');
  }
}

function validateInitiatorRule(ruleValue: unknown): void {
  const rule = object(ruleValue, 'InitiatorRule') as Record<string, unknown> &
    InitiatorRule;

  if (!REFERRER_CLASSES.has(rule.referrerClass)) {
    throw new TypeError('InitiatorRule.referrerClass is invalid');
  }

  if (rule.reason !== undefined) {
    string(rule.reason, 'InitiatorRule.reason');
  }
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }

  return value as Record<string, unknown>;
}

function string(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${path} must be a non-empty string`);
  }
}

function literal<T>(value: unknown, expected: T, path: string): asserts value is T {
  if (value !== expected) {
    throw new TypeError(`${path} must be ${String(expected)}`);
  }
}

function array(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${path} must be an array`);
  }

  return value;
}

function optionalArray(value: unknown, path: string): readonly unknown[] {
  if (value === undefined) {
    return [];
  }

  return array(value, path);
}

function nonNegativeFiniteNumber(value: unknown, path: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${path} must be a non-negative finite number`);
  }
}

function urlString(value: unknown, path: string): void {
  string(value, path);

  try {
    new URL(value);
  } catch {
    throw new TypeError(`${path} must be an absolute URL`);
  }
}

function dateString(value: unknown, path: string): void {
  string(value, path);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new TypeError(`${path} must be YYYY-MM-DD`);
  }
}
