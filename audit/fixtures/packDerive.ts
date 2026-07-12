import type { DomainRule, ParamMatcher, StanddownPolicy } from 'standdown';

/**
 * Shared, host-accurate derivation helpers used by both the fixture server
 * (which serves pages) and the scenario builder (which produces logical
 * signals). Everything here is read straight off a pack's `detection` block so
 * the two consumers stay in lock-step with the library's own rules.
 */

/** Concrete `name=value` pair a matcher would satisfy (mirrors detect.ts). */
export interface ParamPair {
  name: string;
  value: string;
}

function valueForMatcher(matcher: ParamMatcher): string {
  if (matcher.match === 'contains') {
    return `before-${matcher.value}-after`;
  }
  return matcher.value ?? 'value';
}

/** True when a landing-param group is the universal `afsrc=1` standdown flag. */
function isAfsrcGroup(matchers: readonly ParamMatcher[]): boolean {
  return matchers.some((m) => m.name === 'afsrc' && m.value === '1');
}

/**
 * Representative param pairs that positively satisfy a single landing-param
 * group (the group's full `allOf`, so AND-groups like Rakuten's stay valid).
 */
export function paramsForGroup(matchers: readonly ParamMatcher[]): ParamPair[] {
  return matchers.map((m) => ({ name: m.name, value: valueForMatcher(m) }));
}

/**
 * The pack's landing-param groups, split into the "primary" attribution groups
 * and the `afsrc=1` universal flag (surfaced separately so callers can emit a
 * dedicated afsrc scenario only where the pack actually includes it).
 */
export function landingGroups(policy: StanddownPolicy): {
  primary: ParamPair[][];
  afsrc: ParamPair[] | undefined;
} {
  const primary: ParamPair[][] = [];
  let afsrc: ParamPair[] | undefined;

  for (const rule of policy.detection.landingParams ?? []) {
    for (const group of rule.anyOf) {
      const pairs = paramsForGroup(group.allOf);
      if (isAfsrcGroup(group.allOf)) {
        afsrc ??= pairs;
      } else {
        primary.push(pairs);
      }
    }
  }

  return { primary, afsrc };
}

/** First cookie the pack looks for, expressed as a concrete cookie NAME. */
export function cookieNameFor(policy: StanddownPolicy): string | undefined {
  const rule = policy.detection.cookiePatterns?.[0];
  if (!rule) {
    return undefined;
  }
  // substring rules match on inclusion, so a decorated real-world name is a
  // faithful positive; exact rules must be emitted verbatim.
  return rule.match === 'exact' ? rule.name : `${rule.name}_1`;
}

/**
 * A URL that positively matches a redirect DomainRule (suffix or regex).
 * Adapted from tests/detect.test.ts `positiveRedirectFor`.
 */
export function redirectUrlForRule(rule: DomainRule): string | undefined {
  if (rule.kind === 'suffix') {
    return `https://www.${rule.pattern}/click`;
  }

  const p = rule.pattern;
  if (p.includes('afsrc=1')) {
    return 'https://tracker.example/landing?afsrc=1';
  }
  if (p.includes('youtube')) {
    return 'https://www.youtube.com/redirect?q=https%3A%2F%2Fmerchant.example';
  }
  if (p.includes('cjevent=')) {
    return 'https://tracker.example/landing?cjevent=abc';
  }
  if (p.includes('ranEAID=')) {
    return 'https://tracker.example/landing?ranEAID=abc';
  }
  if (p.includes('irgwc=')) {
    return 'https://tracker.example/landing?irgwc=abc';
  }
  if (p.includes('howl')) {
    return 'https://howl.link/link/abc';
  }
  if (p.includes('\\.ebay')) {
    return 'https://rover.ebay.com/itm/123?mkcid=1';
  }

  const host = hostForKnownRegex(p);
  if (host !== undefined) {
    const suffix = p.includes('\\/t') ? '/t/abc-def' : '/click';
    return `https://${host}${suffix}`;
  }
  return undefined;
}

/** First usable redirect URL for a pack, or undefined if it has none. */
export function redirectUrlFor(policy: StanddownPolicy): string | undefined {
  for (const rule of policy.detection.redirectDomains ?? []) {
    const url = redirectUrlForRule(rule);
    if (url) {
      return url;
    }
  }
  return undefined;
}

/**
 * Host-accurate advertiser host for a pack's logical signals. Host-scoped packs
 * (amazon, ebay-epn) MUST present as their real advertiser host or detect()
 * rejects them; everything else uses a plausible generic merchant.
 */
export function merchantHostFor(policy: StanddownPolicy): string {
  if (policy.id === 'amazon') {
    return 'www.amazon.com';
  }
  if (policy.id === 'ebay-epn') {
    return 'www.ebay.com';
  }
  return 'www.example-merchant.com';
}

/** Path portion used on the merchant page for a pack (cosmetic, per-host). */
export function merchantLandingPathFor(policy: StanddownPolicy): string {
  if (policy.id === 'amazon') {
    return '/dp/B00EXAMPLE';
  }
  if (policy.id === 'ebay-epn') {
    return '/itm/123456789';
  }
  return '/products/demo-widget';
}

function hostForKnownRegex(pattern: string): string | undefined {
  const hostByNeedle: ReadonlyArray<readonly [string, string]> = [
    ['anrdoezrs', 'www.anrdoezrs.net'],
    ['commission-junction', 'www.commission-junction.com'],
    ['dpbolvw', 'www.dpbolvw.net'],
    ['apmebf', 'www.apmebf.com'],
    ['jdoqocy', 'www.jdoqocy.com'],
    ['kqzyfj', 'www.kqzyfj.com'],
    ['qksrv', 'www.qksrv.net'],
    ['tkqlhce', 'www.tkqlhce.com'],
    ['qksz', 'www.qksz.net'],
    ['afcyhf', 'www.afcyhf.com'],
    ['awltovhc', 'www.awltovhc.com'],
    ['ftjcfx', 'www.ftjcfx.com'],
    ['lduhtrp', 'www.lduhtrp.net'],
    ['tqlkg', 'www.tqlkg.com'],
    ['awxibrm', 'www.awxibrm.com'],
    ['cualbr', 'www.cualbr.com'],
    ['rnsfpw', 'www.rnsfpw.net'],
    ['vofzpwh', 'www.vofzpwh.com'],
    ['yceml', 'www.yceml.net'],
    ['tk\\.jrs5', 'tk.jrs5.com'],
    ['linksynergy\\.jrs5', 'linksynergy.jrs5.com'],
    ['click\\.linksynergy', 'click.linksynergy.com'],
    ['gopjn', 'www.gopjn.com'],
    ['pjatr', 'www.pjatr.com'],
    ['pjtra', 'www.pjtra.com'],
    ['pntra\\.', 'www.pntra.com'],
    ['pntrac', 'www.pntrac.com'],
    ['pntrs', 'www.pntrs.com'],
    ['pepperjamnetwork', 'foo.pepperjamnetwork.com'],
    ['prf.hn', 'prf.hn'],
    ['awin1', 'www.awin1.com'],
    ['webgains', 'track.webgains.com'],
    ['shrsl', 'shrsl.com'],
    ['shareasale', 'www.shareasale.com'],
  ];

  for (const [needle, host] of hostByNeedle) {
    if (pattern.includes(needle)) {
      return host;
    }
  }
  return undefined;
}

/** First publisher-site-like host, used to model an own-site referrer. */
export const DEMO_PUBLISHER_SITE = 'deals.publisher-demo.com';

export type Mechanism = 'landing-param' | 'cookie' | 'redirect' | 'afsrc';

/**
 * The observable a fixture page presents for a given mechanism: which landing
 * params ride in the merchant URL and which cookies the redirector sets. This
 * is the single source of truth shared by the server (what it serves) and the
 * scenario builder (what the served path claims), keeping the two in lock-step.
 */
export function servedFor(
  policy: StanddownPolicy,
  mechanism: Mechanism,
): { params: ParamPair[]; cookies: string[] } {
  const { primary, afsrc } = landingGroups(policy);
  const cookie = cookieNameFor(policy);

  if (mechanism === 'afsrc') {
    return { params: afsrc ?? [], cookies: [] };
  }
  if (mechanism === 'cookie') {
    return { params: [], cookies: cookie ? [cookie] : [] };
  }
  // landing-param and redirect both land on the merchant carrying the first
  // primary attribution param (redirect additionally rides a tracker hop, which
  // only the logical signals — not the served page — can reproduce on localhost).
  return { params: primary[0] ?? [], cookies: [] };
}
