import type { Behavior, StanddownPolicy } from './types';

const LAST_VERIFIED = '2026-07-10';
const THIRTY_MINUTES_MS = 1_800_000;
const SIXTY_MINUTES_MS = 3_600_000;
const COC_INACTIVITY_MS = 3_600_000;
const COC_FALLBACK_MIN_MS = 5_400_000;
const PIE_STANDDOWN_DOMAINS_URL =
  'https://raw.githubusercontent.com/piedotorg/standdown-domains/main/standdown-domains.json';

const standdownBehaviors = [
  'suppress-prompts',
  'no-cookie-write',
  'no-redirect',
  'no-background-tracking',
] as const satisfies readonly Behavior[];

export const cocDefaults = {
  scope: 'advertiser',
  sessionRule: 'inactivity-window',
  minDurationMs: COC_FALLBACK_MIN_MS,
  inactivityMs: COC_INACTIVITY_MS,
  behaviors: standdownBehaviors,
} as const satisfies StanddownPolicy['standdown'];

export const cjPolicy = {
  id: 'cj',
  schemaVersion: 3,
  policyVersion: '0.1.0',
  network: {
    id: 'cj',
    name: 'CJ Affiliate',
    policyUrl: 'https://www.cj.com/legal/software-policy',
  },
  detection: {
    landingParams: [
      { anyOf: [{ allOf: [{ name: 'cjevent' }] }] },
      { anyOf: [{ allOf: [{ name: 'cjdata' }] }] },
      {
        anyOf: [
          { allOf: [{ name: 'utm_source', value: 'cj', match: 'equals' }] },
        ],
      },
      {
        anyOf: [{ allOf: [{ name: 'sf_cs', value: 'cj', match: 'equals' }] }],
      },
      {
        anyOf: [{ allOf: [{ name: 'afsrc', value: '1', match: 'equals' }] }],
      },
    ],
    redirectDomains: [
      { pattern: 'anrdoezrs.net', kind: 'suffix', comment: 'CJ rotating domain' },
      {
        pattern: 'commission-junction.com',
        kind: 'suffix',
        comment: 'CJ rotating domain',
      },
      { pattern: 'dpbolvw.net', kind: 'suffix', comment: 'CJ rotating domain' },
      { pattern: 'apmebf.com', kind: 'suffix', comment: 'CJ rotating domain' },
      { pattern: 'jdoqocy.com', kind: 'suffix', comment: 'CJ rotating domain' },
      { pattern: 'kqzyfj.com', kind: 'suffix', comment: 'CJ rotating domain' },
      { pattern: 'qksrv.net', kind: 'suffix', comment: 'CJ rotating domain' },
      { pattern: 'tkqlhce.com', kind: 'suffix', comment: 'CJ rotating domain' },
      { pattern: 'qksz.net', kind: 'suffix', comment: 'CJ rotating domain' },
      { pattern: 'afcyhf.com', kind: 'suffix', comment: 'CJ rotating domain' },
      { pattern: 'awltovhc.com', kind: 'suffix', comment: 'CJ rotating domain' },
      { pattern: 'ftjcfx.com', kind: 'suffix', comment: 'CJ rotating domain' },
      { pattern: 'lduhtrp.net', kind: 'suffix', comment: 'CJ rotating domain' },
      { pattern: 'tqlkg.com', kind: 'suffix', comment: 'CJ rotating domain' },
      { pattern: 'awxibrm.com', kind: 'suffix', comment: 'CJ rotating domain' },
      { pattern: 'cualbr.com', kind: 'suffix', comment: 'CJ rotating domain' },
      { pattern: 'rnsfpw.net', kind: 'suffix', comment: 'CJ rotating domain' },
      { pattern: 'vofzpwh.com', kind: 'suffix', comment: 'CJ rotating domain' },
      { pattern: 'yceml.net', kind: 'suffix', comment: 'CJ rotating domain' },
    ],
    cookiePatterns: [
      { name: 'cje', match: 'substring' },
      { name: 'cjevent_dc', match: 'substring' },
    ],
  },
  standdown: {
    scope: 'advertiser',
    sessionRule: 'session-or-min',
    minDurationMs: SIXTY_MINUTES_MS,
    behaviors: standdownBehaviors,
  },
  activation: { mode: 'user-click' },
  metadata: {
    sourceUrl: 'https://www.cj.com/legal/software-policy',
    lastVerified: LAST_VERIFIED,
    notes:
      'CJ policy cites CJ domains, afsrc=1, and cjevent; rotating domain list is attributed to piedotorg/standdown-domains. Minimum stand-down duration (60m) is calibrated to production enforcement (Dupe standDownCookieDuration=60).',
  },
} as const satisfies StanddownPolicy;

export const impactPolicy = {
  id: 'impact',
  schemaVersion: 3,
  policyVersion: '0.1.0',
  network: {
    id: 'impact',
    name: 'Impact',
    policyUrl: 'https://impact.com/stand-down-policy.ihtml',
  },
  detection: {
    landingParams: [
      {
        anyOf: [{ allOf: [{ name: 'afsrc', value: '1', match: 'equals' }] }],
      },
      { anyOf: [{ allOf: [{ name: 'irclickid' }] }] },
      { anyOf: [{ allOf: [{ name: 'irgwc' }] }] },
    ],
    cookiePatterns: [{ name: 'im_ref', match: 'substring' }],
  },
  standdown: {
    scope: 'advertiser',
    sessionRule: 'session-or-min',
    minDurationMs: THIRTY_MINUTES_MS,
    behaviors: standdownBehaviors,
  },
  activation: { mode: 'user-click' },
  metadata: {
    sourceUrl: 'https://impact.com/stand-down-policy.ihtml',
    lastVerified: LAST_VERIFIED,
    notes:
      'Impact stand-down policy URL and irclickid/im_ref signals are from pre-build research; irgwc is attributed to piedotorg/standdown-domains.',
  },
} as const satisfies StanddownPolicy;

export const rakutenPolicy = {
  id: 'rakuten',
  schemaVersion: 3,
  policyVersion: '0.1.0',
  network: {
    id: 'rakuten',
    name: 'Rakuten Advertising',
    policyUrl: 'https://github.com/rakutenrewards/PublisherStandown-SDK',
  },
  detection: {
    landingParams: [
      {
        anyOf: [
          {
            allOf: [{ name: 'ranMID' }, { name: 'ranEAID' }, { name: 'ranSiteID' }],
          },
          { allOf: [{ name: 'ranEAID' }, { name: 'ranSiteID' }] },
          { allOf: [{ name: 'ranSiteID' }] },
          { allOf: [{ name: 'siteID' }] },
        ],
      },
    ],
    redirectDomains: [
      { pattern: 'click.linksynergy.com', kind: 'suffix' },
      { pattern: 'linksynergy.jrs5.com', kind: 'suffix' },
      { pattern: 'tk.jrs5.com', kind: 'suffix' },
      {
        pattern: '(^|\\.)linksynergy\\.[a-z]+$',
        kind: 'regex',
        comment: 'linksynergy.* domain family',
      },
    ],
    cookiePatterns: [
      { name: 'lsclick_mid', match: 'substring' },
      { name: 'linkshare', match: 'substring' },
    ],
  },
  standdown: {
    scope: 'advertiser',
    sessionRule: 'session-or-min',
    minDurationMs: COC_FALLBACK_MIN_MS,
    behaviors: standdownBehaviors,
  },
  activation: { mode: 'user-click' },
  metadata: {
    sourceUrl: 'https://github.com/rakutenrewards/PublisherStandown-SDK',
    lastVerified: LAST_VERIFIED,
    notes:
      'Rakuten SDK is detection-only and ships no policies; duration uses CoC fallback because the public source describes browser-session semantics without a fixed millisecond value.',
  },
} as const satisfies StanddownPolicy;

export const awinPolicy = {
  id: 'awin',
  schemaVersion: 3,
  policyVersion: '0.1.0',
  network: {
    id: 'awin',
    name: 'Awin',
    policyUrl:
      'https://success.awin.com/s/article/Downloadable-Software-Guidelines',
  },
  detection: {
    landingParams: [
      { anyOf: [{ allOf: [{ name: 'awc' }] }] },
      {
        anyOf: [
          { allOf: [{ name: 'utm_source', value: 'aw', match: 'equals' }] },
        ],
      },
      {
        anyOf: [{ allOf: [{ name: 'source', value: 'aw', match: 'equals' }] }],
      },
    ],
    redirectDomains: [{ pattern: 'awin1.com', kind: 'suffix' }],
  },
  standdown: cocDefaults,
  activation: { mode: 'user-click' },
  metadata: {
    sourceUrl:
      'https://success.awin.com/s/article/Downloadable-Software-Guidelines',
    lastVerified: LAST_VERIFIED,
    notes:
      'Awin awc/awin1.com signals are from pre-build research, Awin downloadable-software guidance, Awin Soft Click status docs, and piedotorg/standdown-domains. CoC inactivity-window defaults are broader than the seed table session-or-min entry and are ratified by SPEC A5.',
  },
} as const satisfies StanddownPolicy;

export const shareasalePolicy = {
  id: 'shareasale',
  schemaVersion: 3,
  policyVersion: '0.1.0',
  network: {
    id: 'shareasale',
    name: 'ShareASale',
    policyUrl:
      'https://success.awin.com/s/article/Downloadable-Software-Guidelines',
  },
  detection: {
    landingParams: [{ anyOf: [{ allOf: [{ name: 'sscid' }] }] }],
    redirectDomains: [
      { pattern: 'shareasale.com', kind: 'suffix' },
      { pattern: 'shrsl.com', kind: 'suffix' },
    ],
    cookiePatterns: [{ name: 'sscid', match: 'substring' }],
  },
  standdown: cocDefaults,
  activation: { mode: 'user-click' },
  metadata: {
    sourceUrl:
      'https://success.awin.com/s/article/Downloadable-Software-Guidelines',
    lastVerified: LAST_VERIFIED,
    notes:
      'ShareASale is Awin-owned and is treated under Awin downloadable-software/CoC guidance. sscid/shareasale.com/shrsl.com signals are from pre-build research and piedotorg/standdown-domains. CoC inactivity-window defaults are broader than the seed table session-or-min entry and are ratified by SPEC A5.',
  },
} as const satisfies StanddownPolicy;

export const ebayEpnPolicy = {
  id: 'ebay-epn',
  schemaVersion: 3,
  policyVersion: '0.1.0',
  network: {
    id: 'ebay-epn',
    name: 'eBay Partner Network',
    policyUrl: 'https://partnernetwork.ebay.com/browser-extension-policy',
  },
  detection: {
    advertiserHosts: [
      {
        pattern: '(^|\\.)ebay\\.[a-z.]+$',
        kind: 'regex',
        comment: 'Scope eBay journey-only rules to eBay advertiser hosts',
      },
    ],
    landingParams: [
      {
        anyOf: [
          { allOf: [{ name: 'campid' }] },
          { allOf: [{ name: 'pubid' }] },
          { allOf: [{ name: 'mkevt' }] },
          { allOf: [{ name: 'mkcid' }] },
          { allOf: [{ name: 'mkrid' }] },
          { allOf: [{ name: 'campid' }, { name: '_trkparms' }] },
          { allOf: [{ name: 'mktype' }, { name: 'gclid' }] },
        ],
      },
    ],
    redirectDomains: [{ pattern: 'rover.ebay.com', kind: 'suffix' }],
    initiatorRules: [
      {
        referrerClass: 'other',
        reason: 'non-approved source during eBay journey',
      },
    ],
  },
  standdown: cocDefaults,
  activation: {
    mode: 'user-click',
    allowedReferrerClasses: ['own-site', 'organic', 'direct'],
  },
  metadata: {
    sourceUrl: 'https://partnernetwork.ebay.com/browser-extension-policy',
    lastVerified: LAST_VERIFIED,
    notes:
      'eBay referrer requirements are from pre-build research; landing params and rover.ebay.com are also attributed to piedotorg/standdown-domains.',
  },
} as const satisfies StanddownPolicy;

export const amazonPolicy = {
  id: 'amazon',
  schemaVersion: 3,
  policyVersion: '0.1.0',
  network: {
    id: 'amazon',
    name: 'Amazon Associates',
    policyUrl: 'https://affiliate-program.amazon.com/help/operating/policies',
  },
  detection: {
    advertiserHosts: [
      {
        pattern: '(^|\\.)amazon\\.[a-z.]+$',
        kind: 'regex',
        comment: 'Scope Amazon tag detection to Amazon advertiser hosts',
      },
    ],
    landingParams: [{ anyOf: [{ allOf: [{ name: 'tag' }] }] }],
  },
  standdown: {
    scope: 'advertiser',
    sessionRule: 'session-or-min',
    minDurationMs: COC_FALLBACK_MIN_MS,
    behaviors: standdownBehaviors,
  },
  activation: { mode: 'never' },
  metadata: {
    sourceUrl: 'https://affiliate-program.amazon.com/help/operating/policies',
    lastVerified: LAST_VERIFIED,
    notes:
      'Amazon forbids Special Links in browser extensions; tag is detected for attribution visibility, but activation is never allowed.',
  },
} as const satisfies StanddownPolicy;

export const sovrnSkimlinksPolicy = {
  id: 'sovrn-skimlinks',
  schemaVersion: 3,
  policyVersion: '0.1.0',
  network: {
    id: 'sovrn-skimlinks',
    name: 'Sovrn / Skimlinks',
    policyUrl:
      'https://www.sovrn.com/sovrn-commerce-publisher-code-of-conduct/',
  },
  detection: {
    // Low-confidence entry from research/domain knowledge; keep visible for audit.
    redirectDomains: [
      { pattern: 'go.skimresources.com', kind: 'suffix' },
      { pattern: 'go.redirectingat.com', kind: 'suffix' },
    ],
  },
  standdown: cocDefaults,
  activation: { mode: 'user-click' },
  metadata: {
    sourceUrl:
      'https://www.sovrn.com/sovrn-commerce-publisher-code-of-conduct/',
    lastVerified: LAST_VERIFIED,
    notes:
      'unverified against network docs; redirect domains from domain knowledge. CoC inactivity-window defaults are broader than the seed table session-or-min entry and are ratified by SPEC A5.',
  },
} as const satisfies StanddownPolicy;

export const partnerizePolicy = {
  id: 'partnerize',
  schemaVersion: 3,
  policyVersion: '0.1.0',
  network: {
    id: 'partnerize',
    name: 'Partnerize',
    policyUrl: 'https://partnerize.com/legal/terms-and-conditions/',
  },
  detection: {
    landingParams: [{ anyOf: [{ allOf: [{ name: 'clickref' }] }] }],
    // Low-confidence entry from research/domain knowledge; keep visible for audit.
    redirectDomains: [{ pattern: 'prf.hn', kind: 'suffix' }],
  },
  standdown: cocDefaults,
  activation: { mode: 'user-click' },
  metadata: {
    sourceUrl: 'https://partnerize.com/legal/terms-and-conditions/',
    lastVerified: LAST_VERIFIED,
    notes:
      'unverified against network docs; prf.hn redirect domain from domain knowledge. CoC inactivity-window defaults are broader than the seed table session-or-min entry and are ratified by SPEC A5.',
  },
} as const satisfies StanddownPolicy;

export const universalPolicy = {
  id: 'universal',
  schemaVersion: 3,
  policyVersion: '0.1.0',
  network: {
    id: 'universal',
    name: 'Universal affiliate source',
    policyUrl: 'https://github.com/piedotorg/standdown-domains',
  },
  detection: {
    landingParams: [
      {
        anyOf: [{ allOf: [{ name: 'afsrc', value: '1', match: 'equals' }] }],
      },
    ],
    redirectDomains: [
      {
        pattern: '^https?\\:\\/.*[\\?\\&]afsrc=1',
        kind: 'regex',
        comment: 'Universal standdown parameter from piedotorg/standdown-domains',
      },
      {
        pattern: '^https?:\\/\\/www\\.youtube\\.com\\/redirect',
        kind: 'regex',
        comment: 'YouTube redirect to a merchant from piedotorg/standdown-domains',
      },
      {
        pattern: '^https?\\:\\/\\/www\\.anrdoezrs\\.net\\/',
        kind: 'regex',
        comment: 'CJ rotating domain from piedotorg/standdown-domains',
      },
      {
        pattern: '^https?\\:\\/\\/www\\.commission-junction\\.com\\/',
        kind: 'regex',
        comment: 'CJ rotating domain from piedotorg/standdown-domains',
      },
      {
        pattern: '^https?\\:\\/\\/www\\.dpbolvw\\.net\\/',
        kind: 'regex',
        comment: 'CJ rotating domain from piedotorg/standdown-domains',
      },
      {
        pattern: '^https?\\:\\/\\/www\\.apmebf\\.com\\/',
        kind: 'regex',
        comment: 'CJ rotating domain from piedotorg/standdown-domains',
      },
      {
        pattern: '^https?\\:\\/\\/www\\.jdoqocy\\.com\\/',
        kind: 'regex',
        comment: 'CJ rotating domain from piedotorg/standdown-domains',
      },
      {
        pattern: '^https?\\:\\/\\/www\\.kqzyfj\\.com\\/',
        kind: 'regex',
        comment: 'CJ rotating domain from piedotorg/standdown-domains',
      },
      {
        pattern: '^https?\\:\\/\\/www\\.qksrv\\.net\\/',
        kind: 'regex',
        comment: 'CJ rotating domain from piedotorg/standdown-domains',
      },
      {
        pattern: '^https?\\:\\/\\/www\\.tkqlhce\\.com\\/',
        kind: 'regex',
        comment: 'CJ rotating domain from piedotorg/standdown-domains',
      },
      {
        pattern: '^https?\\:\\/\\/www\\.qksz\\.net\\/',
        kind: 'regex',
        comment: 'CJ rotating domain from piedotorg/standdown-domains',
      },
      {
        pattern: '^https?\\:\\/\\/www\\.afcyhf\\.com\\/',
        kind: 'regex',
        comment: 'CJ rotating domain from piedotorg/standdown-domains',
      },
      {
        pattern: '^https?\\:\\/\\/www\\.awltovhc\\.com\\/',
        kind: 'regex',
        comment: 'CJ rotating domain from piedotorg/standdown-domains',
      },
      {
        pattern: '^https?\\:\\/\\/www\\.ftjcfx\\.com\\/',
        kind: 'regex',
        comment: 'CJ rotating domain from piedotorg/standdown-domains',
      },
      {
        pattern: '^https?\\:\\/\\/www\\.lduhtrp\\.net\\/',
        kind: 'regex',
        comment: 'CJ rotating domain from piedotorg/standdown-domains',
      },
      {
        pattern: '^https?\\:\\/\\/www\\.tqlkg\\.com\\/',
        kind: 'regex',
        comment: 'CJ rotating domain from piedotorg/standdown-domains',
      },
      {
        pattern: '^https?\\:\\/\\/www\\.awxibrm\\.com\\/',
        kind: 'regex',
        comment: 'CJ rotating domain from piedotorg/standdown-domains',
      },
      {
        pattern: '^https?\\:\\/\\/www\\.cualbr\\.com\\/',
        kind: 'regex',
        comment: 'CJ rotating domain from piedotorg/standdown-domains',
      },
      {
        pattern: '^https?\\:\\/\\/www\\.rnsfpw\\.net\\/',
        kind: 'regex',
        comment: 'CJ rotating domain from piedotorg/standdown-domains',
      },
      {
        pattern: '^https?\\:\\/\\/www\\.vofzpwh\\.com\\/',
        kind: 'regex',
        comment: 'CJ rotating domain from piedotorg/standdown-domains',
      },
      {
        pattern: '^https?\\:\\/\\/www\\.yceml\\.net\\/',
        kind: 'regex',
        comment: 'CJ rotating domain from piedotorg/standdown-domains',
      },
      {
        pattern: '^https?\\:\\/.*[\\?\\&]cjevent=',
        kind: 'regex',
        comment: 'CJ general link param from piedotorg/standdown-domains',
      },
      {
        pattern: '^https?\\:\\/.*[\\?\\&]ranEAID=',
        kind: 'regex',
        comment: 'RAN general link param on landing from piedotorg/standdown-domains',
      },
      {
        pattern: '^https?\\:\\/\\/tk\\.jrs5\\.com\\/',
        kind: 'regex',
        comment: 'RAN domain from piedotorg/standdown-domains',
      },
      {
        pattern: '^https?\\:\\/\\/linksynergy\\.jrs5\\.com\\/',
        kind: 'regex',
        comment: 'RAN domain from piedotorg/standdown-domains',
      },
      {
        pattern: '^https?\\:\\/\\/click\\.linksynergy\\.com\\/',
        kind: 'regex',
        comment: 'RAN domain from piedotorg/standdown-domains',
      },
      {
        pattern: '^https?\\:\\/\\/www\\.gopjn\\.com\\/t',
        kind: 'regex',
        comment: 'ASC partner domain from piedotorg/standdown-domains',
      },
      {
        pattern: '^https?\\:\\/\\/www\\.pjatr\\.com\\/t',
        kind: 'regex',
        comment: 'ASC partner domain from piedotorg/standdown-domains',
      },
      {
        pattern: '^https?\\:\\/\\/www\\.pjtra\\.com\\/t',
        kind: 'regex',
        comment: 'ASC partner domain from piedotorg/standdown-domains',
      },
      {
        pattern: '^https?\\:\\/\\/www\\.pntra\\.com\\/t\\/\\w+-\\w+',
        kind: 'regex',
        comment: 'ASC partner domain from piedotorg/standdown-domains',
      },
      {
        pattern: '^https?\\:\\/\\/www\\.pntrac\\.com\\/t\\/\\w+-\\w+',
        kind: 'regex',
        comment: 'ASC partner domain from piedotorg/standdown-domains',
      },
      {
        pattern: '^https?\\:\\/\\/www\\.pntrs\\.com\\/t\\/\\w+-\\w+',
        kind: 'regex',
        comment: 'ASC partner domain from piedotorg/standdown-domains',
      },
      {
        pattern: '^https?\\:\\/.*\\.pepperjamnetwork\\.com',
        kind: 'regex',
        comment: 'ASC partner domain from piedotorg/standdown-domains',
      },
      {
        pattern: '^https?\\:\\/.*[\\?\\&]irgwc=',
        kind: 'regex',
        comment: 'IMPACT landing page param on landing from piedotorg/standdown-domains',
      },
      {
        pattern: '^https?\\:\\/\\/prf.hn/',
        kind: 'regex',
        comment: 'PZ general affiliate link from piedotorg/standdown-domains',
      },
      {
        pattern: '^https?\\:\\/\\/www\\.awin1.com/',
        kind: 'regex',
        comment: 'AW general affiliate link from piedotorg/standdown-domains',
      },
      {
        pattern: '^https?\\:\\/\\/track\\.webgains\\.com/',
        kind: 'regex',
        comment: 'Webgains general affiliate link from piedotorg/standdown-domains',
      },
      {
        pattern: '^https?\\:\\/\\/shrsl.com/',
        kind: 'regex',
        comment: 'Sharesale shortened affiliate link from piedotorg/standdown-domains',
      },
      {
        pattern: '^https?\\:\\/\\/www\\.shareasale.com/',
        kind: 'regex',
        comment: 'Sharesale general affiliate link from piedotorg/standdown-domains',
      },
      {
        pattern: '^https?\\:\\/\\/howl\\.link\\/link',
        kind: 'regex',
        comment: 'Howl partner general affiliate link from piedotorg/standdown-domains',
      },
      {
        pattern: '^https:\\/\\/[\\w]+\\.ebay.*[\\?\\&](mkcid=|campid=|mkevt=)',
        kind: 'regex',
        comment: 'EBAY affiliate query param from piedotorg/standdown-domains',
      },
    ],
  },
  standdown: cocDefaults,
  activation: { mode: 'user-click' },
  metadata: {
    sourceUrl: PIE_STANDDOWN_DOMAINS_URL,
    lastVerified: LAST_VERIFIED,
    notes:
      'Full piedotorg/standdown-domains rule set imported under MIT license; duration semantics use Affiliate Software Code of Conduct defaults.',
  },
} as const satisfies StanddownPolicy;

/**
 * Verified policy packs, safe to enable by default. Every entry here has a
 * cited `metadata.sourceUrl` and detection rules attributed to a network policy
 * or the piedotorg/standdown-domains list, and is enforced by
 * `scripts/policies-cite-check.mjs`.
 */
export const allPolicies = [
  cjPolicy,
  impactPolicy,
  rakutenPolicy,
  awinPolicy,
  shareasalePolicy,
  ebayEpnPolicy,
  amazonPolicy,
  universalPolicy,
] as const satisfies readonly StanddownPolicy[];

/**
 * Low-confidence packs whose redirect domains are inferred from domain
 * knowledge rather than verified against network documentation. Kept out of
 * `allPolicies` so the default set stays trustworthy; opt in explicitly (import
 * this array or name the pack via `policiesFor`) once you have verified them for
 * your integration.
 */
export const experimentalPolicies = [
  sovrnSkimlinksPolicy,
  partnerizePolicy,
] as const satisfies readonly StanddownPolicy[];

const knownPolicies: readonly StanddownPolicy[] = [
  ...allPolicies,
  ...experimentalPolicies,
];

export function policiesFor(networks: readonly string[]): StanddownPolicy[] {
  const wanted = new Set(networks);

  return knownPolicies.filter(
    (policy) => wanted.has(policy.id) || wanted.has(policy.network.id),
  );
}
