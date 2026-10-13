import { describe, expect, it } from 'vitest';
import { MemoryStateStore, type SelfExemption, StanddownSession } from '../src';
import { awinPolicy, cjPolicy, universalPolicy } from '../src/policies';
import { createRelayStanddown, type RelayChromeLike } from '../src/relay/background';
import type { ChromeStorageAreaLike } from '../src/stores';

// Regression tests for the code-review findings on the selfClickLift PR.
const ownCj: SelfExemption[] = [{ name: 'cjevent', value: 'own', match: 'equals', policyId: 'cj' }];
const lifting = (extra: { sessionKey?: (url: string) => string | undefined } = {}) =>
  new StanddownSession(new MemoryStateStore(), { selfClickLift: 'same-network', ...extra });

describe('selfClickLift review findings', () => {
  it('never lifts a stand-down the universal catch-all fed (afsrc=1 from an unknown network)', async () => {
    // A policy set where afsrc=1 feeds only `universal` (CJ without its afsrc rule).
    const cjNoAfsrc = {
      ...cjPolicy,
      detection: {
        ...cjPolicy.detection,
        landingParams: cjPolicy.detection.landingParams.filter(
          (rule) => !rule.anyOf.some((g) => g.allOf.some((m) => m.name === 'afsrc')),
        ),
      },
    };
    const policies = [cjNoAfsrc, universalPolicy];
    const selfPatterns: SelfExemption[] = [
      ...ownCj,
      { name: 'cjevent', value: 'own', match: 'equals', networkId: 'universal' },
    ];
    const session = lifting();
    await session.ingest({ url: 'https://shop.example/?afsrc=1', now: 0 }, policies);

    await expect(
      session.ingest(
        { url: 'https://shop.example/?cjevent=own&afsrc=1', now: 1_000, selfPatterns, selfClickAt: 1_000 },
        policies,
      ),
    ).resolves.toMatchObject({ standDown: true });
  });

  it('never lifts a disabled-host stand-down filed under a sessionKey bucket from another host', async () => {
    const blocked = {
      ...cjPolicy,
      detection: { ...cjPolicy.detection, disableHosts: [{ pattern: 'shop.example', kind: 'suffix' as const }] },
    };
    const group = () => 'example-group';
    const session = lifting({ sessionKey: group });
    await session.ingest({ url: 'https://shop.example/', now: 0 }, [blocked]);

    await session.ingest(
      { url: 'https://help.example/?cjevent=own', now: 1_000, selfPatterns: ownCj, selfClickAt: 1_000 },
      [blocked],
    );
    await expect(session.shouldStandDown('example-group', 1_500)).resolves.toMatchObject({ standDown: true });
  });

  it('inactivity-window networks: recorded activity after the own click does not block the lift', async () => {
    const ownAwin: SelfExemption[] = [{ name: 'my_click_id', value: 'own_awin', match: 'equals', networkId: 'awin' }];
    const session = lifting();
    await session.ingest({ url: 'https://shop.example/?awc=1_abc', now: 0 }, [awinPolicy]);
    await session.recordActivity(2_000);

    await expect(
      session.liftForSelfClick({ url: 'https://shop.example/', policyIds: ['awin'], clickAt: 1_000, now: 3_000 }, [
        awinPolicy,
      ]),
    ).resolves.toBe(true);
    void ownAwin;
  });

  it("a cloned record doesn't share its policyIds list with the stored one", async () => {
    const store = new MemoryStateStore();
    const session = new StanddownSession(store);
    await session.ingest({ url: 'https://shop.example/?cjevent=abc', now: 0 }, [cjPolicy]);

    const loaded = await store.load();
    loaded?.sessions['shop.example']?.policyIds?.push('mutated');

    expect((await store.load())?.sessions['shop.example']?.policyIds).toEqual(['cj']);
  });
});

describe('saved state stays readable by older releases (rollback)', () => {
  it('only writes audit actions that v0.3.3 can parse, even with the lift on', async () => {
    const readableBy033 = ['ingest', 'shouldStandDown', 'recordActivity', 'refresh'];
    const session = lifting();
    await session.ingest({ url: 'https://shop.example/?cjevent=abc', now: 0 }, [cjPolicy]);
    await session.ingest(
      { url: 'https://shop.example/?cjevent=own', now: 1_000, selfPatterns: ownCj, selfClickAt: 1_000 },
      [cjPolicy],
    );
    await session.liftForSelfClick(
      { url: 'https://shop.example/', policyIds: ['cj'], clickAt: 1_500, now: 2_000 },
      [cjPolicy],
    );
    await session.recordActivity(3_000);

    const actions = (await session.exportAuditLog()).map((entry) => entry.action);
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.every((action) => readableBy033.includes(action))).toBe(true);
  });
});

describe('relay review findings', () => {
  const capture = (self?: string[]) => ({
    type: 'standdown:relay:capture',
    record: {
      v: 1,
      host: 'shop.example',
      at: 1_000,
      matches: [{ policyId: 'cj', params: ['cjevent'] }],
      ...(self ? { self } : {}),
    },
  });

  it('forgets a tab even on a storage area without remove()', async () => {
    const area = new NoRemoveArea();
    const relay = createRelayStanddown({ policies: [cjPolicy], chrome: fakeChrome(area), now: () => 1_000 });
    await relay.handleMessage(capture(), { tab: { id: 7 }, frameId: 0, url: 'https://shop.example/' });
    await expect(relay.landingFor(7, 1_000)).resolves.toBeDefined();

    await relay.forgetTab(7);
    await expect(relay.landingFor(7, 1_000)).resolves.toBeUndefined();
  });

  it("without sender.url, falls back to the tab's URL and drops an unverifiable own click", async () => {
    const relay = createRelayStanddown({
      policies: [cjPolicy],
      chrome: fakeChrome(new NoRemoveArea()),
      selfClickLift: 'same-network',
      now: () => 1_000,
    });

    // Tab URL says another host: rejected.
    await expect(
      relay.handleMessage(capture(), { tab: { id: 7, url: 'https://other.example/' }, frameId: 0 }),
    ).resolves.toEqual({ ok: false });
    // No URL at all: referral matches kept (safe), own click dropped (unsafe to trust).
    await expect(relay.handleMessage(capture(['cj']), { tab: { id: 8 }, frameId: 0 })).resolves.toEqual({ ok: true });
    const landing = await relay.landingFor(8, 1_000);
    expect(landing?.matches).toEqual([{ policyId: 'cj', params: ['cjevent'] }]);
    expect(landing).not.toHaveProperty('self');
  });

  it('tries the lift once per own click, not on every query', async () => {
    const relay = createRelayStanddown({
      policies: [cjPolicy],
      chrome: fakeChrome(new NoRemoveArea()),
      selfClickLift: 'same-network',
      now: () => 1_000,
    });
    await relay.handleMessage(
      { type: 'standdown:relay:capture', record: { v: 1, host: 'shop.example', at: 1_000, matches: [], self: ['cj'] } },
      { tab: { id: 7 }, frameId: 0, url: 'https://shop.example/' },
    );
    for (const at of [1_100, 1_200, 1_300]) await relay.shouldStandDown(7, 'https://shop.example/', at);

    const lifts = (await relay.session.exportAuditLog()).filter((entry) =>
      entry.decision?.reason?.startsWith('self-click-'),
    );
    expect(lifts).toHaveLength(1);
    expect(await relay.landingFor(7, 1_300)).not.toHaveProperty('self');
  });
});

class NoRemoveArea implements ChromeStorageAreaLike {
  readonly data = new Map<string, unknown>();
  get(keys?: string | string[] | Record<string, unknown> | null, callback?: (items: Record<string, unknown>) => void) {
    const names = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : [...this.data.keys()];
    const items: Record<string, unknown> = {};
    for (const name of names) if (this.data.has(name)) items[name] = structuredClone(this.data.get(name));
    callback?.(items);
    return undefined;
  }
  set(items: Record<string, unknown>, callback?: () => void) {
    for (const [key, value] of Object.entries(structuredClone(items))) this.data.set(key, value);
    callback?.();
    return undefined;
  }
}

function fakeChrome(session: ChromeStorageAreaLike): RelayChromeLike {
  return { storage: { session, local: new NoRemoveArea() } };
}
