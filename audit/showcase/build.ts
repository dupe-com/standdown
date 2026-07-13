/**
 * Regenerate the showcase gallery from verified submissions:
 *   showcase/submissions/*.json  →  showcase/cards/*.svg  +  SHOWCASE.md
 *
 * Run locally (`npm run showcase:build`) after adding a submission, then commit
 * the generated card + SHOWCASE.md. CI (`verify.ts`) regenerates the same
 * artifacts and diffs them, so a hand-edited card or a faked grade is rejected.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import {
  type Entry,
  listSubmissions,
  loadSubmission,
  loadVerification,
  renderShowcaseCard,
  renderShowcaseMd,
  verifySubmission,
} from './lib.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const SUBS_DIR = join(REPO_ROOT, 'showcase', 'submissions');
const VERIFS_DIR = join(REPO_ROOT, 'showcase', 'verifications');
const CARDS_DIR = join(REPO_ROOT, 'showcase', 'cards');
const MD_PATH = join(REPO_ROOT, 'SHOWCASE.md');

async function main(): Promise<void> {
  mkdirSync(CARDS_DIR, { recursive: true });
  const entries: Entry[] = [];
  let failed = 0;

  for (const { slug, path } of listSubmissions(SUBS_DIR)) {
    const submission = loadSubmission(path);
    if (submission.slug !== slug) {
      console.error(`  ✗ ${slug}: slug field (${submission.slug}) must match filename`);
      failed++;
      continue;
    }
    const verification = loadVerification(VERIFS_DIR, slug);
    const verdict = await verifySubmission(submission, verification);
    if (!verdict.ok || !verdict.result || !verdict.computedSha || !verdict.tier) {
      console.error(`  ✗ ${slug}:\n${verdict.errors.map((e) => `      - ${e}`).join('\n')}`);
      failed++;
      continue;
    }
    writeFileSync(
      join(CARDS_DIR, `${slug}.svg`),
      renderShowcaseCard(verdict.result, verdict.tier),
      'utf8',
    );
    entries.push({
      submission,
      result: verdict.result,
      computedSha: verdict.computedSha,
      tier: verdict.tier,
      verification,
    });
    console.log(
      `  ✓ ${slug}: badge ${verdict.tier === 2 ? 'A+' : 'A'} · conformance ${verdict.result.letter} (${verdict.result.score})`,
    );
  }

  writeFileSync(MD_PATH, renderShowcaseMd(entries), 'utf8');
  console.log(`\n  wrote ${entries.length} card(s) + SHOWCASE.md`);

  if (failed > 0) {
    console.error(`\n  ${failed} submission(s) failed verification — not showcase-eligible.`);
    process.exit(1);
  }
}

main();
