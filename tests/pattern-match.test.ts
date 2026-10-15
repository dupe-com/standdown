import { describe, expect, it } from 'vitest';
import {
  detect,
  lintPolicies,
  MemoryStateStore,
  type SelfExemption,
  type StanddownPolicy,
  StanddownSession,
  validatePolicy,
} from '../src';
import { collectContentSignals } from '../src/content';
import {
  caseInsensitiveParams,
  exactParams,
  paramMatcherMatches,
  patternCacheSizeForTests,
} from '../src/detect';
import { compiledPattern, patternProblem } from '../src/pattern';
import { cjPolicy } from '../src/policies';
import { createRelayStanddown } from '../src/relay/background';
import { captureLanding } from '../src/relay/capture';

// Rakuten's publisher site ID shape: 11 chars, a hyphen, 22 chars.
const RAKUTEN_SITE_ID = '^[A-Za-z0-9/*_.]{11}-[A-Za-z0-9/*_.]{22}$';
const RAKUTEN_SHAPED = 'ABCDEFGHIJK-abcdefghijklmnopqrstuv';

const sitePolicy = (value: string): StanddownPolicy => ({
  ...cjPolicy,
  id: 'pattern-test',
  network: { ...cjPolicy.network, id: 'pattern-net' },
  detection: {
    landingParams: [{ anyOf: [{ allOf: [{ name: 'siteID', match: 'pattern', value }] }] }],
    cookiePatterns: [],
  },
});

const landing = (query: string) => caseInsensitiveParams(new URLSearchParams(query));
const matcher = { name: 'siteID', match: 'pattern', value: RAKUTEN_SITE_ID } as const;

describe("ParamMatcher match: 'pattern'", () => {
  it('matches a value of the given shape, in any param-name casing', () => {
    for (const name of ['siteID', 'siteid', 'SiteId', 'SITEID']) {
      expect(paramMatcherMatches(matcher, landing(`${name}=${RAKUTEN_SHAPED}`))).toBe(true);
    }
  });

  it('does not match values of other shapes', () => {
    for (const query of [
      'siteid=4',
      'siteId=abcdef000000',
      'siteId=XY_00000_Example',
      'siteID=abc-def',
      `siteID=${RAKUTEN_SHAPED}x`,
      `siteID=x${RAKUTEN_SHAPED}`,
      'other=ABCDEFGHIJK-abcdefghijklmnopqrstuv',
    ]) {
      expect(paramMatcherMatches(matcher, landing(query)), query).toBe(false);
    }
  });

  it('matches when ANY of the values fits', () => {
    expect(paramMatcherMatches(matcher, landing(`siteID=4&siteID=${RAKUTEN_SHAPED}`))).toBe(true);
  });

  it('compiles each pattern source once, not per URL', () => {
    const before = patternCacheSizeForTests();
    const unique = { ...matcher, value: '^once-[a-z]{3}$' };
    for (let i = 0; i < 50; i += 1) {
      paramMatcherMatches(unique, landing(`siteID=once-abc&n=${i}`));
    }
    expect(patternCacheSizeForTests()).toBe(before + 1);
    // And it is the same compiled object every time, not a recompile.
    expect(compiledPattern('^once-[a-z]{3}$')).toBe(compiledPattern('^once-[a-z]{3}$'));
  });

  it('a pattern that would fail validation never matches (fails toward standing down for self-exemptions)', () => {
    for (const value of ['^(unclosed$', 'no-anchors', '^only-start', 'only-end$', `^${'a'.repeat(300)}$`]) {
      expect(paramMatcherMatches({ name: 'siteID', match: 'pattern', value }, landing('siteID=no-anchors'))).toBe(false);
    }
  });
});

describe("validatePolicy: 'pattern' safety", () => {
  it.each([
    ['does not compile', '^(unclosed$'],
    ['is not anchored at the start', 'abc$'],
    ['is not anchored at the end', '^abc'],
    ['ends with an escaped dollar, not an anchor', '^abc\\$'],
    ['is longer than 256 characters', `^${'a'.repeat(256)}$`],
  ])('rejects a pattern that %s', (_label, value) => {
    expect(() => validatePolicy(sitePolicy(value))).toThrow(/pattern/i);
  });

  it('rejects an example longer than 512 characters (keeps validation cheap)', () => {
    const withExample = (example: string): StanddownPolicy => ({
      ...sitePolicy('^.*.{250}x$'),
      detection: {
        landingParams: [{ anyOf: [{ allOf: [{ name: 'siteID', match: 'pattern', value: '^.*.{250}x$', example }] }] }],
        cookiePatterns: [],
      },
    });
    expect(() => validatePolicy(withExample(`${'a'.repeat(511)}x`))).not.toThrow();
    const started = Date.now();
    expect(() => validatePolicy(withExample('a'.repeat(1_000_000)))).toThrow(/longer than 512/);
    expect(Date.now() - started).toBeLessThan(50);
  });

  it('rejects a pattern matcher without a value', () => {
    const policy = sitePolicy(RAKUTEN_SITE_ID) as StanddownPolicy & {
      detection: { landingParams: { anyOf: { allOf: { name: string; match: string }[] }[] }[] };
    };
    const broken = JSON.parse(JSON.stringify(policy));
    delete broken.detection.landingParams[0].anyOf[0].allOf[0].value;
    expect(() => validatePolicy(broken)).toThrow();
  });

  it('accepts an anchored, compilable pattern within the length limit', () => {
    expect(() => validatePolicy(sitePolicy(RAKUTEN_SITE_ID))).not.toThrow();
  });

  it('a policy with a rejected pattern fails the decision closed', async () => {
    const session = new StanddownSession(new MemoryStateStore());
    await expect(
      session.ingest({ url: 'https://shop.example/', now: 0 }, [sitePolicy('unanchored')]),
    ).resolves.toMatchObject({ standDown: true, reason: expect.stringMatching(/^malformed-policy/) });
  });

  it.each([
    // Nested or grouped repeats and alternation (catastrophic backtracking).
    ['^(a+)+$'],
    ['^(a*)*$'],
    ['^(\\w+)*x$'],
    ['^(a{1,})+$'],
    ['^(\\d+){2,}$'],
    ['^(a|aa)+$'],
    ['^((ab)+)+$'],
    ['^(?:a+)+$'],
    ['^(?<x>a|b)*$'],
    ['^[^](a+)+$'],
    ['^[](a+)+$'],
    // Repeats side by side, and chains of choices: slow without any nesting.
    ['^a*a*$'],
    ['^a*a*a*a*$'],
    ['^\\w+\\w+$'],
    ['^.*.*$'],
    ['^a?a?a?a?a?$'],
    ['^[a-z]+-[0-9]{2,4}$'],
    [`^${'(a|a)'.repeat(22)}$`],
    ['^a|b$'],
    // Backreferences and other escapes outside the subset.
    ['^(a)\\1$'],
    ['^\\1a$'],
    ['^\\k<x>a$'],
    ['^\\ba$'],
    ['^\\u0041$'],
    // Lazy or stacked counts, and classes the subset doesn't guess at.
    ['^a+?$'],
    ['^a{2}{3}$'],
    ['^a{3,2}$'],
    ['^[]a]$'],
    ['^[^]$'],
    ['^[a\\1]$'],
    ['^a]$'],
  ])('rejects %s (outside the fast subset)', (value) => {
    expect(() => validatePolicy(sitePolicy(value))).toThrow(/pattern/i);
    // And it never matches at runtime either (e.g. as a selfPatterns entry).
    expect(paramMatcherMatches({ name: 'siteID', match: 'pattern', value }, landing(`siteID=${'a'.repeat(40)}!`))).toBe(false);
  });

  it('accepts single characters with fixed counts and at most one variable repeat', () => {
    for (const value of [
      '^[a-z]+$',
      '^.+$',
      '^\\d{4}$',
      '^[a-z]{2,4}-[0-9]{3}$',
      '^[(+]+$',
      '^\\(a+\\)$',
      '^[\\]]+$',
      '^a{2}b{3}c?$',
      '^brand_[0-9]{4}$',
      '^[^-]+-x$',
      RAKUTEN_SITE_ID,
    ]) {
      expect(() => validatePolicy(sitePolicy(value)), value).not.toThrow();
    }
  });

  it('every accepted pattern stays fast on a long hostile value (exhaustive over short patterns)', () => {
    const tokens = ['a', '\\d', '.', '[a-]', '[^b]', '-', '+', '*', '?', '{2}', '{1,3}', '(', '|', ']'];
    const inputs = ['a'.repeat(511), `${'a'.repeat(510)}!`, `${'-a'.repeat(255)}!`, '1'.repeat(511)];
    let accepted = 0;
    let slowest = 0;
    const walk = (body: string, depth: number) => {
      const source = `^${body}$`;
      if (body !== '' && patternProblem(source) === undefined) {
        accepted += 1;
        const re = new RegExp(source);
        // Fastest of three runs: ignores one-off JIT warm-up, keeps real backtracking.
        let best = Infinity;
        for (let run = 0; run < 3; run += 1) {
          const started = performance.now();
          for (const input of inputs) re.test(input);
          best = Math.min(best, performance.now() - started);
        }
        slowest = Math.max(slowest, best);
      }
      if (depth === 0) return;
      for (const token of tokens) walk(body + token, depth - 1);
    };
    walk('', 4);
    // Deeper, over the tokens that build stacked repeats (`a*a*a*`).
    tokens.splice(0, tokens.length, 'a', '.', '*', '?', '+');
    walk('', 6);
    expect(accepted).toBeGreaterThan(1_000);
    expect(slowest).toBeLessThan(10);
  });

  it('bounds the input: a value over 512 characters never matches a pattern', () => {
    const value = '^[a-z]+$';
    expect(paramMatcherMatches({ name: 'siteID', match: 'pattern', value }, landing(`siteID=${'a'.repeat(512)}`))).toBe(true);
    const started = Date.now();
    expect(paramMatcherMatches({ name: 'siteID', match: 'pattern', value }, landing(`siteID=${'a'.repeat(513)}`))).toBe(false);
    expect(Date.now() - started).toBeLessThan(50);
  });

  it('a URL repeating the param more than 16 times stands down without testing every value', async () => {
    // Slowest shape the subset allows: one variable stretch, a long fixed tail.
    const slowest = `^.*a${'.{99}'.repeat(40)}$`;
    expect(patternProblem(slowest)).toBeUndefined();
    const flood = `?${Array.from({ length: 3_000 }, () => `siteID=${'b'.repeat(512)}`).join('&')}`;
    const started = performance.now();
    await expect(
      new StanddownSession(new MemoryStateStore()).ingest(
        { url: `https://shop.example/${flood}`, now: 0 },
        [sitePolicy(slowest)],
      ),
    ).resolves.toMatchObject({ standDown: true, policyId: 'pattern-test' });
    expect(performance.now() - started).toBeLessThan(500);
    // Up to 16 values are each tested as usual.
    expect(paramMatcherMatches(matcher, landing(`${'siteID=4&'.repeat(15)}siteID=${RAKUTEN_SHAPED}`), true)).toBe(true);
    expect(paramMatcherMatches(matcher, landing('siteID=4&'.repeat(16)), true)).toBe(false);
  });

  it('a self-exemption never applies past 16 values of its param', () => {
    const own: SelfExemption = { name: 'my_click_id', match: 'pattern', value: '^brand_[0-9]{4}$', networkId: 'pattern-net' };
    const many = `${'my_click_id=x&'.repeat(16)}my_click_id=brand_1234`;
    expect(paramMatcherMatches(own, exactParams(new URLSearchParams(many)))).toBe(false);
    expect(
      detect({ url: `https://shop.example/?siteID=${RAKUTEN_SHAPED}&${many}`, now: 0, selfPatterns: [own] }, [
        sitePolicy(RAKUTEN_SITE_ID),
      ]).strongest?.policyId,
    ).toBe('pattern-test');
  });

  it('no lint noise for a valid pattern', () => {
    expect(lintPolicies([sitePolicy(RAKUTEN_SITE_ID)])).toEqual([]);
  });
});

describe("'pattern' behaves the same in every entry point", () => {
  const policies = [sitePolicy(RAKUTEN_SITE_ID)];
  const shaped = `https://shop.example/?siteID=${RAKUTEN_SHAPED}`;
  const unrelated = 'https://shop.example/?siteid=4';

  it('detect', () => {
    expect(detect({ url: shaped, now: 0 }, policies).strongest?.policyId).toBe('pattern-test');
    expect(detect({ url: unrelated, now: 0 }, policies).strongest).toBeUndefined();
  });

  it('relay capture', () => {
    const capture = (href: string) =>
      captureLanding({
        policies,
        now: () => 0,
        sendMessage: () => true,
        window: { location: { href }, document: { referrer: '' } },
      })?.record.matches;
    expect(capture(shaped)).toEqual([{ policyId: 'pattern-test', params: ['siteID'] }]);
    expect(capture(unrelated)).toEqual([]);
  });

  it('relay background: a pattern-matched param the page stripped still stands down', async () => {
    const relay = createRelayStanddown({ policies, chrome: { storage: { local: area(), session: area() } }, now: () => 0 });
    await relay.ingestCapture(
      7,
      { v: 1, host: 'shop.example', at: 1_000, matches: [{ policyId: 'pattern-test', params: ['siteID'] }] },
      1_000,
    );
    await expect(relay.shouldStandDown(7, 'https://shop.example/', 1_100)).resolves.toMatchObject({
      standDown: true,
      policyId: 'pattern-test',
      matchKind: 'landing',
    });
    // On another shop, an unrelated siteID still in the URL must not stand down
    // (the replay copy accepts only the placeholder, not any value).
    await expect(relay.shouldStandDown(8, 'https://other.example/?siteid=4', 1_100)).resolves.toMatchObject({
      standDown: false,
    });
  });

  it('content adapter signals → session', async () => {
    const decide = async (href: string) => {
      const signals = collectContentSignals({
        window: { location: { href }, document: { referrer: '', cookie: '' } },
        now: () => 0,
      });
      return new StanddownSession(new MemoryStateStore()).ingest(signals, policies);
    };
    await expect(decide(shaped)).resolves.toMatchObject({ standDown: true, policyId: 'pattern-test' });
    await expect(decide(unrelated)).resolves.toMatchObject({ standDown: false });
  });

  it('a selfPatterns entry with match: pattern exempts its network (exact name case)', () => {
    const own: SelfExemption[] = [
      { name: 'my_click_id', match: 'pattern', value: '^brand_[0-9]{4}$', networkId: 'pattern-net' },
    ];
    const ours = detect({ url: `${shaped}&my_click_id=brand_1234`, now: 0, selfPatterns: own }, policies);
    expect(ours.selfMatch).toBe(true);
    expect(ours.strongest).toBeUndefined();

    const notOurs = detect({ url: `${shaped}&my_click_id=brand_12`, now: 0, selfPatterns: own }, policies);
    expect(notOurs.strongest?.policyId).toBe('pattern-test');
    // Own-click names stay exact-case.
    expect(paramMatcherMatches(own[0] as never, exactParams(new URLSearchParams('MY_CLICK_ID=brand_1234')))).toBe(false);
  });
});

function area() {
  const data: Record<string, unknown> = {};
  return {
    get(keys: unknown, cb?: (items: Record<string, unknown>) => void) {
      const names = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(data);
      const items: Record<string, unknown> = {};
      for (const n of names) if (n in data) items[n] = structuredClone(data[n]);
      cb?.(items);
      return undefined;
    },
    set(items: Record<string, unknown>, cb?: () => void) {
      Object.assign(data, structuredClone(items));
      cb?.();
      return undefined;
    },
    remove(keys: string | string[], cb?: () => void) {
      for (const k of [keys].flat()) delete data[k];
      cb?.();
      return undefined;
    },
  };
}
