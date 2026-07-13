/**
 * Generate a showcase submission JSON from a fresh grade. This is what the
 * `standdown-showcase` skill / one-liner calls after integration: it grades the
 * declared inputs, stamps the SHA, and writes showcase/submissions/<slug>.json.
 * The caller then runs `build.ts` and opens a PR; CI re-verifies from scratch.
 *
 * Config via env:
 *   SLUG            kebab-case id + filename stem (required)
 *   NAME            extension display name (required)
 *   URL             extension/site URL (optional)
 *   CWS_ID          Chrome Web Store id (optional; enables future live-verify)
 *   SUBMITTED_BY    github handle or name (required)
 *   POLICY_SET      allPolicies | allPolicies+experimental | custom  (default allPolicies)
 *   POLICIES_FILE   path to a JSON array of policies (required iff POLICY_SET=custom)
 *   DISABLE_HOSTS   comma-separated hosts (optional)
 *   DATE            YYYY-MM-DD (required — pass today's date; scripts have no clock)
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { conformanceGrade } from '../grade/conformance.ts';
import {
  inputsHash,
  resolveInputs,
  type PolicySet,
  type Submission,
} from './lib.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env: ${name}`);
  return v;
}

async function main(): Promise<void> {
  const policySet = (process.env.POLICY_SET ?? 'allPolicies') as PolicySet;
  const disableHosts = (process.env.DISABLE_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  const policies =
    policySet === 'custom'
      ? (JSON.parse(readFileSync(req('POLICIES_FILE'), 'utf8')) as Submission['policies'])
      : undefined;

  const base: Submission = {
    schemaVersion: 1,
    slug: req('SLUG'),
    extension: {
      name: req('NAME'),
      ...(process.env.URL ? { url: process.env.URL } : {}),
      ...(process.env.CWS_ID ? { chromeWebStoreId: process.env.CWS_ID } : {}),
    },
    submittedBy: req('SUBMITTED_BY'),
    policySet,
    ...(policies ? { policies } : {}),
    disableHosts,
    grade: { letter: '', score: 0 },
    inputsSha256: '',
    generatedWith: 'standdown',
    date: req('DATE'),
  };

  const inputs = resolveInputs(base);
  const { result } = await conformanceGrade({
    policies: inputs.policies,
    disableHosts: inputs.disableHosts,
  });

  const submission: Submission = {
    ...base,
    grade: { letter: result.letter, score: result.score },
    inputsSha256: inputsHash(inputs),
  };

  const outPath = join(REPO_ROOT, 'showcase', 'submissions', `${submission.slug}.json`);
  writeFileSync(outPath, `${JSON.stringify(submission, null, 2)}\n`, 'utf8');
  console.log(
    `  wrote ${outPath}\n  grade ${result.letter} (${result.score}) · ` +
      `sha256:${submission.inputsSha256.slice(0, 12)}\n` +
      `  next: npm run showcase:build && open a PR`,
  );
  if (result.letter === 'C' || result.score < 90) {
    console.error('  note: grade is below the showcase threshold (A-band) — CI will reject.');
  }
}

main();
