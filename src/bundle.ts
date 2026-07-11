import type {
  CookieRule,
  DomainRule,
  InitiatorRule,
  ParamRule,
  PolicyBundleVerificationResult,
  SignedBundleSignatureAlgorithm,
  SignedPolicyBundle,
  StanddownPolicy,
} from './types';
import { validatePolicies } from './validation';

const textEncoder = new TextEncoder();
const MAX_SIGNED_BUNDLE_REGEX_LENGTH = 256;

export async function verifyPolicyBundle(
  current: readonly StanddownPolicy[],
  update: SignedPolicyBundle,
  publicKeyJwk: JsonWebKey,
): Promise<PolicyBundleVerificationResult> {
  try {
    validatePolicies(current);
    validatePolicies(update.policies);
  } catch (error) {
    return { ok: false, violation: `malformed-policy: ${messageFromError(error)}` };
  }

  if (update.schemaVersion !== 1) {
    return { ok: false, violation: 'unsupported-bundle-version' };
  }

  const signatureOk = await verifySignature(
    update.signature.algorithm,
    publicKeyJwk,
    update.signature.value,
    canonicalPolicyBundlePayload(update),
  );

  if (!signatureOk) {
    return { ok: false, violation: 'bad-signature' };
  }

  const regexViolation = regexComplexityViolation(update.policies);

  if (regexViolation !== undefined) {
    return { ok: false, violation: regexViolation };
  }

  const monotonicityViolation = checkMonotonicity(current, update.policies);

  if (monotonicityViolation !== undefined) {
    return { ok: false, violation: monotonicityViolation };
  }

  return { ok: true, policies: update.policies.map(clonePolicy) };
}

export function canonicalPolicyBundlePayload(
  bundle: Pick<SignedPolicyBundle, 'schemaVersion' | 'policies'>,
): string {
  return canonicalJson({
    schemaVersion: bundle.schemaVersion,
    policies: bundle.policies,
  });
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new TypeError('canonical JSON only supports finite numbers');
    }

    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);

  return `{${entries.join(',')}}`;
}

function checkMonotonicity(
  current: readonly StanddownPolicy[],
  update: readonly StanddownPolicy[],
): string | undefined {
  const updateById = new Map(update.map((policy) => [policy.id, policy]));

  for (const currentPolicy of current) {
    const updatedPolicy = updateById.get(currentPolicy.id);

    if (updatedPolicy === undefined) {
      return `policy-removed:${currentPolicy.id}`;
    }

    const detectionResult = detectionViolation(currentPolicy, updatedPolicy);

    if (detectionResult !== undefined) {
      return `${currentPolicy.id}:${detectionResult}`;
    }

    const standdownResult = standdownViolation(currentPolicy, updatedPolicy);

    if (standdownResult !== undefined) {
      return `${currentPolicy.id}:${standdownResult}`;
    }

    if (!sameJson(currentPolicy.activation, updatedPolicy.activation)) {
      return `${currentPolicy.id}:activation-edited`;
    }
  }

  return undefined;
}

function detectionViolation(
  currentPolicy: StanddownPolicy,
  updatedPolicy: StanddownPolicy,
): string | undefined {
  if (
    !domainRulesSurvive(
      currentPolicy.detection.advertiserHosts,
      updatedPolicy.detection.advertiserHosts,
      { advertiserHosts: true },
    )
  ) {
    return 'advertiser-hosts-narrowed';
  }

  if (
    !paramRulesSurvive(
      currentPolicy.detection.landingParams,
      updatedPolicy.detection.landingParams,
    )
  ) {
    return 'landing-params-narrowed';
  }

  if (
    !domainRulesSurvive(
      currentPolicy.detection.redirectDomains,
      updatedPolicy.detection.redirectDomains,
    )
  ) {
    return 'redirect-domains-narrowed';
  }

  if (
    !cookieRulesSurvive(
      currentPolicy.detection.cookiePatterns,
      updatedPolicy.detection.cookiePatterns,
    )
  ) {
    return 'cookie-patterns-narrowed';
  }

  if (
    !initiatorRulesSurvive(
      currentPolicy.detection.initiatorRules,
      updatedPolicy.detection.initiatorRules,
    )
  ) {
    return 'initiator-rules-narrowed';
  }

  return undefined;
}

function standdownViolation(
  currentPolicy: StanddownPolicy,
  updatedPolicy: StanddownPolicy,
): string | undefined {
  if (updatedPolicy.standdown.scope !== currentPolicy.standdown.scope) {
    return 'standdown-scope-edited';
  }

  if (updatedPolicy.standdown.sessionRule !== currentPolicy.standdown.sessionRule) {
    return 'session-rule-edited';
  }

  if (updatedPolicy.standdown.minDurationMs < currentPolicy.standdown.minDurationMs) {
    return 'min-duration-shortened';
  }

  if (
    currentPolicy.standdown.inactivityMs !== undefined &&
    (updatedPolicy.standdown.inactivityMs === undefined ||
      updatedPolicy.standdown.inactivityMs < currentPolicy.standdown.inactivityMs)
  ) {
    return 'inactivity-duration-shortened';
  }

  for (const behavior of currentPolicy.standdown.behaviors) {
    if (!updatedPolicy.standdown.behaviors.includes(behavior)) {
      return 'standdown-behavior-removed';
    }
  }

  return undefined;
}

function domainRulesSurvive(
  current: readonly DomainRule[] | undefined,
  update: readonly DomainRule[] | undefined,
  opts: { advertiserHosts?: boolean } = {},
): boolean {
  if (opts.advertiserHosts && current === undefined) {
    return update === undefined;
  }

  if (current === undefined || current.length === 0) {
    return true;
  }

  if (opts.advertiserHosts && update === undefined) {
    return true;
  }

  if (update === undefined || update.length === 0) {
    return false;
  }

  return current.every((rule) =>
    update.some((candidate) => domainRuleCovers(rule, candidate)),
  );
}

function regexComplexityViolation(
  policies: readonly StanddownPolicy[],
): string | undefined {
  for (const policy of policies) {
    for (const [field, rules] of domainRuleEntries(policy)) {
      for (const rule of rules ?? []) {
        if (rule.kind === 'regex' && isComplexRegex(rule.pattern)) {
          return `${policy.id}:complex-regex:${field}`;
        }
      }
    }
  }

  return undefined;
}

function domainRuleEntries(
  policy: StanddownPolicy,
): readonly (readonly [string, readonly DomainRule[] | undefined])[] {
  return [
    ['detection.advertiserHosts', policy.detection.advertiserHosts],
    ['detection.redirectDomains', policy.detection.redirectDomains],
  ] as const;
}

function isComplexRegex(pattern: string): boolean {
  return (
    pattern.length > MAX_SIGNED_BUNDLE_REGEX_LENGTH ||
    hasRegexBackreference(pattern) ||
    hasRegexLookaround(pattern) ||
    hasNestedUnboundedQuantifier(pattern)
  );
}

function hasRegexBackreference(pattern: string): boolean {
  return /(^|[^\\])\\[1-9]/.test(pattern);
}

function hasRegexLookaround(pattern: string): boolean {
  return /\(\?(?:[=!]|<[=!])/.test(pattern);
}

function hasNestedUnboundedQuantifier(pattern: string): boolean {
  return /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)(?:[+*]|\{\d*,?\})/.test(
    pattern,
  );
}

function domainRuleCovers(current: DomainRule, update: DomainRule): boolean {
  if (current.kind === 'suffix' && update.kind === 'suffix') {
    return domainSuffixMatches(current.pattern, update.pattern);
  }

  return sameJson(current, update);
}

function paramRulesSurvive(
  current: readonly ParamRule[] | undefined,
  update: readonly ParamRule[] | undefined,
): boolean {
  return exactRulesSurvive(current, update);
}

function cookieRulesSurvive(
  current: readonly CookieRule[] | undefined,
  update: readonly CookieRule[] | undefined,
): boolean {
  return exactRulesSurvive(current, update);
}

function initiatorRulesSurvive(
  current: readonly InitiatorRule[] | undefined,
  update: readonly InitiatorRule[] | undefined,
): boolean {
  return exactRulesSurvive(current, update);
}

function exactRulesSurvive<T>(
  current: readonly T[] | undefined,
  update: readonly T[] | undefined,
): boolean {
  if (current === undefined || current.length === 0) {
    return true;
  }

  if (update === undefined || update.length === 0) {
    return false;
  }

  const updatedRules = new Set(update.map((rule) => canonicalJson(rule)));

  return current.every((rule) => updatedRules.has(canonicalJson(rule)));
}

async function verifySignature(
  algorithm: SignedBundleSignatureAlgorithm,
  publicKeyJwk: JsonWebKey,
  signatureValue: string,
  payload: string,
): Promise<boolean> {
  try {
    const publicKey = await importVerificationKey(algorithm, publicKeyJwk);
    const signature = base64UrlToBytes(signatureValue);
    const data = bytesToArrayBuffer(textEncoder.encode(payload));

    if (algorithm === 'ECDSA-P256') {
      return crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        publicKey,
        bytesToArrayBuffer(signature),
        data,
      );
    }

    return crypto.subtle.verify(
      'Ed25519',
      publicKey,
      bytesToArrayBuffer(signature),
      data,
    );
  } catch {
    return false;
  }
}

async function importVerificationKey(
  algorithm: SignedBundleSignatureAlgorithm,
  publicKeyJwk: JsonWebKey,
): Promise<CryptoKey> {
  if (algorithm === 'ECDSA-P256') {
    return crypto.subtle.importKey(
      'jwk',
      publicKeyJwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
  }

  return crypto.subtle.importKey('jwk', publicKeyJwk, 'Ed25519', false, [
    'verify',
  ]);
}

function base64UrlToBytes(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function domainSuffixMatches(host: string, pattern: string): boolean {
  const normalizedHost = host.toLowerCase().replace(/^\./, '').replace(/\.$/, '');
  const normalizedPattern = pattern
    .toLowerCase()
    .replace(/^\./, '')
    .replace(/\.$/, '');

  return (
    normalizedHost === normalizedPattern ||
    normalizedHost.endsWith(`.${normalizedPattern}`)
  );
}

function clonePolicy(policy: StanddownPolicy): StanddownPolicy {
  return JSON.parse(JSON.stringify(policy)) as StanddownPolicy;
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
