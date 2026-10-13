import { describe, expect, it } from 'vitest';
import { MemoryStateStore, type SelfExemption, StanddownSession } from '../src';
import { cjPolicy, impactPolicy, rakutenPolicy } from '../src/policies';
import { ChromeLocalStateStore, type ChromeStorageAreaLike } from '../src/stores';

// The host's own CJ click: cjevent=own. Scoped to CJ, as selfPatterns must be.
const ownCj: SelfExemption[] = [
  { name: 'cjevent', value: 'own', match: 'equals', policyId: 'cj' },
];
const policies = [cjPolicy, impactPolicy, rakutenPolicy];
const shop = 'https://merchant.example';

const lifting = () =>
  new StanddownSession(new MemoryStateStore(), { selfClickLift: 'same-network' });

describe('selfClickLift', () => {
  it('is off by default: an own click never lifts an active stand-down', async () => {
    const session = new StanddownSession(new MemoryStateStore());
    await session.ingest({ url: `${shop}/?cjevent=abc`, now: 0 }, policies);

    await expect(
      session.ingest({ url: `${shop}/?cjevent=own`, now: 1_000, selfPatterns: ownCj }, policies),
    ).resolves.toMatchObject({ standDown: true, policyId: 'cj' });
  });

  it("lifts a competitor's earlier CJ stand-down when the shopper's latest CJ click is ours", async () => {
    const session = lifting();
    await session.ingest({ url: `${shop}/?cjevent=abc`, now: 0 }, policies);

    await expect(
      session.ingest({ url: `${shop}/?cjevent=own`, now: 1_000, selfPatterns: ownCj }, policies),
    ).resolves.toMatchObject({ standDown: false, reason: 'self-click-lifted' });

    // Stays lifted on later param-less pages.
    await expect(
      session.ingest({ url: `${shop}/cart`, now: 2_000, selfPatterns: ownCj }, policies),
    ).resolves.toMatchObject({ standDown: false });
  });

  it('a competitor referral after the lift stands down again', async () => {
    const session = lifting();
    await session.ingest({ url: `${shop}/?cjevent=abc`, now: 0 }, policies);
    await session.ingest({ url: `${shop}/?cjevent=own`, now: 1_000, selfPatterns: ownCj }, policies);

    await expect(
      session.ingest({ url: `${shop}/?cjevent=xyz`, now: 2_000, selfPatterns: ownCj }, policies),
    ).resolves.toMatchObject({ standDown: true, policyId: 'cj' });
  });

  it('never lifts another network: an own CJ click leaves an Impact stand-down alone', async () => {
    const session = lifting();
    await session.ingest({ url: `${shop}/?irclickid=abc`, now: 0 }, policies);

    await expect(
      session.ingest({ url: `${shop}/?cjevent=own`, now: 1_000, selfPatterns: ownCj }, policies),
    ).resolves.toMatchObject({ standDown: true, policyId: 'impact' });
  });

  it('never lifts a stand-down that several networks contributed to', async () => {
    const session = lifting();
    await session.ingest({ url: `${shop}/?cjevent=abc`, now: 0 }, policies);
    await session.ingest({ url: `${shop}/?irclickid=abc`, now: 500 }, policies);

    await expect(
      session.ingest({ url: `${shop}/?cjevent=own`, now: 1_000, selfPatterns: ownCj }, policies),
    ).resolves.toMatchObject({ standDown: true });
  });

  it('remembers every contributing network whatever order they arrive in', async () => {
    const session = lifting();
    await session.ingest({ url: `${shop}/?irclickid=abc`, now: 0 }, policies);
    await session.ingest({ url: `${shop}/?cjevent=abc`, now: 500 }, policies);

    await expect(
      session.ingest({ url: `${shop}/?cjevent=own`, now: 1_000, selfPatterns: ownCj }, policies),
    ).resolves.toMatchObject({ standDown: true });
  });

  it('never lifts a stand-down saved before contributors were tracked', async () => {
    const store = new MemoryStateStore({
      sessions: {
        'merchant.example': {
          advertiserHost: 'merchant.example',
          policyId: 'cj',
          startedAt: 0,
          lastActivityAt: 0,
          sessionRule: 'session-or-min',
          minDurationMs: 3_600_000,
          behaviors: ['suppress-prompts'],
        },
      },
      auditLog: [],
    });
    const session = new StanddownSession(store, { selfClickLift: 'same-network' });

    await expect(
      session.ingest({ url: `${shop}/?cjevent=own`, now: 1_000, selfPatterns: ownCj }, policies),
    ).resolves.toMatchObject({ standDown: true, policyId: 'cj' });
  });

  it("with session scope, the lingering cookie our own Rakuten click set doesn't re-arm the lifted stand-down", async () => {
    const ownRakuten: SelfExemption[] = [
      { name: 'ranSiteID', value: 'own', match: 'equals', policyId: 'rakuten' },
    ];
    const session = new StanddownSession(new MemoryStateStore(), {
      selfClickLift: 'same-network',
      selfExemptionScope: 'session',
    });
    await session.ingest({ url: `${shop}/?ranSiteID=abc`, now: 0 }, policies);

    await expect(
      session.ingest({ url: `${shop}/?ranSiteID=own`, now: 1_000, selfPatterns: ownRakuten }, policies),
    ).resolves.toMatchObject({ standDown: false, reason: 'self-click-lifted' });

    // Next page: the lsclick_mid cookie is ours now. It must not stand us down.
    await expect(
      session.ingest(
        { url: `${shop}/cart`, now: 2_000, selfPatterns: ownRakuten, cookieNames: ['lsclick_mid12345'] },
        policies,
      ),
    ).resolves.toMatchObject({ standDown: false });
  });

  it('with a sessionKey, an own click on checkout.<shop> lifts the stand-down filed from www.<shop>', async () => {
    const base = (url: string) => new URL(url).hostname.split('.').slice(-2).join('.');
    const session = new StanddownSession(new MemoryStateStore(), {
      selfClickLift: 'same-network',
      sessionKey: base,
    });
    await session.ingest({ url: 'https://www.merchant.example/?cjevent=abc', now: 0 }, policies);

    await expect(
      session.ingest(
        { url: 'https://checkout.merchant.example/?cjevent=own', now: 1_000, selfPatterns: ownCj },
        policies,
      ),
    ).resolves.toMatchObject({ standDown: false, reason: 'self-click-lifted' });
  });

  it('with a sessionKey, liftForSelfClick finds the stand-down under the shared key', async () => {
    const base = (url: string) => new URL(url).hostname.split('.').slice(-2).join('.');
    const session = new StanddownSession(new MemoryStateStore(), {
      selfClickLift: 'same-network',
      sessionKey: base,
    });
    await session.ingest({ url: 'https://www.merchant.example/?cjevent=abc', now: 0 }, policies);

    await expect(
      session.liftForSelfClick(
        { url: 'https://checkout.merchant.example/', policyIds: ['cj'], clickAt: 1_000, now: 1_500 },
        policies,
      ),
    ).resolves.toBe(true);
  });

  it('does not lift when a competing param rides in the same URL', async () => {
    const session = lifting();
    await session.ingest({ url: `${shop}/?cjevent=abc`, now: 0 }, policies);

    await expect(
      session.ingest(
        { url: `${shop}/?cjevent=own&irclickid=abc`, now: 1_000, selfPatterns: ownCj },
        policies,
      ),
    ).resolves.toMatchObject({ standDown: true, policyId: 'impact' });
  });

  it('does not lift a referral that is newer than the own click', async () => {
    const session = lifting();
    await session.ingest({ url: `${shop}/?cjevent=abc`, now: 5_000 }, policies);

    // An own click observed earlier (e.g. relayed from another page) is older
    // than the competitor's referral, so the competitor keeps the stand-down.
    await expect(
      session.liftForSelfClick({ url: `${shop}/`, policyIds: ['cj'], clickAt: 1_000, now: 6_000 }, policies),
    ).resolves.toBe(false);
    await expect(session.shouldStandDown('merchant.example', 6_000)).resolves.toMatchObject({
      standDown: true,
    });
  });

  it('liftForSelfClick lifts an older same-network stand-down', async () => {
    const session = lifting();
    await session.ingest({ url: `${shop}/?cjevent=abc`, now: 0 }, policies);

    await expect(
      session.liftForSelfClick({ url: `${shop}/`, policyIds: ['cj'], clickAt: 1_000, now: 1_500 }, policies),
    ).resolves.toBe(true);
    await expect(session.shouldStandDown('merchant.example', 2_000)).resolves.toMatchObject({
      standDown: false,
    });
  });

  it('liftForSelfClick is a no-op when the option is off', async () => {
    const session = new StanddownSession(new MemoryStateStore());
    await session.ingest({ url: `${shop}/?cjevent=abc`, now: 0 }, policies);

    await expect(
      session.liftForSelfClick({ url: `${shop}/`, policyIds: ['cj'], clickAt: 1_000, now: 1_500 }, policies),
    ).resolves.toBe(false);
  });

  it('never lifts an unconditional disabled-host stand-down', async () => {
    const blocked = {
      ...cjPolicy,
      detection: { ...cjPolicy.detection, disableHosts: [{ pattern: 'merchant.example', kind: 'suffix' as const }] },
    };
    const session = lifting();

    await expect(
      session.ingest({ url: `${shop}/?cjevent=own`, now: 1_000, selfPatterns: ownCj }, [blocked]),
    ).resolves.toMatchObject({ standDown: true });
  });

  it('liftForSelfClick never lifts an unconditional disabled-host stand-down', async () => {
    const blocked = {
      ...cjPolicy,
      detection: { ...cjPolicy.detection, disableHosts: [{ pattern: 'merchant.example', kind: 'suffix' as const }] },
    };
    const session = lifting();
    await session.ingest({ url: `${shop}/`, now: 0 }, [blocked]);

    await expect(
      session.liftForSelfClick({ url: `${shop}/`, policyIds: ['cj'], clickAt: 1_000, now: 1_500 }, [blocked]),
    ).resolves.toBe(false);
  });

  it('keeps the contributing networks across a persisted reload, so the rules still hold', async () => {
    const local = new FakeChromeStorageArea();
    const at = (now: number) =>
      new StanddownSession(new ChromeLocalStateStore(local, { sessionId: 's1', now: () => now }), {
        selfClickLift: 'same-network',
      });

    await at(0).ingest({ url: `${shop}/?cjevent=abc`, now: 0 }, policies);
    await at(500).ingest({ url: `${shop}/?irclickid=abc`, now: 500 }, policies);

    // Reloaded from storage: still two contributors, so a CJ own click can't lift it.
    await expect(
      at(1_000).ingest({ url: `${shop}/?cjevent=own`, now: 1_000, selfPatterns: ownCj }, policies),
    ).resolves.toMatchObject({ standDown: true });
  });
});

class FakeChromeStorageArea implements ChromeStorageAreaLike {
  readonly data: Record<string, unknown> = {};

  get(
    keys?: string | string[] | Record<string, unknown> | null,
    callback?: (items: Record<string, unknown>) => void,
  ): undefined {
    const names = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(this.data);
    const items: Record<string, unknown> = {};
    for (const name of names) {
      if (name in this.data) items[name] = structuredClone(this.data[name]);
    }
    callback?.(items);
    return undefined;
  }

  set(items: Record<string, unknown>, callback?: () => void): undefined {
    Object.assign(this.data, structuredClone(items));
    callback?.();
    return undefined;
  }
}
