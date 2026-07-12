import type { DomainRule, StanddownPolicy } from 'standdown';
import { domainRuleMatchesUrl } from 'standdown';
import { allPolicies } from 'standdown/policies';
import { landingGroups } from './packDerive';

/**
 * Affiliate redirect fingerprinting for the browser audit: given a URL a page
 * (or a rogue extension) navigated through, decide whether it is a known
 * affiliate redirector and, if so, which network. Built from every pack's
 * `redirectDomains` and reusing the library's own `domainRuleMatchesUrl` so
 * suffix dot-boundary and regex semantics stay identical to detect().
 */
export interface FingerprintResult {
  match: boolean;
  networkId?: string;
  rule?: string;
}

/**
 * Flag `url` if it matches any bundled network's redirect-domain rule. Returns
 * the first matching network in policy order (deterministic).
 */
export function isAffiliateRedirect(
  url: string,
  policies: readonly StanddownPolicy[] = allPolicies,
): FingerprintResult {
  for (const policy of policies) {
    for (const rule of policy.detection.redirectDomains ?? []) {
      if (domainRuleMatchesUrl(rule, url)) {
        return {
          match: true,
          networkId: policy.network.id,
          rule: describeRule(rule),
        };
      }
    }
  }
  return { match: false };
}

/** Every first-party cookie NAME any bundled pack watches for. */
export function affiliateCookieNames(
  policies: readonly StanddownPolicy[] = allPolicies,
): Set<string> {
  const names = new Set<string>();
  for (const policy of policies) {
    for (const rule of policy.detection.cookiePatterns ?? []) {
      names.add(rule.name);
    }
  }
  return names;
}

/** Every landing-param NAME any bundled pack watches for. */
export function affiliateLandingParamNames(
  policies: readonly StanddownPolicy[] = allPolicies,
): Set<string> {
  const names = new Set<string>();
  for (const policy of policies) {
    const { primary, afsrc } = landingGroups(policy);
    for (const group of primary) {
      for (const pair of group) {
        names.add(pair.name);
      }
    }
    if (afsrc) {
      for (const pair of afsrc) {
        names.add(pair.name);
      }
    }
  }
  return names;
}

function describeRule(rule: DomainRule): string {
  return `${rule.kind}:${rule.pattern}`;
}
