/** Grade policy decisions directly, without loading a browser extension. */
import {
  MemoryStateStore,
  StanddownSession,
  type StanddownPolicy,
} from 'standdown';
import {
  buildScenarios,
  FIXED_NOW,
  type Scenario,
} from '../fixtures/scenarios.ts';
import {
  policySourceLabel,
  resolvePolicies,
} from '../fixtures/resolvePolicies.ts';
import type { ScenarioObservation } from './harness.ts';
import { grade, type GradeResult } from './rubric.ts';

export interface ConformanceInput {
  policies: readonly StanddownPolicy[];
  disableHosts?: readonly string[];
  extraScenarios?: readonly Scenario[];
  // selfPatterns are intentionally omitted: the generic matrix has no adopter
  // self-click scenarios. Supply those signals explicitly via extraScenarios.
}

export interface ConformanceReport {
  result: GradeResult;
  observations: ScenarioObservation[];
}

export async function conformanceGrade(
  input: ConformanceInput,
): Promise<ConformanceReport> {
  // Normalize to lowercase: URL hostnames are lowercased by the URL parser, so
  // an uppercase disable host (e.g. `EBAY.COM` from an env var) would otherwise
  // match neither the injected suffix policy nor the control reclassification.
  const disableHosts = (input.disableHosts ?? []).map((h) => h.toLowerCase());
  const scenarios = [
    ...buildScenarios(input.policies),
    ...disableHostScenarios(disableHosts),
    ...(input.extraScenarios ?? []),
  ].map((scenario) => reclassifyForDisableHosts(scenario, disableHosts));
  const policies = withDisableHosts(input.policies, disableHosts);
  const observations: ScenarioObservation[] = [];

  for (const scenario of scenarios) {
    const session = new StanddownSession(new MemoryStateStore());
    const decision = await session.ingest(scenario.signals, policies);
    const introducedAttribution = !decision.standDown;
    const expectedIntroduce = !scenario.expectStandDown;

    observations.push({
      scenario,
      introducedAttribution,
      expectedIntroduce,
      passed: introducedAttribution === expectedIntroduce,
      // ingest() decides stand-down only; whether activation is ultimately
      // allowed is a separate guardActivation() concern (e.g. activation.mode).
      evidence: decision.standDown ? 'stood down' : 'no stand-down',
    });
  }

  return { result: grade(observations), observations };
}

/**
 * A generic control scenario whose host the adopter has disabled must now be
 * expected to stand down — otherwise a correctly-disabled network (e.g. eBay)
 * reads as a failed activation and unfairly dings the grade.
 */
function reclassifyForDisableHosts(
  scenario: Scenario,
  hosts: readonly string[],
): Scenario {
  if (hosts.length === 0 || scenario.expectStandDown) return scenario;
  const host = hostOf(scenario.signals.url);
  if (host && hosts.some((h) => host === h || host.endsWith(`.${h}`))) {
    return { ...scenario, expectStandDown: true };
  }
  return scenario;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function disableHostScenarios(hosts: readonly string[]): Scenario[] {
  return hosts.map((host) => ({
    id: `${host}:disable-host`,
    networkId: 'disable-host',
    kind: 'attribution',
    description: `${host} is disabled by the adopter`,
    signals: { url: `https://${host}/`, now: FIXED_NOW },
    landingPath: '/',
    expectStandDown: true,
  }));
}

/** Represent adapter-level disable hosts in the same policy engine being graded. */
function withDisableHosts(
  policies: readonly StanddownPolicy[],
  hosts: readonly string[],
): readonly StanddownPolicy[] {
  if (hosts.length === 0) return policies;

  const disablePolicy: StanddownPolicy = {
    id: 'conformance-adopter-disable-hosts',
    schemaVersion: 3,
    policyVersion: '1.0.0',
    network: { id: 'disable-host', name: 'Adopter disabled hosts' },
    detection: {
      disableHosts: hosts.map((host) => ({ pattern: host, kind: 'suffix' })),
    },
    standdown: {
      scope: 'advertiser',
      sessionRule: 'session-or-min',
      minDurationMs: 0,
      behaviors: [
        'suppress-prompts',
        'no-cookie-write',
        'no-redirect',
        'no-background-tracking',
      ],
    },
    activation: { mode: 'never' },
    metadata: {
      sourceUrl: 'https://github.com/dupe-com/standdown',
      lastVerified: '1970-01-01',
      notes: 'Synthetic audit-only policy for adopter-declared disable hosts.',
    },
  };

  return [...policies, disablePolicy];
}

async function main(): Promise<void> {
  const policies = await resolvePolicies();
  const disableHosts = (process.env.DISABLE_HOSTS ?? '')
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean);

  console.log(`\n  policy source: ${policySourceLabel()}`);
  const report = await conformanceGrade({ policies, disableHosts });
  const { result, observations } = report;

  console.log(
    `\n  standdown conformance grade: ${result.letter}  (${result.score}/100)`,
  );
  console.log(`  ${result.note}\n`);
  for (const observation of observations) {
    const tag = observation.passed
      ? 'ok  '
      : observation.expectedIntroduce
        ? 'MISS'
        : 'HIJACK';
    console.log(
      `  [${tag}] ${observation.scenario.id.padEnd(34)} ${observation.evidence}`,
    );
  }

  // CI gate: fail on every failure mode the grade encodes — an inert pack, any
  // hijack (activated where it must stand down), or an overall grade below the A
  // band. The score threshold is what catches MISSes (over-suppression on
  // positive controls), which don't register as hijacks or inertness.
  const PASS_SCORE = 90; // A
  const ok =
    !result.inert && result.hijacks.length === 0 && result.score >= PASS_SCORE;
  process.exit(ok ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
