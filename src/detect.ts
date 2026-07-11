import type {
  CookieRule,
  Detection,
  DomainRule,
  InitiatorRule,
  MatchedRule,
  ParamMatcher,
  ParamRule,
  ReferrerClass,
  SelfExemption,
  Signals,
  StanddownPolicy,
} from './types';

const ORGANIC_REFERRER_SUFFIXES = [
  'google.com',
  'bing.com',
  'duckduckgo.com',
  'yahoo.com',
  'ecosia.org',
  'baidu.com',
  'yandex.com',
] as const;

export function detect(
  signals: Signals,
  policies: readonly StanddownPolicy[],
): Detection {
  const currentUrl = parseUrl(signals.url);

  if (!currentUrl) {
    return {
      matched: [],
      selfMatch: false,
      failClosedReason: 'invalid-url',
    };
  }

  const advertiserHost = currentUrl.hostname.toLowerCase();
  const matched: MatchedRule[] = [];
  let selfMatch = false;

  for (const policy of policies) {
    const scopedSelfMatch = hasScopedSelfExemption(
      currentUrl,
      signals.selfPatterns,
      policy,
    );
    const unscopedSelfMatch = hasUnscopedSelfExemption(
      currentUrl,
      signals.selfPatterns,
    );

    if (scopedSelfMatch || unscopedSelfMatch) {
      selfMatch = true;
    }

    if (scopedSelfMatch) {
      continue;
    }

    matched.push(
      ...collectPolicyMatches(policy, signals, currentUrl, advertiserHost),
    );
  }

  matched.sort((left, right) => kindPriority(left.kind) - kindPriority(right.kind));

  const strongest = matched[0]
    ? {
        policyId: matched[0].policyId,
        advertiserHost: matched[0].advertiserHost,
        reason: matched[0].reason,
      }
    : undefined;

  return strongest ? { matched, selfMatch, strongest } : { matched, selfMatch };
}

export function classifyReferrer(
  signals: Pick<Signals, 'referrer' | 'initiator' | 'publisherSites'>,
  advertiserHost: string,
): ReferrerClass {
  const candidate = signals.initiator ?? signals.referrer;

  if (!candidate) {
    return 'direct';
  }

  const referrerHost = hostFromUrl(candidate);

  if (!referrerHost) {
    return 'other';
  }

  if (
    (signals.publisherSites ?? []).some((site) =>
      domainSuffixMatches(referrerHost, site),
    )
  ) {
    return 'own-site';
  }

  if (domainSuffixMatches(referrerHost, advertiserHost)) {
    return 'advertiser-internal';
  }

  if (
    ORGANIC_REFERRER_SUFFIXES.some((suffix) =>
      domainSuffixMatches(referrerHost, suffix),
    )
  ) {
    return 'organic';
  }

  return 'other';
}

export function domainRuleMatchesUrl(rule: DomainRule, value: string): boolean {
  const url = parseUrl(value);
  const host = url?.hostname.toLowerCase() ?? value.toLowerCase();

  if (rule.kind === 'suffix') {
    return domainSuffixMatches(host, rule.pattern);
  }

  try {
    const regex = new RegExp(rule.pattern, 'i');
    return regex.test(host) || (url ? regex.test(url.href) : regex.test(value));
  } catch {
    return false;
  }
}

function collectPolicyMatches(
  policy: StanddownPolicy,
  signals: Signals,
  currentUrl: URL,
  advertiserHost: string,
): MatchedRule[] {
  const matches: MatchedRule[] = [];
  const advertiserHostMatches =
    policy.detection.advertiserHosts === undefined ||
    policy.detection.advertiserHosts.some((rule) =>
      domainRuleMatchesUrl(rule, advertiserHost),
    );

  if (advertiserHostMatches) {
    for (const rule of policy.detection.landingParams ?? []) {
      if (paramRuleMatches(rule, currentUrl.searchParams)) {
        matches.push(
          matchedRule(
            policy,
            'landing-param',
            describeParamRule(rule),
            advertiserHost,
            rule.reason ?? 'landing parameter matched',
          ),
        );
      }
    }
  }

  for (const rule of policy.detection.redirectDomains ?? []) {
    if ((signals.redirectChain ?? []).some((url) => domainRuleMatchesUrl(rule, url))) {
      matches.push(
        matchedRule(
          policy,
          'redirect-domain',
          `${rule.kind}:${rule.pattern}`,
          advertiserHost,
          rule.comment ?? 'redirect domain matched',
        ),
      );
    }
  }

  if (advertiserHostMatches) {
    for (const rule of policy.detection.cookiePatterns ?? []) {
      if (cookieRuleMatches(rule, signals.cookieNames ?? [])) {
        matches.push(
          matchedRule(
            policy,
            'cookie',
            `${rule.match}:${rule.name}`,
            advertiserHost,
            rule.reason ?? 'first-party cookie name matched',
          ),
        );
      }
    }
  }

  if (advertiserHostMatches) {
    for (const rule of policy.detection.initiatorRules ?? []) {
      if (initiatorRuleMatches(rule, signals, advertiserHost)) {
        matches.push(
          matchedRule(
            policy,
            'initiator',
            `referrer-class:${rule.referrerClass}`,
            advertiserHost,
            rule.reason ?? 'initiator/referrer class matched',
          ),
        );
      }
    }
  }

  return matches;
}

function matchedRule(
  policy: StanddownPolicy,
  kind: MatchedRule['kind'],
  rule: string,
  advertiserHost: string,
  reason: string,
): MatchedRule {
  return {
    policyId: policy.id,
    networkId: policy.network.id,
    networkName: policy.network.name,
    kind,
    rule,
    advertiserHost,
    reason,
    sourceUrl: policy.metadata.sourceUrl,
  };
}

function kindPriority(kind: MatchedRule['kind']): number {
  if (kind === 'redirect-domain') {
    return 0;
  }

  if (kind === 'landing-param') {
    return 1;
  }

  if (kind === 'cookie') {
    return 2;
  }

  return 3;
}

function paramRuleMatches(rule: ParamRule, params: URLSearchParams): boolean {
  return rule.anyOf.some((group) =>
    group.allOf.every((matcher) => paramMatcherMatches(matcher, params)),
  );
}

function paramMatcherMatches(
  matcher: ParamMatcher,
  params: URLSearchParams,
): boolean {
  const values = params.getAll(matcher.name);
  const mode = matcher.match ?? (matcher.value === undefined ? 'exists' : 'equals');

  if (mode === 'exists') {
    return values.length > 0;
  }

  const expectedValue = matcher.value;

  if (expectedValue === undefined) {
    return false;
  }

  if (mode === 'equals') {
    return values.some((value) => value === expectedValue);
  }

  return values.some((value) => value.includes(expectedValue));
}

function cookieRuleMatches(
  rule: CookieRule,
  cookieNames: readonly string[],
): boolean {
  if (rule.match === 'exact') {
    return cookieNames.some((name) => name === rule.name);
  }

  return cookieNames.some((name) => name.includes(rule.name));
}

function initiatorRuleMatches(
  rule: InitiatorRule,
  signals: Signals,
  advertiserHost: string,
): boolean {
  return classifyReferrer(signals, advertiserHost) === rule.referrerClass;
}

function hasScopedSelfExemption(
  currentUrl: URL,
  selfPatterns: readonly SelfExemption[] | undefined,
  policy: StanddownPolicy,
): boolean {
  return (selfPatterns ?? []).some((pattern) => {
    const scopedToPolicy = pattern.policyId === policy.id;
    const scopedToNetwork = pattern.networkId === policy.network.id;

    return (
      (scopedToPolicy || scopedToNetwork) &&
      paramMatcherMatches(pattern, currentUrl.searchParams)
    );
  });
}

function hasUnscopedSelfExemption(
  currentUrl: URL,
  selfPatterns: readonly SelfExemption[] | undefined,
): boolean {
  return (selfPatterns ?? []).some(
    (pattern) =>
      pattern.policyId === undefined &&
      pattern.networkId === undefined &&
      paramMatcherMatches(pattern, currentUrl.searchParams),
  );
}

function domainSuffixMatches(host: string, pattern: string): boolean {
  const normalizedHost = host.toLowerCase().replace(/\.$/, '');
  const normalizedPattern = pattern.toLowerCase().replace(/^\./, '').replace(/\.$/, '');

  return (
    normalizedHost === normalizedPattern ||
    normalizedHost.endsWith(`.${normalizedPattern}`)
  );
}

function describeParamRule(rule: ParamRule): string {
  return rule.anyOf
    .map((group) =>
      group.allOf
        .map((matcher) => {
          const mode = matcher.match ?? (matcher.value === undefined ? 'exists' : 'equals');
          return matcher.value === undefined
            ? `${matcher.name}:${mode}`
            : `${matcher.name}:${mode}:${matcher.value}`;
        })
        .join('&'),
    )
    .join('|');
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function hostFromUrl(value: string): string | undefined {
  return parseUrl(value)?.hostname.toLowerCase();
}
