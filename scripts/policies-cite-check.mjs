import { readFile } from 'node:fs/promises';
import { allPolicies } from '../dist/policies.mjs';

const HOMEPAGE_ONLY_URLS = new Set([
  'https://www.awin.com/',
  'https://www.shareasale.com/',
  'https://partnernetwork.ebay.com/',
  'https://partnerize.com/',
]);

const errors = [];

for (const policy of allPolicies) {
  const prefix = policy.id;

  if (!policy.metadata?.sourceUrl?.startsWith('https://')) {
    errors.push(`${prefix}: metadata.sourceUrl must be an https URL`);
  }

  if (HOMEPAGE_ONLY_URLS.has(policy.metadata?.sourceUrl)) {
    errors.push(`${prefix}: metadata.sourceUrl must cite a specific document`);
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(policy.metadata?.lastVerified ?? '')) {
    errors.push(`${prefix}: metadata.lastVerified must be YYYY-MM-DD`);
  }

  const ruleCount =
    (policy.detection.advertiserHosts?.length ?? 0) +
    (policy.detection.redirectDomains?.length ?? 0) +
    (policy.detection.cookiePatterns?.length ?? 0) +
    (policy.detection.initiatorRules?.length ?? 0) +
    countParamRules(policy.detection.landingParams ?? []);

  if (ruleCount === 0) {
    errors.push(`${prefix}: policy must contain at least one detection rule`);
  }

  if (ruleCount > 0 && !policy.metadata?.sourceUrl) {
    errors.push(`${prefix}: rules require pack-level metadata.sourceUrl`);
  }

  if (ruleCount > 0 && !policy.metadata?.lastVerified) {
    errors.push(`${prefix}: rules require pack-level metadata.lastVerified`);
  }
}

const universal = allPolicies.find((policy) => policy.id === 'universal');

if (!universal) {
  errors.push('universal: policy is missing');
} else if ((universal.detection.redirectDomains?.length ?? 0) < 40) {
  errors.push('universal: expected full piedotorg/standdown-domains import');
}

const policiesDoc = await readFile(new URL('../POLICIES.md', import.meta.url), 'utf8');

if (!policiesDoc.includes("The People's Internet Experiment Inc.")) {
  errors.push('POLICIES.md: missing piedotorg MIT copyright attribution');
}

if (errors.length > 0) {
  console.error(errors.map((error) => `- ${error}`).join('\n'));
  process.exit(1);
}

console.log(`policies-cite-check passed for ${allPolicies.length} policies`);

function countParamRules(rules) {
  return rules.reduce((count, rule) => {
    return (
      count +
      rule.anyOf.reduce((groupCount, group) => groupCount + group.allOf.length, 0)
    );
  }, 0);
}
