import { describe, expect, it } from 'vitest';
import type {
  CookieRule,
  DomainRule,
  ParamGroup,
  ParamMatcher,
  Signals,
  StanddownPolicy,
} from '../src';
import { classifyReferrer, detect, domainRuleMatchesUrl } from '../src';
import {
  allPolicies,
  amazonPolicy,
  cjPolicy,
  ebayEpnPolicy,
  impactPolicy,
  rakutenPolicy,
} from '../src/policies';

const DEFAULT_SIGNALS = {
  url: 'https://merchant.example/products/1',
  now: 1_000,
} satisfies Signals;

const bundledPolicies: readonly StanddownPolicy[] = allPolicies;

describe('detect', () => {
  it('matches every bundled landing-param group and rejects absent params', () => {
    for (const policy of bundledPolicies) {
      for (const rule of policy.detection.landingParams ?? []) {
        for (const group of rule.anyOf) {
          const detection = detect(
            { ...DEFAULT_SIGNALS, url: urlForGroup(group, policy) },
            [policy],
          );

          expect(
            detection.matched.some(
              (match) =>
                match.policyId === policy.id && match.kind === 'landing-param',
            ),
            `${policy.id} should match ${JSON.stringify(group)}`,
          ).toBe(true);
        }

        const negative = detect(DEFAULT_SIGNALS, [policy]);

        expect(
          negative.matched.some(
            (match) =>
              match.policyId === policy.id && match.kind === 'landing-param',
          ),
          `${policy.id} should not match absent params`,
        ).toBe(false);
      }
    }
  });

  it('matches every bundled redirect domain and rejects non-suffix lookalikes', () => {
    for (const policy of bundledPolicies) {
      for (const rule of policy.detection.redirectDomains ?? []) {
        const detection = detect(
          {
            ...DEFAULT_SIGNALS,
            redirectChain: [positiveRedirectFor(rule)],
          },
          [policy],
        );

        expect(
          detection.matched.some(
            (match) =>
              match.policyId === policy.id && match.kind === 'redirect-domain',
          ),
          `${policy.id} should match ${rule.kind}:${rule.pattern}`,
        ).toBe(true);

        const negative = detect(
          {
            ...DEFAULT_SIGNALS,
            redirectChain: [negativeRedirectFor(rule)],
          },
          [policy],
        );

        expect(
          negative.matched.some(
            (match) =>
              match.policyId === policy.id && match.kind === 'redirect-domain',
          ),
          `${policy.id} should reject ${negativeRedirectFor(rule)}`,
        ).toBe(false);
      }
    }
  });

  it('matches every bundled cookie rule and rejects absent cookie names', () => {
    for (const policy of bundledPolicies) {
      for (const rule of policy.detection.cookiePatterns ?? []) {
        const detection = detect(
          {
            ...DEFAULT_SIGNALS,
            cookieNames: [positiveCookieName(rule)],
          },
          [policy],
        );

        expect(
          detection.matched.some(
            (match) => match.policyId === policy.id && match.kind === 'cookie',
          ),
          `${policy.id} should match ${rule.match}:${rule.name}`,
        ).toBe(true);

        const negative = detect(
          {
            ...DEFAULT_SIGNALS,
            cookieNames: ['unrelated_cookie'],
          },
          [policy],
        );

        expect(
          negative.matched.some(
            (match) => match.policyId === policy.id && match.kind === 'cookie',
          ),
          `${policy.id} should reject absent cookie ${rule.name}`,
        ).toBe(false);
      }
    }
  });

  it('matches every bundled initiator rule and rejects allowed/direct classes', () => {
    for (const policy of bundledPolicies) {
      for (const rule of policy.detection.initiatorRules ?? []) {
        const positiveSignals: Signals =
          rule.referrerClass === 'other'
            ? {
                ...DEFAULT_SIGNALS,
                url: urlForPolicy(policy),
                referrer: 'https://social.example/post',
              }
            : DEFAULT_SIGNALS;

        const detection = detect(
          positiveSignals,
          [policy],
        );

        expect(
          detection.matched.some(
            (match) => match.policyId === policy.id && match.kind === 'initiator',
          ),
          `${policy.id} should match referrer class ${rule.referrerClass}`,
        ).toBe(true);

        const negative = detect(
          {
            ...DEFAULT_SIGNALS,
            referrer: 'https://www.google.com/search?q=merchant',
          },
          [policy],
        );

        expect(
          negative.matched.some(
            (match) => match.policyId === policy.id && match.kind === 'initiator',
          ),
          `${policy.id} should reject organic referrers for ${rule.referrerClass}`,
        ).toBe(false);
      }
    }
  });

  it('supports AND/OR landing-param groups', () => {
    expect(
      detect(
        {
          ...DEFAULT_SIGNALS,
          url: 'https://merchant.example/?ranEAID=1&ranSiteID=2',
        },
        [rakutenPolicy],
      ).matched,
    ).toHaveLength(1);

    expect(
      detect(
        {
          ...DEFAULT_SIGNALS,
          url: 'https://merchant.example/?ranEAID=1',
        },
        [rakutenPolicy],
      ).matched,
    ).toHaveLength(0);

    expect(
      detect(
        {
          ...DEFAULT_SIGNALS,
          url: 'https://merchant.example/?siteID=site',
        },
        [rakutenPolicy],
      ).matched,
    ).toHaveLength(1);
  });

  it('rejects wrong values for equals param matchers', () => {
    expect(
      detect(
        {
          ...DEFAULT_SIGNALS,
          url: 'https://merchant.example/?utm_source=google',
        },
        [cjPolicy],
      ).matched,
    ).toHaveLength(0);
  });

  it('supports contains param matchers', () => {
    const containsPolicy: StanddownPolicy = {
      ...cjPolicy,
      detection: {
        landingParams: [
          {
            anyOf: [
              {
                allOf: [
                  { name: 'click_id', value: 'affiliate', match: 'contains' },
                ],
              },
            ],
          },
        ],
      },
    };

    expect(
      detect(
        {
          ...DEFAULT_SIGNALS,
          url: 'https://merchant.example/?click_id=before-affiliate-after',
        },
        [containsPolicy],
      ).matched,
    ).toHaveLength(1);

    expect(
      detect(
        {
          ...DEFAULT_SIGNALS,
          url: 'https://merchant.example/?click_id=publisher',
        },
        [containsPolicy],
      ).matched,
    ).toHaveLength(0);
  });

  it('uses dot-boundary domain suffix matching', () => {
    const rule = { pattern: 'ebay.com', kind: 'suffix' } satisfies DomainRule;

    expect(domainRuleMatchesUrl(rule, 'https://rover.ebay.com/rover')).toBe(true);
    expect(domainRuleMatchesUrl(rule, 'https://myebay.example.com/')).toBe(false);
  });

  it('supports exact cookie matchers', () => {
    const exactCookiePolicy: StanddownPolicy = {
      ...cjPolicy,
      detection: {
        cookiePatterns: [{ name: 'exact_cookie', match: 'exact' }],
      },
    };

    expect(
      detect(
        { ...DEFAULT_SIGNALS, cookieNames: ['exact_cookie'] },
        [exactCookiePolicy],
      ).matched,
    ).toHaveLength(1);

    expect(
      detect(
        { ...DEFAULT_SIGNALS, cookieNames: ['prefix_exact_cookie_suffix'] },
        [exactCookiePolicy],
      ).matched,
    ).toHaveLength(0);
  });

  it('applies scoped self-exemption before policy matches', () => {
    const detection = detect(
      {
        ...DEFAULT_SIGNALS,
        url: 'https://merchant.example/?cjevent=own',
        selfPatterns: [{ name: 'cjevent', policyId: 'cj' }],
      },
      [cjPolicy],
    );

    expect(detection.selfMatch).toBe(true);
    expect(detection.matched).toHaveLength(0);
  });

  it('does not let one network self-exemption clear another network match', () => {
    const detection = detect(
      {
        ...DEFAULT_SIGNALS,
        url: 'https://merchant.example/?cjevent=own&irclickid=other',
        selfPatterns: [{ name: 'cjevent', policyId: 'cj' }],
      },
      [cjPolicy, impactPolicy],
    );

    expect(detection.selfMatch).toBe(true);
    expect(detection.matched.map((match) => match.policyId)).toEqual(['impact']);
  });

  it('reports unscoped self-exemptions but fails toward standing down', () => {
    const detection = detect(
      {
        ...DEFAULT_SIGNALS,
        url: 'https://merchant.example/?cjevent=ambiguous',
        selfPatterns: [{ name: 'cjevent' }],
      },
      [cjPolicy],
    );

    expect(detection.selfMatch).toBe(true);
    expect(detection.matched.map((match) => match.policyId)).toEqual(['cj']);
  });

  it('returns a fail-closed reason for malformed signal URLs', () => {
    const detection = detect({ ...DEFAULT_SIGNALS, url: 'not a url' }, [cjPolicy]);

    expect(detection.failClosedReason).toBe('invalid-url');
    expect(detection.matched).toHaveLength(0);
  });

  it('scopes Amazon tag detection to Amazon advertiser hosts', () => {
    expect(
      detect(
        {
          ...DEFAULT_SIGNALS,
          url: 'https://recipes.example/blog?tag=summer',
        },
        [amazonPolicy],
      ).matched,
    ).toHaveLength(0);

    expect(
      detect(
        {
          ...DEFAULT_SIGNALS,
          url: 'https://www.amazon.com/dp/example?tag=publisher-20',
        },
        [amazonPolicy],
      ).matched.map((match) => match.policyId),
    ).toEqual(['amazon']);
  });

  it('scopes eBay initiator rules to eBay advertiser hosts', () => {
    expect(
      detect(
        {
          ...DEFAULT_SIGNALS,
          url: 'https://merchant.example/product',
          referrer: 'https://social.example/post',
        },
        [ebayEpnPolicy],
      ).matched,
    ).toHaveLength(0);

    expect(
      detect(
        {
          ...DEFAULT_SIGNALS,
          url: 'https://www.ebay.com/itm/123',
          referrer: 'https://social.example/post',
        },
        [ebayEpnPolicy],
      ).matched.map((match) => match.kind),
    ).toEqual(['initiator']);
  });

  it('chooses strongest by redirect, landing-param, cookie, then initiator priority', () => {
    const detection = detect(
      {
        ...DEFAULT_SIGNALS,
        url: 'https://merchant.example/?cjevent=abc',
        cookieNames: ['prefix_cje_suffix'],
        redirectChain: ['https://www.dpbolvw.net/click'],
      },
      [cjPolicy],
    );

    expect(detection.matched.map((match) => match.kind)).toEqual([
      'redirect-domain',
      'landing-param',
      'cookie',
    ]);
    expect(detection.strongest).toMatchObject({
      policyId: 'cj',
      reason: 'CJ rotating domain',
    });
  });

  it('classifies own-site only when publisherSites contains the referrer host', () => {
    expect(
      classifyReferrer(
        { referrer: 'https://publisher.example/review' },
        'merchant.example',
      ),
    ).toBe('other');

    expect(
      classifyReferrer(
        {
          referrer: 'https://deals.publisher.example/review',
          publisherSites: ['publisher.example'],
        },
        'merchant.example',
      ),
    ).toBe('own-site');
  });

  it('classifies advertiser-internal referrers separately from own-site', () => {
    expect(
      classifyReferrer(
        { referrer: 'https://www.ebay.com/itm/123' },
        'ebay.com',
      ),
    ).toBe('advertiser-internal');
  });
});

function urlForGroup(group: ParamGroup, policy: StanddownPolicy): string {
  const url = new URL(urlForPolicy(policy));

  for (const matcher of group.allOf) {
    url.searchParams.set(matcher.name, valueForMatcher(matcher));
  }

  return url.href;
}

function urlForPolicy(policy: StanddownPolicy): string {
  if (policy.id === 'amazon') {
    return 'https://www.amazon.com/dp/example';
  }

  if (policy.id === 'ebay-epn') {
    return 'https://www.ebay.com/itm/123';
  }

  return DEFAULT_SIGNALS.url;
}

function valueForMatcher(matcher: ParamMatcher): string {
  if (matcher.match === 'contains') {
    return `before-${matcher.value}-after`;
  }

  return matcher.value ?? 'value';
}

function positiveRedirectFor(rule: DomainRule): string {
  if (rule.kind === 'suffix') {
    return `https://www.${rule.pattern}/click`;
  }

  const pattern = rule.pattern;

  if (pattern.includes('afsrc=1')) {
    return 'https://merchant.example/landing?afsrc=1';
  }

  if (rule.pattern.includes('youtube')) {
    return 'https://www.youtube.com/redirect?q=https%3A%2F%2Fmerchant.example';
  }

  if (pattern.includes('cjevent=')) {
    return 'https://merchant.example/landing?cjevent=abc';
  }

  if (pattern.includes('ranEAID=')) {
    return 'https://merchant.example/landing?ranEAID=abc';
  }

  if (pattern.includes('irgwc=')) {
    return 'https://merchant.example/landing?irgwc=abc';
  }

  if (pattern.includes('\\.ebay')) {
    return 'https://rover.ebay.com/itm/123?mkcid=1';
  }

  const host = hostForKnownRegex(pattern);

  if (host !== undefined) {
    const suffix = pattern.includes('howl')
      ? '/link'
      : pattern.includes('\\/t')
        ? '/t/abc-def'
        : '/click';
    return `https://${host}${suffix}`;
  }

  if (pattern.includes('linksynergy')) {
    return 'https://click.linksynergy.com/fs-bin/click';
  }

  return 'https://merchant.example/no-match';
}

function negativeRedirectFor(rule: DomainRule): string {
  if (rule.kind === 'suffix') {
    return `https://${rule.pattern}.example.com/click`;
  }

  return 'https://merchant.example/no-match';
}

function positiveCookieName(rule: CookieRule): string {
  return rule.match === 'exact' ? rule.name : `prefix_${rule.name}_suffix`;
}

function hostForKnownRegex(pattern: string): string | undefined {
  const hostByNeedle = new Map([
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
    ['howl', 'howl.link'],
  ]);

  for (const [needle, host] of hostByNeedle) {
    if (pattern.includes(needle)) {
      return host;
    }
  }

  return undefined;
}
