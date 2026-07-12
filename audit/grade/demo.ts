/**
 * Discrimination demo: grade the three test doubles and prove the grade
 * separates disciplined stand-down (A) from a hijacker (F) from dead code
 * (inert cap). This is the end-to-end validation of the whole thesis.
 *
 * Run: npx tsx grade/demo.ts   (from audit/)
 */
import { gradeExtension } from './grade.ts';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TESTEXT = join(HERE, '..', 'testext');

const cases = [
  { name: 'synthetic-good  (stands down correctly)', path: join(TESTEXT, 'good'), expect: /^A/ },
  { name: 'synthetic-bad   (always hijacks)', path: join(TESTEXT, 'bad'), expect: /^F/ },
  { name: 'synthetic-inert (does nothing)', path: join(TESTEXT, 'inert'), expect: /inert/ },
];

async function main() {
  const rows: string[] = [];
  let allExpected = true;

  for (const c of cases) {
    const { result } = await gradeExtension(c.path);
    const ok = c.expect.test(result.letter);
    allExpected &&= ok;
    rows.push(
      `  ${c.name.padEnd(42)} ${result.letter.padEnd(12)} ${result.score.toString().padStart(3)}/100  ${ok ? '✓' : '✗ UNEXPECTED'}`,
    );
    rows.push(`      ${result.note}`);
    if (result.hijacks.length) {
      rows.push(`      hijacked: ${result.hijacks.map((h) => h.scenario.id).slice(0, 6).join(', ')}${result.hijacks.length > 6 ? ' …' : ''}`);
    }
  }

  console.log('\n=== STANDDOWN GRADE — DISCRIMINATION DEMO ===\n');
  console.log('  extension'.padEnd(46) + 'grade'.padEnd(12) + 'score   check');
  console.log(rows.join('\n'));
  console.log(`\n  VERDICT: ${allExpected ? 'GREEN — the grade discriminates as designed' : 'RED — a case graded unexpectedly'}\n`);
  process.exit(allExpected ? 0 : 1);
}

main().catch((e) => {
  console.error('demo crashed:', e);
  process.exit(2);
});
