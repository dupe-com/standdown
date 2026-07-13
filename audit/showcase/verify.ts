/**
 * CI gate for the showcase (no writes). For every submission it:
 *   1. verifies the declared grade + SHA against a fresh recomputation, and
 *   2. asserts the committed card SVG and SHOWCASE.md byte-match what a clean
 *      regeneration produces.
 *
 * Because generation is deterministic, (2) means a hand-edited card or a
 * SHOWCASE.md that doesn't follow from the submissions fails here — the card is
 * always CI-authoritative. Exit non-zero on any failure.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import {
  type Entry,
  listSubmissions,
  loadSubmission,
  renderCard,
  renderShowcaseMd,
  verifySubmission,
} from './lib.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const SUBS_DIR = join(REPO_ROOT, 'showcase', 'submissions');
const CARDS_DIR = join(REPO_ROOT, 'showcase', 'cards');
const MD_PATH = join(REPO_ROOT, 'SHOWCASE.md');

function read(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

async function main(): Promise<void> {
  const entries: Entry[] = [];
  const problems: string[] = [];

  for (const { slug, path } of listSubmissions(SUBS_DIR)) {
    const submission = loadSubmission(path);
    if (submission.slug !== slug) {
      problems.push(`${slug}: slug field (${submission.slug}) must match filename`);
      continue;
    }
    const verdict = await verifySubmission(submission);
    if (!verdict.ok || !verdict.result || !verdict.computedSha) {
      problems.push(`${slug}:\n    - ${verdict.errors.join('\n    - ')}`);
      continue;
    }

    const committedCard = read(join(CARDS_DIR, `${slug}.svg`));
    if (committedCard !== renderCard(verdict.result)) {
      problems.push(
        `${slug}: committed card SVG does not match the regenerated card — ` +
          `run \`npm run showcase:build\` and commit the result (do not hand-edit cards).`,
      );
    }
    entries.push({ submission, result: verdict.result, computedSha: verdict.computedSha });
    console.log(`  ✓ ${slug}: ${verdict.result.letter} (${verdict.result.score})`);
  }

  if (read(MD_PATH) !== renderShowcaseMd(entries)) {
    problems.push('SHOWCASE.md is stale — run `npm run showcase:build` and commit it.');
  }

  if (problems.length > 0) {
    console.error(`\n  ✗ showcase verification failed:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    process.exit(1);
  }
  console.log(`\n  ✓ ${entries.length} submission(s) verified; cards + SHOWCASE.md are authoritative.`);
}

main();
