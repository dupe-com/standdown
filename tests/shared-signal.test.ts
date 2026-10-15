import { describe, expect, it } from 'vitest';
import {
  detect,
  MemoryStateStore,
  type SelfExemption,
  StanddownSession,
  type StanddownState,
  type StateStore,
  validatePolicy,
} from '../src';
import { collectContentSignals } from '../src/content';
import { allPolicies, cjPolicy, impactPolicy, universalPolicy } from '../src/policies';
import { createRelayStanddown } from '../src/relay/background';
import { captureLanding } from '../src/relay/capture';
import { ChromeLocalStateStore, type ChromeStorageAreaLike } from '../src/stores';

// The host's own CJ click, marked by its own param and scoped to CJ.
const ownCj: SelfExemption[] = [{ name: 'my_click_id', value: 'own', match: 'equals', networkId: 'cj' }];
const shop = 'https://merchant.example';
const ownClickUrl = `${shop}/?cjevent=xyz&my_click_id=own&afsrc=1`;

const lifting = (store: StateStore = new MemoryStateStore()) =>
  new StanddownSession(store, { selfClickLift: 'same-network' });

describe('afsrc=1 is a shared signal', () => {
  it('is marked shared in cj, impact and universal (and only there)', () => {
    for (const policy of allPolicies) {
      const sharedNames = (policy.detection.landingParams ?? []).flatMap((rule) =>
        rule.anyOf.flatMap((group) =>
          group.allOf.filter((matcher) => 'shared' in matcher && matcher.shared).map((m) => m.name),
        ),
      );
      const expected = ['cj', 'impact', 'universal'].includes(policy.id) ? ['afsrc'] : [];
      expect(sharedNames, policy.id).toEqual(expected);
    }
    expect(universalPolicy.detection.redirectDomains.filter((rule) => 'shared' in rule)).toHaveLength(1);
  });

  it('still stands down on its own, and the decision says it rests only on a shared signal', async () => {
    const decision = await new StanddownSession(new MemoryStateStore()).ingest(
      { url: `${shop}/?afsrc=1`, now: 0 },
      allPolicies,
    );
    expect(decision).toMatchObject({ standDown: true, matchedParams: ['afsrc'], sharedOnly: true });
  });

  it("is explained by the host's own scoped click in the same URL", async () => {
    expect(detect({ url: ownClickUrl, now: 0, selfPatterns: ownCj }, allPolicies).strongest).toBeUndefined();
    await expect(
      new StanddownSession(new MemoryStateStore()).ingest(
        { url: ownClickUrl, now: 0, selfPatterns: ownCj },
        allPolicies,
      ),
    ).resolves.toMatchObject({ standDown: false, reason: 'self-exempted-no-active-standdown' });
  });

  it("does not hide another network's own signal next to the own click", async () => {
    const decision = await new StanddownSession(new MemoryStateStore()).ingest(
      { url: `${ownClickUrl}&irclickid=abc`, now: 0, selfPatterns: ownCj },
      allPolicies,
    );
    expect(decision).toMatchObject({ standDown: true, policyId: 'impact', matchedParams: ['irclickid'] });
    expect(decision.sharedOnly).toBeUndefined();
  });

  it('an unscoped own-click pattern does not explain it', () => {
    const unscoped: SelfExemption[] = [{ name: 'my_click_id', value: 'own', match: 'equals' }];
    expect(
      detect({ url: `${shop}/?my_click_id=own&afsrc=1`, now: 0, selfPatterns: unscoped }, allPolicies).strongest,
    ).toBeDefined();
  });

  it('reports every matched param name, never values', async () => {
    const decision = await new StanddownSession(new MemoryStateStore()).ingest(
      { url: `${shop}/?cjevent=secret-value&afsrc=1`, now: 0 },
      [cjPolicy, impactPolicy],
    );
    expect(decision).toMatchObject({ standDown: true, policyId: 'cj' });
    expect([...(decision.matchedParams ?? [])].sort()).toEqual(['afsrc', 'cjevent']);
    expect(decision.sharedOnly).toBeUndefined();
    expect(JSON.stringify(decision)).not.toContain('secret-value');
  });

  it('a later lookup of an earlier stand-down carries no matched params', async () => {
    const session = new StanddownSession(new MemoryStateStore());
    await session.ingest({ url: `${shop}/?afsrc=1`, now: 0 }, allPolicies);
    const later = await session.ingest({ url: `${shop}/cart`, now: 1_000 }, allPolicies);
    expect(later.standDown).toBe(true);
    expect(later.matchedParams).toBeUndefined();
    expect(later.sharedOnly).toBeUndefined();
  });

  it('webRequest redirect chain: the landing URL with afsrc=1 is explained by the own click too', () => {
    // (universal has its own non-shared rule for cjevent, so this landing omits it.)
    const ownLanding = `${shop}/?my_click_id=own&afsrc=1`;
    const chain = ['https://click.example/out', ownLanding];
    expect(
      detect({ url: ownLanding, redirectChain: chain, now: 0, selfPatterns: ownCj }, [cjPolicy, universalPolicy])
        .strongest,
    ).toBeUndefined();
    const competitor = `${shop}/?afsrc=1`;
    const found = detect({ url: competitor, redirectChain: [competitor], now: 0 }, [universalPolicy]);
    expect(found.matched.every((match) => match.sharedOnly === true)).toBe(true);
    expect(found.strongest).toBeDefined();
  });

  it('rejects a non-boolean shared flag', () => {
    const broken = JSON.parse(JSON.stringify(impactPolicy));
    broken.detection.landingParams[0].anyOf[0].allOf[0].shared = 'yes';
    expect(() => validatePolicy(broken)).toThrow(/shared/);
  });
});

describe('content adapter with shared signals', () => {
  const decide = (href: string) =>
    new StanddownSession(new MemoryStateStore()).ingest(
      {
        ...collectContentSignals({
          window: { location: { href }, document: { referrer: '', cookie: '' } },
          now: () => 0,
        }),
        selfPatterns: ownCj,
      },
      allPolicies,
    );

  it('own click with afsrc=1 activates; afsrc=1 alone stands down, marked shared-only', async () => {
    await expect(decide(ownClickUrl)).resolves.toMatchObject({ standDown: false, degraded: true });
    await expect(decide(`${shop}/?afsrc=1`)).resolves.toMatchObject({
      standDown: true,
      matchedParams: ['afsrc'],
      sharedOnly: true,
    });
  });
});

describe('selfClickLift with shared signals', () => {
  it("lifts a competitor's CJ click that carried afsrc=1 (the shared part names no network)", async () => {
    const session = lifting();
    await session.ingest({ url: `${shop}/?cjevent=abc&afsrc=1`, now: 0 }, allPolicies);

    await expect(
      session.ingest({ url: ownClickUrl, now: 1_000, selfPatterns: ownCj, selfClickAt: 1_000 }, allPolicies),
    ).resolves.toMatchObject({ standDown: false, reason: 'self-click-lifted' });
  });

  it('never lifts a stand-down that rests only on afsrc=1', async () => {
    const session = lifting();
    await session.ingest({ url: `${shop}/?afsrc=1`, now: 0 }, allPolicies);

    await expect(
      session.ingest({ url: ownClickUrl, now: 1_000, selfPatterns: ownCj, selfClickAt: 1_000 }, allPolicies),
    ).resolves.toMatchObject({ standDown: true });
  });

  it("does not lift when another network's own signal fed the stand-down", async () => {
    const session = lifting();
    await session.ingest({ url: `${shop}/?cjevent=abc&irclickid=def&afsrc=1`, now: 0 }, allPolicies);

    await expect(
      session.ingest({ url: ownClickUrl, now: 1_000, selfPatterns: ownCj, selfClickAt: 1_000 }, allPolicies),
    ).resolves.toMatchObject({ standDown: true });
  });

  it('a network stays specific once it matched on its own signal, even if later only afsrc=1 is seen', async () => {
    const session = lifting();
    await session.ingest({ url: `${shop}/?irclickid=def`, now: 0 }, allPolicies);
    await session.ingest({ url: `${shop}/?cjevent=abc&afsrc=1`, now: 500 }, allPolicies);

    await expect(
      session.ingest({ url: ownClickUrl, now: 1_000, selfPatterns: ownCj, selfClickAt: 1_000 }, allPolicies),
    ).resolves.toMatchObject({ standDown: true });
  });

  it.each([
    ['afsrc=1 alone, then a competitor CJ click', [`${shop}/?afsrc=1`, `${shop}/?cjevent=abc`]],
    ['a competitor CJ click, then afsrc=1 alone', [`${shop}/?cjevent=abc`, `${shop}/?afsrc=1`]],
  ])('never lifts once a separate landing carried afsrc=1 alone: %s', async (_label, landings) => {
    const session = lifting();
    await session.ingest({ url: landings[0] as string, now: 0 }, allPolicies);
    await session.ingest({ url: landings[1] as string, now: 500 }, allPolicies);

    await expect(
      session.ingest({ url: ownClickUrl, now: 1_000, selfPatterns: ownCj, selfClickAt: 1_000 }, allPolicies),
    ).resolves.toMatchObject({ standDown: true });
  });

  it('records shared-only contributors, and they survive a save and reload', async () => {
    const local = new FakeChromeStorageArea();
    const store = new ChromeLocalStateStore(local, { sessionId: 's1', now: () => 0 });
    await lifting(store).ingest({ url: `${shop}/?cjevent=abc&afsrc=1`, now: 0 }, allPolicies);

    const saved = (await store.load()) as StanddownState;
    const record = saved.sessions['merchant.example'];
    expect([...(record?.sharedOnlyPolicyIds ?? [])].sort()).toEqual(['impact', 'universal']);

    await expect(
      lifting(new ChromeLocalStateStore(local, { sessionId: 's1', now: () => 1_000 })).ingest(
        { url: ownClickUrl, now: 1_000, selfPatterns: ownCj, selfClickAt: 1_000 },
        allPolicies,
      ),
    ).resolves.toMatchObject({ standDown: false, reason: 'self-click-lifted' });
  });

  it('a record saved without the field (an older release) is never lifted through universal', async () => {
    const store = new MemoryStateStore();
    await lifting(store).ingest({ url: `${shop}/?cjevent=abc&afsrc=1`, now: 0 }, allPolicies);
    const state = (await store.load()) as StanddownState;
    const record = state.sessions['merchant.example'];
    if (record) delete record.sharedOnlyPolicyIds;
    await store.save(state);

    await expect(
      lifting(store).ingest({ url: ownClickUrl, now: 1_000, selfPatterns: ownCj, selfClickAt: 1_000 }, allPolicies),
    ).resolves.toMatchObject({ standDown: true });
  });
});

describe('relay capture with shared signals', () => {
  const capture = (href: string, selfPatterns?: SelfExemption[]) =>
    captureLanding({
      policies: allPolicies,
      ...(selfPatterns ? { selfPatterns } : {}),
      now: () => 0,
      sendMessage: () => true,
      window: { location: { href }, document: { referrer: '' } },
    })?.record.matches;

  it('keeps afsrc=1 on a plain landing', () => {
    expect(capture(`${shop}/?afsrc=1`)).toEqual([
      { policyId: 'cj', params: ['afsrc'] },
      { policyId: 'impact', params: ['afsrc'] },
      { policyId: 'universal', params: ['afsrc'] },
    ]);
  });

  it("drops afsrc=1 when the same URL carries the host's own click", () => {
    expect(capture(ownClickUrl, ownCj)).toEqual([]);
    expect(capture(`${ownClickUrl}&irclickid=abc`, ownCj)).toEqual([{ policyId: 'impact', params: ['irclickid'] }]);
  });
});

describe('relay background reports matched params', () => {
  it('a stripped afsrc=1 stands down, named and marked shared-only', async () => {
    const relay = createRelayStanddown({
      policies: allPolicies,
      chrome: { storage: { local: callbackArea(), session: callbackArea() } },
      now: () => 0,
    });
    await relay.ingestCapture(
      3,
      { v: 1, host: 'merchant.example', at: 1_000, matches: [{ policyId: 'impact', params: ['afsrc'] }] },
      1_000,
    );
    await expect(relay.shouldStandDown(3, `${shop}/`, 1_100)).resolves.toMatchObject({
      standDown: true,
      matchKind: 'landing',
      matchedParams: ['afsrc'],
      sharedOnly: true,
    });
  });
});

describe('relay background: own click after a landing with afsrc=1', () => {
  const ownCapture = { v: 1 as const, host: 'merchant.example', at: 2_000, matches: [], self: ['cj'] };
  const run = async (first: { policyId: string; params: string[] }[], queryBetween: boolean) => {
    const relay = createRelayStanddown({
      policies: allPolicies,
      selfPatterns: ownCj,
      selfClickLift: 'same-network',
      chrome: { storage: { local: callbackArea(), session: callbackArea() } },
      now: () => 0,
    });
    await relay.ingestCapture(4, { v: 1, host: 'merchant.example', at: 1_000, matches: first }, 1_000);
    if (queryBetween) await relay.shouldStandDown(4, `${shop}/`, 1_500);
    await relay.ingestCapture(4, ownCapture, 2_000);
    return relay.shouldStandDown(4, `${shop}/`, 2_100);
  };
  const competitorCj = [
    { policyId: 'cj', params: ['cjevent', 'afsrc'] },
    { policyId: 'impact', params: ['afsrc'] },
    { policyId: 'universal', params: ['afsrc'] },
  ];
  const afsrcAlone = [
    { policyId: 'cj', params: ['afsrc'] },
    { policyId: 'impact', params: ['afsrc'] },
    { policyId: 'universal', params: ['afsrc'] },
  ];

  it.each([false, true])("clears a competitor's CJ click that carried afsrc=1 (queried between: %s)", async (q) => {
    await expect(run(competitorCj, q)).resolves.toMatchObject({ standDown: false });
  });

  it.each([false, true])('keeps a stand-down from afsrc=1 alone (queried between: %s)', async (q) => {
    await expect(run(afsrcAlone, q)).resolves.toMatchObject({ standDown: true });
  });

  it.each([
    ['still in the URL', `${shop}/b?my_click_id=own`],
    ['already stripped', `${shop}/b`],
  ])('afsrc=1 alone from an earlier landing still stands down after our click (own param %s)', async (_label, url) => {
    const relay = createRelayStanddown({
      policies: allPolicies,
      selfPatterns: ownCj,
      selfClickLift: 'same-network',
      chrome: { storage: { local: callbackArea(), session: callbackArea() } },
      now: () => 0,
    });
    await relay.ingestCapture(5, { v: 1, host: 'merchant.example', at: 1_000, matches: afsrcAlone }, 1_000);
    await relay.ingestCapture(5, ownCapture, 2_000);
    await expect(relay.shouldStandDown(5, url, 2_100)).resolves.toMatchObject({
      standDown: true,
      matchKind: 'landing',
      sharedOnly: true,
    });
  });

  it.each([
    ['afsrc=1 alone first', [afsrcAlone, [{ policyId: 'cj', params: ['cjevent'] }]]],
    ['competitor CJ first', [[{ policyId: 'cj', params: ['cjevent'] }], afsrcAlone]],
  ] as const)('a separate afsrc=1-alone landing survives our click after a competitor CJ click (%s)', async (_l, [a, b]) => {
    const relay = createRelayStanddown({
      policies: allPolicies,
      selfPatterns: ownCj,
      selfClickLift: 'same-network',
      chrome: { storage: { local: callbackArea(), session: callbackArea() } },
      now: () => 0,
    });
    await relay.ingestCapture(6, { v: 1, host: 'merchant.example', at: 1_000, matches: [...a] }, 1_000);
    await relay.ingestCapture(6, { v: 1, host: 'merchant.example', at: 1_500, matches: [...b] }, 1_500);
    await relay.ingestCapture(6, ownCapture, 2_000);
    for (const url of [`${shop}/b?my_click_id=own`, `${shop}/b`]) {
      await expect(relay.shouldStandDown(6, url, 2_100), url).resolves.toMatchObject({ standDown: true });
    }
  });

  it.each([`${shop}/b?my_click_id=own`, `${shop}/b`])(
    "lift off: our click in this URL never hides an earlier landing's competitor param (%s)",
    async (url) => {
      const relay = createRelayStanddown({
        policies: allPolicies,
        selfPatterns: ownCj,
        chrome: { storage: { local: callbackArea(), session: callbackArea() } },
        now: () => 0,
      });
      await relay.ingestCapture(
        9,
        { v: 1, host: 'merchant.example', at: 1_000, matches: [{ policyId: 'cj', params: ['cjevent'] }] },
        1_000,
      );
      await relay.ingestCapture(9, { v: 1, host: 'merchant.example', at: 2_000, matches: [] }, 2_000);
      await expect(relay.shouldStandDown(9, url, 2_100)).resolves.toMatchObject({
        standDown: true,
        policyId: 'cj',
        matchKind: 'landing',
      });
    },
  );

  it.each([false, true])("keeps it when another network's own param came too (queried between: %s)", async (q) => {
    await expect(run([...competitorCj, { policyId: 'impact', params: ['irclickid'] }], q)).resolves.toMatchObject({
      standDown: true,
    });
  });
});

function callbackArea() {
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

class FakeChromeStorageArea implements ChromeStorageAreaLike {
  readonly #data: Record<string, unknown> = {};

  async get(key: string): Promise<Record<string, unknown>> {
    return key in this.#data ? { [key]: structuredClone(this.#data[key]) } : {};
  }

  async set(items: Record<string, unknown>): Promise<void> {
    Object.assign(this.#data, structuredClone(items));
  }
}
