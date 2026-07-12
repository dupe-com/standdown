import type { Signals, StanddownPolicy } from 'standdown';
import { allPolicies } from 'standdown/policies';
import {
  DEMO_PUBLISHER_SITE,
  landingGroups,
  merchantHostFor,
  merchantLandingPathFor,
  redirectUrlFor,
  servedFor,
  type Mechanism,
  type ParamPair,
} from './packDerive';

/** Fixed clock so every scenario is deterministic. */
export const FIXED_NOW = 0;

export type ScenarioKind = 'attribution' | 'control-direct' | 'control-ownsite';

export interface Scenario {
  /** Stable id, e.g. `cj:attribution:cookie` or `amazon:control-direct`. */
  id: string;
  networkId: string;
  kind: ScenarioKind;
  /** Present only for attribution scenarios. */
  mechanism?: Mechanism;
  description: string;
  /**
   * Logical, host-accurate signals — fed to detect()/ingest() for the
   * in-process conformance path. Works regardless of the fixture host.
   */
  signals: Signals;
  /** Merchant path (with query) the browser path should land on. */
  landingPath: string;
  /** How the fixture server should seed this scenario for the browser path. */
  seed?: { affPath?: string; setCookies?: string[] };
  /** true for attribution, false for controls. */
  expectStandDown: boolean;
}

/**
 * Build the full fixture scenario matrix for the given policies. Each network
 * yields an attribution scenario per detection mechanism it actually declares
 * (landing-param, cookie, redirect, afsrc), plus a direct-navigation control
 * and — for packs with initiator rules — an own-site-referrer control.
 */
export function buildScenarios(
  policies: readonly StanddownPolicy[] = allPolicies,
): Scenario[] {
  return policies.flatMap((policy) => scenariosForPolicy(policy));
}

function scenariosForPolicy(policy: StanddownPolicy): Scenario[] {
  const net = policy.network.id;
  const host = merchantHostFor(policy);
  const path = merchantLandingPathFor(policy);
  const merchantPath = `/merchant/${net}`;
  const { primary, afsrc } = landingGroups(policy);
  const out: Scenario[] = [];

  const attribution = (
    mechanism: Mechanism,
    signalPatch: Partial<Signals>,
    description: string,
  ): void => {
    const served = servedFor(policy, mechanism);
    out.push({
      id: `${net}:attribution:${mechanism}`,
      networkId: net,
      kind: 'attribution',
      mechanism,
      description,
      signals: {
        url: `https://${host}${path}`,
        now: FIXED_NOW,
        ...signalPatch,
      },
      landingPath: withParams(merchantPath, served.params),
      seed: {
        affPath: `/aff/${net}?kind=${mechanism}`,
        setCookies: served.cookies,
      },
      expectStandDown: true,
    });
  };

  // landing-param: attribution arrives as query params on the merchant URL.
  if (primary.length > 0) {
    attribution(
      'landing-param',
      { url: `https://${host}${path}${queryString(primary[0])}` },
      `${policy.network.name} attribution via landing param(s) ${nameList(primary[0])}`,
    );
  }

  // afsrc: the universal afsrc=1 stand-down flag, where the pack declares it.
  if (afsrc) {
    attribution(
      'afsrc',
      { url: `https://${host}${path}${queryString(afsrc)}` },
      `${policy.network.name} attribution via afsrc=1 universal flag`,
    );
  }

  // cookie: a prior first-party attribution cookie name is present.
  const cookieServed = servedFor(policy, 'cookie');
  if (cookieServed.cookies.length > 0) {
    attribution(
      'cookie',
      { cookieNames: cookieServed.cookies },
      `${policy.network.name} attribution via existing cookie ${cookieServed.cookies[0]}`,
    );
  }

  // redirect: a tracker hop is present in the redirect chain.
  const redirectUrl = redirectUrlFor(policy);
  if (redirectUrl) {
    attribution(
      'redirect',
      { redirectChain: [redirectUrl] },
      `${policy.network.name} attribution via redirect hop ${hostOf(redirectUrl)}`,
    );
  }

  // control-direct: plain navigation to the merchant, no attribution at all.
  out.push({
    id: `${net}:control-direct`,
    networkId: net,
    kind: 'control-direct',
    description: `${policy.network.name} direct navigation with no attribution`,
    signals: { url: `https://${host}${path}`, now: FIXED_NOW },
    landingPath: merchantPath,
    seed: { affPath: merchantPath },
    expectStandDown: false,
  });

  // control-ownsite: only meaningful where a pack has initiator/referrer rules;
  // an own-site referrer must NOT trigger a stand-down.
  if ((policy.detection.initiatorRules?.length ?? 0) > 0) {
    out.push({
      id: `${net}:control-ownsite`,
      networkId: net,
      kind: 'control-ownsite',
      description: `${policy.network.name} own-site referrer must not stand down`,
      signals: {
        url: `https://${host}${path}`,
        now: FIXED_NOW,
        referrer: `https://${DEMO_PUBLISHER_SITE}/review`,
        publisherSites: [DEMO_PUBLISHER_SITE],
      },
      landingPath: merchantPath,
      seed: { affPath: merchantPath },
      expectStandDown: false,
    });
  }

  return out;
}

function queryString(params: readonly ParamPair[]): string {
  if (params.length === 0) {
    return '';
  }
  const q = new URLSearchParams();
  for (const p of params) {
    q.set(p.name, p.value);
  }
  return `?${q.toString()}`;
}

function withParams(path: string, params: readonly ParamPair[]): string {
  return `${path}${queryString(params)}`;
}

function nameList(params: readonly ParamPair[]): string {
  return params.map((p) => p.name).join('+');
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
