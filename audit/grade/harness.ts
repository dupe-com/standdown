/**
 * Runs each fixture scenario against a loaded extension and observes the one
 * sensor that matters: did the extension INTRODUCE affiliate attribution?
 * (a redirect through an affiliate link). Expected ABSENT when prior attribution
 * exists (stand-down), PRESENT on the direct-nav control (allowed to earn it).
 *
 * The harness seeds attribution via `/aff/:net?kind=...`; an extension activates
 * via `/aff/:net?actor=...` (or a real network host). The `actor=` marker makes
 * the extension's action unambiguous and timing-independent vs. the seed.
 */
import type { BrowserContext } from 'playwright';
import type { StanddownPolicy } from 'standdown';
import { allPolicies } from 'standdown/policies';
import { createFixtureServer, type FixtureServer } from '../fixtures/server.ts';
import { buildScenarios, type Scenario } from '../fixtures/scenarios.ts';

const SETTLE_MS = 800;
const SCENARIO_TIMEOUT_MS = 8000; // hard ceiling per scenario; a wedged page op skips, never hangs
const VERBOSE = !!process.env.VERBOSE;
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : Infinity;

/** Reject after `ms` so a hung Playwright call (newPage/clearCookies/goto that
 * never settles under the headless MV3 wedge) degrades to a skipped scenario
 * instead of stalling the whole run. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timeout after ${ms}ms: ${label}`)), ms).unref(),
    ),
  ]);
}

export interface ScenarioObservation {
  scenario: Scenario;
  introducedAttribution: boolean; // the sensor
  expectedIntroduce: boolean; // false when stand-down expected, true for positive controls
  passed: boolean;
  evidence: string;
}

/**
 * An affiliate action initiated by the extension, not the harness seed. On the
 * local fixtures the unambiguous signal is a redirect through `/aff/?actor=…`
 * (the seed uses `?kind=…`). We deliberately do NOT use redirect-domain
 * fingerprinting here: the universal pack includes param-based regexes (e.g.
 * `[?&]afsrc=1`) that would false-match the seed's own attribution landing URL.
 */
function isExtensionActivation(url: string): boolean {
  try {
    const u = new URL(url);
    return u.pathname.startsWith('/aff/') && u.searchParams.has('actor');
  } catch {
    return false;
  }
}

async function runScenario(
  context: BrowserContext,
  base: string,
  scenario: Scenario,
): Promise<ScenarioObservation> {
  const expectedIntroduce = !scenario.expectStandDown;
  const startPath = scenario.seed?.affPath ?? scenario.landingPath;
  let page: Awaited<ReturnType<BrowserContext['newPage']>> | null = null;

  try {
    await withTimeout(context.clearCookies(), SCENARIO_TIMEOUT_MS, 'clearCookies'); // isolate scenarios sharing the fixture origin
    page = await withTimeout(context.newPage(), SCENARIO_TIMEOUT_MS, 'newPage');

    const affHits: string[] = [];
    page.on('request', (r) => {
      if (isExtensionActivation(r.url())) affHits.push(r.url());
    });

    // The extension may redirect immediately, so goto/lifecycle never settles —
    // don't wait on it; the request sensor captures the activation regardless.
    await page.goto(base + startPath, { waitUntil: 'commit', timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(SETTLE_MS);

    const introduced = affHits.length > 0;
    const evidence = introduced ? `activated ${new URL(affHits[0]).pathname}` : 'no affiliate action';

    if (VERBOSE) {
      console.log(`  · ${scenario.id.padEnd(34)} introduced=${introduced} expected=${expectedIntroduce} ${evidence}`);
    }

    return {
      scenario,
      introducedAttribution: introduced,
      expectedIntroduce,
      passed: introduced === expectedIntroduce,
      evidence,
    };
  } catch (err) {
    // A wedged page op: record as inconclusive (fails the scenario) and move on
    // rather than hanging the whole audit.
    const evidence = `skipped (${(err as Error).message})`;
    if (VERBOSE) console.log(`  · ${scenario.id.padEnd(34)} ${evidence}`);
    return { scenario, introducedAttribution: false, expectedIntroduce, passed: false, evidence };
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

export async function runAudit(
  context: BrowserContext,
  policies: readonly StanddownPolicy[] = allPolicies,
): Promise<{ observations: ScenarioObservation[]; server: FixtureServer }> {
  const server = await createFixtureServer(policies);
  const scenarios = buildScenarios(policies).slice(0, LIMIT);
  const observations: ScenarioObservation[] = [];
  let consecutiveSkips = 0;
  for (const scenario of scenarios) {
    const obs = await runScenario(context, server.url, scenario);
    observations.push(obs);
    consecutiveSkips = obs.evidence.startsWith('skipped') ? consecutiveSkips + 1 : 0;
    if (consecutiveSkips >= 2) {
      // Browser context is wedged (known headless-MV3 failure mode after N pages);
      // further scenarios would only accrue timeouts. Stop with what we have.
      if (VERBOSE) console.log(`  ! browser wedged after ${observations.length} scenarios — aborting run`);
      break;
    }
  }
  return { observations, server };
}
