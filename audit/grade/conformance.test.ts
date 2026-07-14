import { MemoryStateStore, StanddownSession } from 'standdown';
import { allPolicies } from 'standdown/policies';
import { describe, expect, it } from 'vitest';
import { FIXED_NOW } from '../fixtures/scenarios.ts';
import { conformanceGrade } from './conformance.ts';

describe('conformanceGrade', () => {
  it('grades the bundled policies in the A range', async () => {
    const { result } = await conformanceGrade({ policies: allPolicies });

    expect(result.inert).toBe(false);
    expect(result.standDownRate).toBe(1);
    expect(result.hijacks).toHaveLength(0);
    expect(result.letter).toMatch(/^A/);
  });

  it('stands down on a bare Rakuten ranEAID (the hijack gap) and grades it as a control', async () => {
    // A ranEAID-only landing is a real Rakuten click; the grader now exercises
    // it as a positive control derived from the policy's narrower anyOf group.
    const { result, observations } = await conformanceGrade({
      policies: allPolicies,
    });
    // Exact id — a prefix match would also catch the `ranEAID+ranSiteID`
    // control (emitted first) and pass even if the bare-ranEAID case regressed.
    const bareRanEaid = observations.find(
      ({ scenario }) =>
        scenario.id === 'rakuten:attribution:landing-group:ranEAID',
    );

    expect(bareRanEaid).toBeDefined();
    expect(bareRanEaid?.expectedIntroduce).toBe(false); // expects stand-down
    expect(bareRanEaid?.introducedAttribution).toBe(false); // actually stood down
    expect(bareRanEaid?.passed).toBe(true);
    expect(result.hijacks).toHaveLength(0);
    expect(result.letter).toMatch(/^A/);
  });

  it('grades adopter-declared disable hosts as stand-down scenarios', async () => {
    const { observations } = await conformanceGrade({
      policies: allPolicies,
      disableHosts: ['ebay.com'],
    });
    const observation = observations.find(
      ({ scenario }) => scenario.id === 'ebay.com:disable-host',
    );

    expect(observation).toBeDefined();
    expect(observation?.passed).toBe(true);
    expect(observation?.introducedAttribution).toBe(false);
    expect(observation?.evidence).toBe('stood down');
  });

  it('does not penalize generic controls on an adopter-disabled host', async () => {
    // eBay is an activatable control in the generic matrix; an adopter who
    // disables ebay.com must not be dinged for those controls standing down.
    const { result, observations } = await conformanceGrade({
      policies: allPolicies,
      disableHosts: ['ebay.com'],
    });
    const ebayControl = observations.find(
      ({ scenario }) => scenario.id === 'ebay-epn:control-direct',
    );

    expect(ebayControl?.introducedAttribution).toBe(false);
    expect(ebayControl?.expectedIntroduce).toBe(false); // reclassified as expected-stand-down
    expect(ebayControl?.passed).toBe(true);
    expect(result.letter).toMatch(/^A/);
    expect(result.hijacks).toHaveLength(0);
  });

  it('matches disable hosts case-insensitively', async () => {
    // URL hostnames are lowercased by the parser; an uppercase disable host
    // (e.g. from an env var) must still apply.
    const { observations } = await conformanceGrade({
      policies: allPolicies,
      disableHosts: ['EBAY.COM'],
    });
    const disableObs = observations.find(
      ({ scenario }) => scenario.id === 'ebay.com:disable-host',
    );

    expect(disableObs?.passed).toBe(true);
    expect(disableObs?.evidence).toBe('stood down');
  });
});

describe('StanddownSession persistence used by conformance adopters', () => {
  it('retains attribution for the same host but not a different host', async () => {
    const cjPolicy = allPolicies.find((policy) => policy.network.id === 'cj');
    expect(cjPolicy).toBeDefined();
    if (!cjPolicy) throw new Error('bundled CJ policy is missing');

    const session = new StanddownSession(new MemoryStateStore());

    await expect(
      session.ingest(
        { url: 'https://merchant.example/?cjevent=abc', now: FIXED_NOW },
        [cjPolicy],
      ),
    ).resolves.toMatchObject({ standDown: true });
    await expect(
      session.ingest(
        { url: 'https://merchant.example/', now: FIXED_NOW + 1 },
        [cjPolicy],
      ),
    ).resolves.toMatchObject({ standDown: true });
    await expect(
      session.ingest(
        { url: 'https://other.example/', now: FIXED_NOW + 1 },
        [cjPolicy],
      ),
    ).resolves.toMatchObject({ standDown: false });
  });
});
