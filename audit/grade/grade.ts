/** Grade a single unpacked extension. Also runnable as a CLI. */
import type { StanddownPolicy } from 'standdown';
import { allPolicies } from 'standdown/policies';
import { loadExtension } from './browser.ts';
import { runAudit } from './harness.ts';
import { grade, type GradeResult } from './rubric.ts';
import type { ScenarioObservation } from './harness.ts';
import { resolvePolicies, policySourceLabel } from '../fixtures/resolvePolicies.ts';

export interface AuditReport {
  result: GradeResult;
  observations: ScenarioObservation[];
}

export async function gradeExtension(
  extPath: string,
  policies: readonly StanddownPolicy[] = allPolicies,
): Promise<AuditReport> {
  const ext = await loadExtension(extPath);
  try {
    const { observations, server } = await runAudit(ext.context, policies);
    await server.close();
    return { result: grade(observations), observations };
  } finally {
    await ext.close();
  }
}

async function main() {
  const extPath = process.argv[2];
  if (!extPath) {
    console.error(
      'usage: tsx grade/grade.ts <path-to-unpacked-extension>\n' +
        '  POLICY_PACK=<module>  grade against your own policy pack (default: standdown bundled packs)',
    );
    process.exit(2);
  }
  const policies = await resolvePolicies();
  console.log(`\n  policy source: ${policySourceLabel()}`);
  const { result, observations } = await gradeExtension(extPath, policies);
  console.log(`\n  standdown grade: ${result.letter}  (${result.score}/100)`);
  console.log(`  ${result.note}\n`);
  for (const o of observations) {
    const tag = o.passed ? 'ok  ' : o.expectedIntroduce ? 'MISS' : 'HIJACK';
    console.log(`  [${tag}] ${o.scenario.id.padEnd(34)} ${o.evidence}`);
  }
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
