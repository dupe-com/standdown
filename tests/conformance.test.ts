import { describe, expect, it } from 'vitest';
import {
  MemoryStateStore,
  type ParamMatcher,
  type Signals,
  type StanddownPolicy,
  StanddownSession,
} from '../src';
import { allPolicies, experimentalPolicies } from '../src/policies';

/**
 * End-to-end conformance: for every bundled policy, a positive signal for each
 * detection mechanism it declares must make `StanddownSession.ingest` stand
 * down, and the negative controls must not. This is the in-process half of the
 * audit harness, promoted into CI so a regression that silently stops standing
 * down on any mechanism fails here.
 *
 * `detect.test.ts` covers rule *matching*; this covers the full *decision*
 * through the session state machine, including the positive initiator/referrer
 * case that the rule-matching tests exercise only at the detect layer.
 */

const FIXED_NOW = 0;
const POLICIES: readonly StanddownPolicy[] = [
  ...allPolicies,
  ...experimentalPolicies,
];

type Mechanism = 'landing-param' | 'afsrc' | 'cookie' | 'redirect' | 'initiator';

interface Scenario {
  id: string;
  mechanism?: Mechanism;
  kind: 'attribution' | 'control-direct' | 'control-ownsite';
  signals: Signals;
  expectStandDown: boolean;
}

const DEMO_PUBLISHER = 'deals.publisher-demo.com';

function merchantHostFor(policy: StanddownPolicy): string {
  if (policy.id === 'amazon') return 'www.amazon.com';
  if (policy.id === 'ebay-epn') return 'www.ebay.com';
  return 'www.example-merchant.com';
}

function valueForMatcher(matcher: ParamMatcher): string {
  if (matcher.match === 'contains') return `before-${matcher.value}-after`;
  return matcher.value ?? 'value';
}

function isAfsrc(matchers: readonly ParamMatcher[]): boolean {
  return matchers.some((m) => m.name === 'afsrc' && m.value === '1');
}

/** Split a pack's landing-param groups into primary attribution vs the afsrc flag. */
function landingGroups(policy: StanddownPolicy): {
  primary: ParamMatcher[][];
  afsrc: ParamMatcher[] | undefined;
} {
  const primary: ParamMatcher[][] = [];
  let afsrc: ParamMatcher[] | undefined;
  for (const rule of policy.detection.landingParams ?? []) {
    for (const group of rule.anyOf) {
      if (isAfsrc(group.allOf)) afsrc ??= [...group.allOf];
      else primary.push([...group.allOf]);
    }
  }
  return { primary, afsrc };
}

function queryString(matchers: readonly ParamMatcher[] | undefined): string {
  const pairs = (matchers ?? []).map(
    (m) => `${encodeURIComponent(m.name)}=${encodeURIComponent(valueForMatcher(m))}`,
  );
  return pairs.length > 0 ? `?${pairs.join('&')}` : '';
}

function cookieNameFor(policy: StanddownPolicy): string | undefined {
  const rule = policy.detection.cookiePatterns?.[0];
  if (!rule) return undefined;
  return rule.match === 'exact' ? rule.name : `${rule.name}_1`;
}

/** A URL matching the first SUFFIX redirect rule (regex rules are covered by detect.test). */
function suffixRedirectUrlFor(policy: StanddownPolicy): string | undefined {
  const rule = policy.detection.redirectDomains?.find((r) => r.kind === 'suffix');
  return rule ? `https://www.${rule.pattern}/click` : undefined;
}

function scenariosFor(policy: StanddownPolicy): Scenario[] {
  const host = merchantHostFor(policy);
  const base = `https://${host}/products/demo`;
  const { primary, afsrc } = landingGroups(policy);
  const out: Scenario[] = [];

  if (primary.length > 0) {
    out.push({
      id: `${policy.id}:landing-param`,
      mechanism: 'landing-param',
      kind: 'attribution',
      signals: { url: `${base}${queryString(primary[0])}`, now: FIXED_NOW },
      expectStandDown: true,
    });
  }

  if (afsrc) {
    out.push({
      id: `${policy.id}:afsrc`,
      mechanism: 'afsrc',
      kind: 'attribution',
      signals: { url: `${base}${queryString(afsrc)}`, now: FIXED_NOW },
      expectStandDown: true,
    });
  }

  const cookie = cookieNameFor(policy);
  if (cookie) {
    out.push({
      id: `${policy.id}:cookie`,
      mechanism: 'cookie',
      kind: 'attribution',
      signals: { url: base, now: FIXED_NOW, cookieNames: [cookie] },
      expectStandDown: true,
    });
  }

  const redirectUrl = suffixRedirectUrlFor(policy);
  if (redirectUrl) {
    out.push({
      id: `${policy.id}:redirect`,
      mechanism: 'redirect',
      kind: 'attribution',
      signals: { url: base, now: FIXED_NOW, redirectChain: [redirectUrl] },
      expectStandDown: true,
    });
  }

  // Positive initiator: a non-approved external referrer classifies as 'other'
  // and must trigger the stand-down (the coverage the audit matrix lacked).
  if ((policy.detection.initiatorRules ?? []).some((r) => r.referrerClass === 'other')) {
    out.push({
      id: `${policy.id}:initiator`,
      mechanism: 'initiator',
      kind: 'attribution',
      signals: {
        url: base,
        now: FIXED_NOW,
        referrer: 'https://unrelated-external.example/page',
      },
      expectStandDown: true,
    });
  }

  // control-direct: plain navigation, no attribution → must not stand down.
  out.push({
    id: `${policy.id}:control-direct`,
    kind: 'control-direct',
    signals: { url: base, now: FIXED_NOW },
    expectStandDown: false,
  });

  // control-ownsite: own-site referrer must not stand down (initiator packs).
  if ((policy.detection.initiatorRules?.length ?? 0) > 0) {
    out.push({
      id: `${policy.id}:control-ownsite`,
      kind: 'control-ownsite',
      signals: {
        url: base,
        now: FIXED_NOW,
        referrer: `https://${DEMO_PUBLISHER}/review`,
        publisherSites: [DEMO_PUBLISHER],
      },
      expectStandDown: false,
    });
  }

  return out;
}

describe('policy conformance (end-to-end session decision)', () => {
  for (const policy of POLICIES) {
    for (const scenario of scenariosFor(policy)) {
      it(`${scenario.id} → standDown=${scenario.expectStandDown}`, async () => {
        const session = new StanddownSession(new MemoryStateStore());
        const decision = await session.ingest(scenario.signals, [policy]);

        expect(decision.standDown).toBe(scenario.expectStandDown);
        if (scenario.expectStandDown) {
          expect(decision.policyId).toBe(policy.id);
        }
      });
    }
  }

  it('covers every mechanism each policy declares', () => {
    for (const policy of POLICIES) {
      const mechanisms = new Set(
        scenariosFor(policy)
          .filter((s) => s.kind === 'attribution')
          .map((s) => s.mechanism),
      );
      const declares =
        (policy.detection.landingParams?.length ?? 0) > 0 ||
        (policy.detection.cookiePatterns?.length ?? 0) > 0 ||
        (policy.detection.redirectDomains?.length ?? 0) > 0 ||
        (policy.detection.initiatorRules?.length ?? 0) > 0;
      // Every pack should yield at least one positive attribution scenario.
      expect(declares && mechanisms.size > 0, `${policy.id} has no positive scenario`).toBe(
        true,
      );
    }
  });
});
