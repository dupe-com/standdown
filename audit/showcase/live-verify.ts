/**
 * Tier 2 live verification — fetch the published crx and prove it bundles the
 * graded policy set. Two modes:
 *
 *   write (default):  SLUG=<slug> DATE=<YYYY-MM-DD> npm run showcase:live-verify
 *     Reads showcase/submissions/<slug>.json, downloads the live crx, and on a
 *     match writes showcase/verifications/<slug>.json. The submitter commits it
 *     alongside their submission; `showcase:build` then renders an A+ card.
 *
 *   dry-run:           SLUG=<slug> CRX_FILE=<path> DATE=<YYYY-MM-DD> npm run showcase:live-verify
 *     Verifies against a LOCAL crx/zip instead of the Web Store — a pre-publish
 *     confidence check. Prints whether it WOULD reach A+ but writes no record,
 *     so an unpublished local build can't be passed off as live-verified.
 *
 *   check (CI):        CHECK=1 DATE=<YYYY-MM-DD> npm run showcase:live-verify
 *     For every committed verification record, re-downloads the live crx and
 *     asserts it STILL matches both the record's SHA and the submission's. This
 *     is the un-fakeable gate: a hand-written record fails here. No writes.
 *
 * DATE is required (scripts have no clock) — pass today's date.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { loadSubmission, type LiveVerification, type Submission } from './lib.ts';
import { fetchCrx, verifyLiveCrx } from './crx.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const SUBS_DIR = join(REPO_ROOT, 'showcase', 'submissions');
const VERIFS_DIR = join(REPO_ROOT, 'showcase', 'verifications');

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env: ${name}`);
  return v;
}

async function write(slug: string, date: string): Promise<void> {
  const subPath = join(SUBS_DIR, `${slug}.json`);
  if (!existsSync(subPath)) throw new Error(`no submission at ${subPath} — run showcase:submit first`);
  const submission = loadSubmission(subPath);

  // Dry-run: verify against a LOCAL crx/zip (a pre-publish confidence check).
  // It never writes a submittable record — only a real Web Store fetch does —
  // so a locally-built bundle can't be passed off as live-verified.
  const localCrx = process.env.CRX_FILE;
  if (localCrx) {
    if (!existsSync(localCrx)) throw new Error(`CRX_FILE not found: ${localCrx}`);
    const outcome = verifyLiveCrx({ crx: readFileSync(localCrx), submission, verifiedOn: date });
    if (!outcome.ok || !outcome.verification) {
      console.error(`  ✗ ${slug} (dry-run against ${localCrx}): ${outcome.reason}`);
      process.exit(1);
    }
    console.log(
      `  ✓ ${slug} (DRY-RUN): local bundle v${outcome.verification.crxVersion} bundles the graded set ` +
        `(${outcome.verification.method}) — this WOULD verify as Tier 2 / A+ once published.\n` +
        `  No record written. Publish to the Web Store, then re-run without CRX_FILE.`,
    );
    return;
  }

  if (!submission.extension.chromeWebStoreId) {
    throw new Error(
      `submission ${slug} has no extension.chromeWebStoreId — Tier 2 needs a published Web Store id`,
    );
  }

  console.log(`  fetching live crx for ${submission.extension.chromeWebStoreId}…`);
  const crx = await fetchCrx(submission.extension.chromeWebStoreId);
  const outcome = verifyLiveCrx({ crx, submission, verifiedOn: date });
  if (!outcome.ok || !outcome.verification) {
    console.error(`  ✗ ${slug}: ${outcome.reason}`);
    process.exit(1);
  }

  mkdirSync(VERIFS_DIR, { recursive: true });
  const outPath = join(VERIFS_DIR, `${slug}.json`);
  writeFileSync(outPath, `${JSON.stringify(outcome.verification, null, 2)}\n`, 'utf8');
  console.log(
    `  ✓ ${slug}: live crx v${outcome.verification.crxVersion} bundles the graded set ` +
      `(${outcome.verification.method}) → Tier 2 / A+\n  wrote ${outPath}\n` +
      `  next: npm run showcase:build && commit the submission + verification + card + SHOWCASE.md`,
  );
}

function listRecords(): { slug: string; record: LiveVerification }[] {
  if (!existsSync(VERIFS_DIR)) return [];
  return readdirSync(VERIFS_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => ({
      slug: f.replace(/\.json$/, ''),
      record: JSON.parse(readFileSync(join(VERIFS_DIR, f), 'utf8')) as LiveVerification,
    }));
}

async function check(date: string): Promise<void> {
  const records = listRecords();
  if (records.length === 0) {
    console.log('  no verification records to check.');
    return;
  }
  const problems: string[] = [];

  for (const { slug, record } of records) {
    if (record.slug !== slug) {
      problems.push(`${slug}: record slug (${record.slug}) must match filename`);
      continue;
    }
    const subPath = join(SUBS_DIR, `${slug}.json`);
    if (!existsSync(subPath)) {
      problems.push(`${slug}: verification record has no matching submission`);
      continue;
    }
    const submission: Submission = loadSubmission(subPath);
    if (record.matchedInputsSha256 !== submission.inputsSha256) {
      problems.push(
        `${slug}: record SHA ${record.matchedInputsSha256.slice(0, 12)}… ≠ submission SHA ` +
          `${submission.inputsSha256.slice(0, 12)}… — record does not match its submission`,
      );
      continue;
    }
    try {
      const crx = await fetchCrx(record.chromeWebStoreId);
      const outcome = verifyLiveCrx({ crx, submission, verifiedOn: date });
      if (!outcome.ok || !outcome.verification) {
        problems.push(`${slug}: live crx no longer matches — ${outcome.reason}`);
        continue;
      }
      if (outcome.verification.matchedInputsSha256 !== record.matchedInputsSha256) {
        problems.push(`${slug}: live-derived SHA differs from the committed record`);
        continue;
      }
      console.log(
        `  ✓ ${slug}: live crx v${outcome.verification.crxVersion} still bundles the graded set ` +
          `(${outcome.verification.method})`,
      );
    } catch (error) {
      problems.push(`${slug}: crx fetch/parse failed — ${(error as Error).message}`);
    }
  }

  if (problems.length > 0) {
    console.error(
      `\n  ✗ live verification failed:\n${problems.map((p) => `  - ${p}`).join('\n')}`,
    );
    process.exit(1);
  }
  console.log(`\n  ✓ ${records.length} live verification(s) confirmed against the published crx.`);
}

async function main(): Promise<void> {
  const date = req('DATE');
  if (process.env.CHECK === '1') {
    await check(date);
  } else {
    await write(req('SLUG'), date);
  }
}

main().catch((error) => {
  console.error(`  ✗ ${(error as Error).message}`);
  process.exit(1);
});
