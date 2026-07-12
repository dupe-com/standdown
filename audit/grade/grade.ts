/** Grade a single unpacked extension. Also runnable as a CLI. */
import { loadExtension } from './browser.ts';
import { runAudit } from './harness.ts';
import { grade, type GradeResult } from './rubric.ts';
import type { ScenarioObservation } from './harness.ts';

export interface AuditReport {
  result: GradeResult;
  observations: ScenarioObservation[];
}

export async function gradeExtension(extPath: string): Promise<AuditReport> {
  const ext = await loadExtension(extPath);
  try {
    const { observations, server } = await runAudit(ext.context);
    await server.close();
    return { result: grade(observations), observations };
  } finally {
    await ext.close();
  }
}

async function main() {
  const extPath = process.argv[2];
  if (!extPath) {
    console.error('usage: tsx grade/grade.ts <path-to-unpacked-extension>');
    process.exit(2);
  }
  const { result, observations } = await gradeExtension(extPath);
  console.log(`\n  standdown grade: ${result.letter}  (${result.score}/100)`);
  console.log(`  ${result.note}\n`);
  for (const o of observations) {
    const tag = o.passed ? 'ok  ' : o.expectedIntroduce ? 'MISS' : 'HIJACK';
    console.log(`  [${tag}] ${o.scenario.id.padEnd(34)} ${o.evidence}`);
  }
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
