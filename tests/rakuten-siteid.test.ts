import { describe, expect, it } from 'vitest';
import { detect, MemoryStateStore, StanddownSession, validatePolicy } from '../src';
import { allPolicies, rakutenPolicy } from '../src/policies';

// Rakuten passes the publisher's site ID as ranSiteID, and some advertisers as a
// plain siteID: 11 characters, a hyphen, 22 characters. Fake value, real shape.
const RAKUTEN_SHAPED = 'ABCDEFGHIJK-abcdefghijklmnopqrstuv';
const decide = (url: string) =>
  new StanddownSession(new MemoryStateStore()).ingest({ url, now: 0 }, allPolicies);

describe('rakutenPolicy: siteID counts only with a Rakuten-shaped value', () => {
  it('stands down on a Rakuten-shaped siteID, in any name casing', async () => {
    for (const name of ['siteID', 'siteid', 'SiteId']) {
      await expect(decide(`https://shop.example/?${name}=${RAKUTEN_SHAPED}`), name).resolves.toMatchObject({
        standDown: true,
        policyId: 'rakuten',
      });
    }
  });

  it("doesn't stand down on other siteID values", async () => {
    for (const value of ['4', 'abcdef000000', 'XY_00000_Example', 'abc-def', `${RAKUTEN_SHAPED}x`]) {
      await expect(decide(`https://shop.example/?siteID=${value}`), value).resolves.toMatchObject({ standDown: false });
    }
  });

  it('keeps the ranMID / ranEAID / ranSiteID groups as they were', () => {
    for (const query of ['ranMID=1&ranEAID=2&ranSiteID=3', 'ranEAID=2&ranSiteID=3', 'ranEAID=2', 'ranSiteID=anything']) {
      expect(detect({ url: `https://shop.example/?${query}`, now: 0 }, [rakutenPolicy]).strongest?.policyId, query).toBe(
        'rakuten',
      );
    }
  });

  it('ships a valid pattern with a matching example, and a bumped policy version', () => {
    expect(() => validatePolicy(rakutenPolicy)).not.toThrow();
    const group = rakutenPolicy.detection.landingParams
      .flatMap((rule) => rule.anyOf)
      .find((g) => g.allOf.some((m) => m.name === 'siteID'));
    expect(group?.allOf).toEqual([
      {
        name: 'siteID',
        match: 'pattern',
        value: '^[A-Za-z0-9/*_.]{11}-[A-Za-z0-9/*_.]{22}$',
        example: RAKUTEN_SHAPED,
      },
    ]);
    expect(rakutenPolicy.policyVersion).toBe('0.2.0');
  });
});
