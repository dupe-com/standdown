/**
 * Showcase verification + generation library.
 *
 * The trust model in one sentence: because `conformanceGrade` and the grade card
 * are both deterministic, we never trust an adopter's claimed number — CI
 * *recomputes* the grade from the submitted policy inputs and *regenerates* the
 * card, and rejects anything that doesn't match. This module is the shared core
 * used by both `verify.ts` (CI gate) and `build.ts` (regenerate the gallery).
 *
 * A submission is a pure declaration of inputs (`policySet` + `disableHosts`) plus
 * the claimed grade and a SHA over the *resolved* inputs. Everything displayed —
 * the card SVG, the SHOWCASE.md row — is derived here from those inputs, so the
 * only thing an adopter controls is the inputs, and the grade follows from them.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validatePolicy, type StanddownPolicy } from 'standdown';
import { allPolicies, experimentalPolicies } from 'standdown/policies';
import { conformanceGrade } from '../grade/conformance.ts';
import { renderShareSvg, isShareable } from '../grade/share-card.ts';
import type { GradeResult } from '../grade/rubric.ts';

export type PolicySet = 'allPolicies' | 'allPolicies+experimental' | 'custom';

export interface Submission {
  schemaVersion: 1;
  slug: string;
  extension: { name: string; url?: string; chromeWebStoreId?: string };
  submittedBy: string;
  policySet: PolicySet;
  /** Required (and only allowed) when policySet === 'custom'. */
  policies?: StanddownPolicy[];
  disableHosts?: string[];
  grade: { letter: string; score: number };
  /** sha256 (hex) over the canonical JSON of the *resolved* inputs. */
  inputsSha256: string;
  generatedWith: string;
  date: string;
}

export interface ResolvedInputs {
  policies: readonly StanddownPolicy[];
  disableHosts: string[];
}

/** Resolve a submission's declared policy set to the concrete policy array. */
export function resolveInputs(submission: Submission): ResolvedInputs {
  const disableHosts = [...(submission.disableHosts ?? [])]
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean)
    .sort();

  switch (submission.policySet) {
    case 'allPolicies':
      return { policies: allPolicies, disableHosts };
    case 'allPolicies+experimental':
      return { policies: [...allPolicies, ...experimentalPolicies], disableHosts };
    case 'custom': {
      const policies = submission.policies ?? [];
      if (policies.length === 0) {
        throw new Error("policySet 'custom' requires a non-empty `policies` array");
      }
      for (const policy of policies) validatePolicy(policy);
      return { policies, disableHosts };
    }
    default:
      throw new Error(`unknown policySet: ${String(submission.policySet)}`);
  }
}

/** Recursively key-sorted JSON — a stable canonical form for hashing. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, canonicalize((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/** sha256 (hex) over the canonical resolved inputs — the submission fingerprint. */
export function inputsHash(inputs: ResolvedInputs): string {
  const canonical = JSON.stringify(
    canonicalize({ policies: inputs.policies, disableHosts: inputs.disableHosts }),
  );
  return createHash('sha256').update(canonical).digest('hex');
}

export interface VerifyResult {
  ok: boolean;
  errors: string[];
  result?: GradeResult;
  computedSha?: string;
}

/**
 * Verify a submission end-to-end: recompute the SHA and the grade from the
 * declared inputs, and require the result be genuinely shareable (A-band, no
 * hijack, not inert). Returns the recomputed GradeResult so callers can render
 * the authoritative card.
 */
export async function verifySubmission(submission: Submission): Promise<VerifyResult> {
  const errors: string[] = [];

  if (submission.schemaVersion !== 1) {
    return { ok: false, errors: [`unsupported schemaVersion: ${submission.schemaVersion}`] };
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(submission.slug)) {
    errors.push(`slug must be kebab-case: ${JSON.stringify(submission.slug)}`);
  }

  let inputs: ResolvedInputs;
  try {
    inputs = resolveInputs(submission);
  } catch (error) {
    return { ok: false, errors: [...errors, (error as Error).message] };
  }

  const computedSha = inputsHash(inputs);
  if (submission.inputsSha256 !== computedSha) {
    errors.push(
      `inputsSha256 mismatch — claimed ${submission.inputsSha256.slice(0, 12)}…, ` +
        `recomputed ${computedSha.slice(0, 12)}…. Re-run the submit tool.`,
    );
  }

  const { result } = await conformanceGrade({
    policies: inputs.policies,
    disableHosts: inputs.disableHosts,
  });

  if (result.letter !== submission.grade.letter || result.score !== submission.grade.score) {
    errors.push(
      `grade mismatch — claimed ${submission.grade.letter} (${submission.grade.score}), ` +
        `recomputed ${result.letter} (${result.score}).`,
    );
  }
  if (!isShareable(result)) {
    errors.push(
      `grade ${result.letter} (${result.score}) is not showcase-eligible — ` +
        `needs A-band, zero hijacks, and non-inert. ${result.note}`,
    );
  }

  return { ok: errors.length === 0, errors, result, computedSha };
}

// ── Reading + rendering ──────────────────────────────────────────────────────

export function loadSubmission(path: string): Submission {
  return JSON.parse(readFileSync(path, 'utf8')) as Submission;
}

export function listSubmissions(dir: string): { slug: string; path: string }[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => ({ slug: f.replace(/\.json$/, ''), path: join(dir, f) }));
}

/** The authoritative card SVG for a submission (from the recomputed result). */
export function renderCard(result: GradeResult): string {
  return renderShareSvg(result);
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export interface Entry {
  submission: Submission;
  result: GradeResult;
  computedSha: string;
}

/** Render the full SHOWCASE.md gallery from verified entries. */
export function renderShowcaseMd(entries: Entry[], cardsRelDir = 'showcase/cards'): string {
  const sorted = [...entries].sort(
    (a, b) => b.result.score - a.result.score || a.submission.slug.localeCompare(b.submission.slug),
  );

  const rows = sorted
    .map((e) => {
      const s = e.submission;
      const name = s.extension.url
        ? `[${esc(s.extension.name)}](${s.extension.url})`
        : esc(s.extension.name);
      const card = `${cardsRelDir}/${s.slug}.svg`;
      const cws = s.extension.chromeWebStoreId
        ? ` · [Chrome Web Store](https://chrome.google.com/webstore/detail/${s.extension.chromeWebStoreId})`
        : '';
      return [
        `### ${name} — ${e.result.letter} (${e.result.score}/100)`,
        '',
        `<img src="${card}" alt="standdown grade ${esc(e.result.letter)} for ${esc(s.extension.name)}" width="520">`,
        '',
        `✅ **Reproduced by standdown CI** · inputs \`sha256:${e.computedSha.slice(0, 12)}\` · ` +
          `${esc(s.policySet)} · submitted by ${esc(s.submittedBy)} · ${esc(s.date)}${cws}`,
        '',
      ].join('\n');
    })
    .join('\n');

  return `# 🛡️ Graded with standdown

Extensions that ran the [standdown](./README.md) affiliate conformance grader and
proved they stand down instead of hijacking existing attribution.

**Every grade here is reproduced by CI.** A submission declares only its policy
inputs; [\`showcase-verify.yml\`](./.github/workflows/showcase-verify.yml) re-runs
\`conformanceGrade\` on those inputs, regenerates the card, and rejects any
mismatch — so the number can't be faked and the card can't be hand-edited. See
[\`showcase/README.md\`](./showcase/README.md) to add yours (one prompt, one PR).

> The grade proves a policy configuration decides correctly. It does not by itself
> prove the *deployed* extension uses that configuration — live-extension
> verification (Chrome Web Store source) is a planned second tier.

---

${rows || '_No submissions yet — be the first: see [showcase/README.md](./showcase/README.md)._'}
`;
}
