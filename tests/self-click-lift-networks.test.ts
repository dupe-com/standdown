import { describe, expect, it } from 'vitest';
import { MemoryStateStore, StanddownSession } from '../src';
import { allPolicies } from '../src/policies';

// The per-network selfPatterns example from INSTALL.md ("Setting up your
// own-click patterns, per network"), verbatim. If you change one, change both.
const selfPatterns = [
  { name: 'my_click_id', value: '_mybrand_cj', match: 'equals', networkId: 'cj' },
  { name: 'my_click_id', value: '_mybrand_impact', match: 'equals', networkId: 'impact' },
  { name: 'my_click_id', value: '_mybrand_awin', match: 'equals', networkId: 'awin' },
  { name: 'ranSiteID', value: 'YOUR_ENCRYPTED_ID-', match: 'contains', networkId: 'rakuten' },
  { name: 'campid', value: 'YOUR_CAMPAIGN_ID', match: 'equals', networkId: 'ebay-epn' },
] as const;

const lifting = () =>
  new StanddownSession(new MemoryStateStore(), { selfClickLift: 'same-network' });

// competitor: a rival's click on that network; own: the same network's click,
// carrying what identifies ours.
const networks = [
  { id: 'cj', competitor: 'https://shop.example/?cjevent=abc', own: 'https://shop.example/?cjevent=def&my_click_id=_mybrand_cj' },
  { id: 'impact', competitor: 'https://shop.example/?irclickid=abc', own: 'https://shop.example/?irclickid=def&my_click_id=_mybrand_impact' },
  { id: 'awin', competitor: 'https://shop.example/?awc=1_abc', own: 'https://shop.example/?awc=1_def&my_click_id=_mybrand_awin' },
  { id: 'rakuten', competitor: 'https://shop.example/?ranSiteID=OTHER_ID-abc', own: 'https://shop.example/?ranSiteID=YOUR_ENCRYPTED_ID-def' },
  { id: 'ebay-epn', competitor: 'https://www.ebay.com/itm/1?campid=5338000000&mkcid=1', own: 'https://www.ebay.com/itm/1?campid=YOUR_CAMPAIGN_ID&mkcid=1' },
] as const;

describe('selfClickLift with the documented per-network selfPatterns', () => {
  for (const network of networks) {
    it(`${network.id}: a competitor click stands down; our later click on ${network.id} lifts it`, async () => {
      const session = lifting();
      await expect(
        session.ingest({ url: network.competitor, now: 0, selfPatterns }, allPolicies),
      ).resolves.toMatchObject({ standDown: true });

      await expect(
        session.ingest({ url: network.own, now: 1_000, selfPatterns }, allPolicies),
      ).resolves.toMatchObject({ standDown: false, reason: 'self-click-lifted' });
    });
  }

  it("our CJ click doesn't lift an Awin competitor's stand-down", async () => {
    const session = lifting();
    await session.ingest({ url: 'https://shop.example/?awc=1_abc', now: 0, selfPatterns }, allPolicies);

    await expect(
      session.ingest(
        { url: 'https://shop.example/?cjevent=def&my_click_id=_mybrand_cj', now: 1_000, selfPatterns },
        allPolicies,
      ),
    ).resolves.toMatchObject({ standDown: true });
  });

  it("someone else's marker is not ours: no lift", async () => {
    const session = lifting();
    await session.ingest({ url: 'https://shop.example/?cjevent=abc', now: 0, selfPatterns }, allPolicies);

    await expect(
      session.ingest(
        { url: 'https://shop.example/?cjevent=def&my_click_id=_otherbrand', now: 1_000, selfPatterns },
        allPolicies,
      ),
    ).resolves.toMatchObject({ standDown: true });
  });

  it('a bare network click id never counts as ours', async () => {
    const session = lifting();
    await session.ingest({ url: 'https://shop.example/?cjevent=abc', now: 0, selfPatterns }, allPolicies);

    await expect(
      session.ingest({ url: 'https://shop.example/?cjevent=def', now: 1_000, selfPatterns }, allPolicies),
    ).resolves.toMatchObject({ standDown: true });
  });

  it('afsrc=1 is shared by CJ, Impact and universal: exempt an own click on all three, but never lift', async () => {
    // afsrc=1 says "some affiliate", not which network. Scope your CJ marker to
    // every policy that reads it so your own click isn't stood down...
    const withAfsrc = [
      ...selfPatterns,
      ...(['impact', 'universal'] as const).map((networkId) => ({
        name: 'my_click_id',
        value: '_mybrand_cj',
        match: 'equals' as const,
        networkId,
      })),
    ];
    const own = 'https://shop.example/?cjevent=def&afsrc=1&my_click_id=_mybrand_cj';

    await expect(
      new StanddownSession(new MemoryStateStore()).ingest(
        { url: own, now: 0, selfPatterns: withAfsrc },
        allPolicies,
      ),
    ).resolves.toMatchObject({ standDown: false });

    // ...but such a click claims more than one network, so it never lifts.
    const session = lifting();
    await session.ingest({ url: 'https://shop.example/?irclickid=abc&afsrc=1', now: 0, selfPatterns: withAfsrc }, allPolicies);
    await expect(
      session.ingest({ url: own, now: 1_000, selfPatterns: withAfsrc }, allPolicies),
    ).resolves.toMatchObject({ standDown: true });
  });

  it('a marker shared across networks is ambiguous: exempt, but never lifts', async () => {
    const shared = ['cj', 'awin'].map((networkId) => ({
      name: 'my_click_id',
      value: '_mybrand',
      match: 'equals' as const,
      networkId,
    }));
    const session = lifting();
    await session.ingest({ url: 'https://shop.example/?awc=1_abc', now: 0, selfPatterns: shared }, allPolicies);

    await expect(
      session.ingest(
        { url: 'https://shop.example/?cjevent=def&my_click_id=_mybrand', now: 1_000, selfPatterns: shared },
        allPolicies,
      ),
    ).resolves.toMatchObject({ standDown: true });
  });

});
