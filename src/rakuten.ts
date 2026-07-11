import type {
  DomainRule,
  ParamMatcher,
  ParamRule,
  RakutenNetworkPolicyV2,
  RakutenPolicyRuleV2,
  StanddownPolicy,
} from './types';
import { validatePolicy } from './validation';

const DEFAULT_RAKUTEN_SESSION_MS = 1_800_000;
const DEFAULT_SOURCE_URL =
  'https://github.com/rakutenrewards/PublisherStandown-SDK';
const LAST_VERIFIED = '2026-07-10';
const STANDDOWN_BEHAVIORS = [
  'suppress-prompts',
  'no-cookie-write',
  'no-redirect',
  'no-background-tracking',
] as const;

export function fromRakutenPolicy(
  policy: RakutenNetworkPolicyV2,
): StanddownPolicy {
  if (policy.schemaVersion !== 2) {
    throw new TypeError('Rakuten policy schemaVersion must be 2');
  }

  const detection: StanddownPolicy['detection'] = {};
  const landingParams = landingParamsFromRakutenRules(policy.rules);
  const redirectDomains = redirectDomainsFromRakutenRules(policy.rules);

  if (landingParams !== undefined) {
    detection.landingParams = landingParams;
  }

  if (redirectDomains !== undefined) {
    detection.redirectDomains = redirectDomains;
  }

  const nativePolicy: StanddownPolicy = {
    id: policy.id,
    schemaVersion: 3,
    policyVersion: policy.policyVersion,
    network: {
      id: policy.network.id,
      name: policy.network.name,
      policyUrl: DEFAULT_SOURCE_URL,
    },
    detection,
    standdown: {
      scope: 'advertiser',
      sessionRule: 'session-or-min',
      minDurationMs:
        policy.network.sessionDuration ?? DEFAULT_RAKUTEN_SESSION_MS,
      behaviors: STANDDOWN_BEHAVIORS,
    },
    activation: { mode: 'user-click' },
    metadata: {
      sourceUrl: DEFAULT_SOURCE_URL,
      lastVerified: LAST_VERIFIED,
      notes:
        'Converted from Rakuten NetworkPolicy schemaVersion 2. Lossy mapping: Rakuten paths/patterns are represented as redirect-domain regex rules; Rakuten has no native fields for cookies, initiator rules, activation guard details, stand-down behaviors, citations, or audit semantics. Emitting back to Rakuten drops multi-group anyOf param rules and match:contains params.',
    },
  };

  try {
    validatePolicy(nativePolicy);
  } catch (error) {
    throw new TypeError(
      `Converted Rakuten policy is invalid: ${messageFromError(error)}`,
    );
  }

  return nativePolicy;
}

export function toRakutenPolicy(
  policy: StanddownPolicy,
): RakutenNetworkPolicyV2 {
  return {
    id: policy.id,
    schemaVersion: 2,
    policyVersion: policy.policyVersion,
    network: {
      id: policy.network.id,
      name: policy.network.name,
      description:
        'Converted from standdown.js. Lossy mapping: cookies, initiator rules, advertiserHosts, activation guard details, behaviors, metadata, citations, audit semantics, multi-group anyOf param rules, and match:contains params are not representable in Rakuten NetworkPolicy v2. The bundled rakuten policy intentionally does not round-trip exactly.',
      sessionDuration: policy.standdown.minDurationMs,
    },
    rules: rakutenRulesFromPolicy(policy),
  };
}

function landingParamsFromRakutenRules(
  rules: readonly RakutenPolicyRuleV2[],
): ParamRule[] | undefined {
  const paramRules = rules.flatMap((rule) => {
    const matchers = paramMatchersFromRakutenParams(rule.params);

    if (matchers.length === 0) {
      return [];
    }

    return [
      {
        anyOf: [{ allOf: matchers }],
        ...(rule.reason === undefined ? {} : { reason: rule.reason }),
      },
    ];
  });

  return paramRules.length === 0 ? undefined : paramRules;
}

function redirectDomainsFromRakutenRules(
  rules: readonly RakutenPolicyRuleV2[],
): StanddownPolicy['detection']['redirectDomains'] {
  const domainRules: DomainRule[] = [];

  for (const rule of rules) {
    if (rule.pattern !== undefined) {
      domainRules.push({
        pattern: rule.pattern,
        kind: 'regex',
        ...(rule.reason === undefined ? {} : { comment: rule.reason }),
      });
      continue;
    }

    if (rule.domain === undefined) {
      continue;
    }

    if (rule.paths !== undefined && rule.paths.length > 0) {
      domainRules.push({
        pattern: domainAndPathsPattern(rule.domain, rule.paths),
        kind: 'regex',
        ...(rule.reason === undefined ? {} : { comment: rule.reason }),
      });
      continue;
    }

    domainRules.push({
      pattern: rule.domain,
      kind: 'suffix',
      ...(rule.reason === undefined ? {} : { comment: rule.reason }),
    });
  }

  return domainRules.length === 0 ? undefined : domainRules;
}

function rakutenRulesFromPolicy(
  policy: StanddownPolicy,
): RakutenPolicyRuleV2[] {
  const rules: RakutenPolicyRuleV2[] = [];

  for (const rule of policy.detection.redirectDomains ?? []) {
    if (rule.kind === 'suffix') {
      rules.push({
        domain: rule.pattern,
        ...(rule.comment === undefined ? {} : { reason: rule.comment }),
      });
      continue;
    }

    rules.push({
      pattern: rule.pattern,
      ...(rule.comment === undefined ? {} : { reason: rule.comment }),
    });
  }

  for (const rule of policy.detection.landingParams ?? []) {
    const params = rakutenParamsFromParamRule(rule);

    if (params !== undefined) {
      rules.push({
        params,
        ...(rule.reason === undefined ? {} : { reason: rule.reason }),
      });
    }
  }

  return rules;
}

function paramMatchersFromRakutenParams(
  params: RakutenPolicyRuleV2['params'],
): ParamMatcher[] {
  if (params === undefined) {
    return [];
  }

  if (Array.isArray(params)) {
    return params.map((name) => ({ name }));
  }

  return Object.entries(params).map(([name, value]) => ({
    name,
    value,
    match: 'equals' as const,
  }));
}

function rakutenParamsFromParamRule(
  rule: ParamRule,
): readonly string[] | Readonly<Record<string, string>> | undefined {
  if (rule.anyOf.length !== 1) {
    return undefined;
  }

  const group = rule.anyOf[0];

  if (group === undefined) {
    return undefined;
  }

  const params: string[] = [];
  const valuedParams: Record<string, string> = {};
  let hasValue = false;

  for (const matcher of group.allOf) {
    const mode = matcher.match ?? (matcher.value === undefined ? 'exists' : 'equals');

    if (mode === 'exists' && matcher.value === undefined) {
      params.push(matcher.name);
      continue;
    }

    if (mode === 'equals' && matcher.value !== undefined) {
      valuedParams[matcher.name] = matcher.value;
      hasValue = true;
      continue;
    }

    return undefined;
  }

  return hasValue ? valuedParams : params;
}

function domainAndPathsPattern(domain: string, paths: readonly string[]): string {
  const escapedDomain = escapeRegex(domain);
  const escapedPaths = paths.map((path) => escapeRegex(path)).join('|');

  return `^https?://([^/]+\\.)?${escapedDomain}(${escapedPaths})([/?#]|$)`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
