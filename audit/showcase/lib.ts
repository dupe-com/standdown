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
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validatePolicy, type StanddownPolicy } from 'standdown';
import { allPolicies, experimentalPolicies } from 'standdown/policies';
import { conformanceGrade } from '../grade/conformance.ts';
import { renderShareSvg, isShareable } from '../grade/share-card.ts';
import type { GradeResult } from '../grade/rubric.ts';

export type PolicySet = 'allPolicies' | 'allPolicies+experimental' | 'custom';

/**
 * Verification tier — the trust level, encoded into the badge letter.
 *   Tier 1 (config-verified): CI reproduced the grade from the declared policy
 *     inputs. Badge caps at **A**.
 *   Tier 2 (live-verified): CI additionally confirmed the *published* extension
 *     bundles this policy set (Chrome Web Store / chrome-stats source). Badge **A+**.
 * Tier is CI-determined, never self-claimed.
 */
export type Tier = 1 | 2;

/** How a live verification recovered the shipped policy set from the crx. */
export type LiveVerifyMethod = 'manifest' | 'bundle-scan';

/**
 * A live-verification record (`showcase/verifications/<slug>.json`): evidence
 * that the *published* extension's crx bundles the exact graded policy set.
 * Produced by `live-verify.ts` (network) and re-checked by the live-verify CI
 * job. Tier 2 is granted offline iff `matchedInputsSha256` equals the paired
 * submission's `inputsSha256` — so build/verify stay deterministic, while the
 * SHA itself is un-fakeable (the network job re-derives it from the live crx).
 */
export interface LiveVerification {
  schemaVersion: 1;
  slug: string;
  chromeWebStoreId: string;
  /** How the shipped policy set was recovered from the crx. */
  method: LiveVerifyMethod;
  /** `version` field of the crx's own manifest.json at verification time. */
  crxVersion: string;
  /** sha256 of the resolved inputs recovered from the crx — must equal the submission's. */
  matchedInputsSha256: string;
  /** YYYY-MM-DD the live crx was fetched (scripts have no clock; passed in). */
  verifiedOn: string;
}

/**
 * Tier 2 iff a live-verification record exists AND the SHA it recovered from the
 * published crx matches this submission's declared inputs SHA. A record that
 * declares a non-matching (or absent) SHA leaves the entry at Tier 1. The record
 * itself is validated against the live crx by the network CI job, not here.
 */
export function determineTier(submission: Submission, verification?: LiveVerification | null): Tier {
  if (
    verification &&
    verification.slug === submission.slug &&
    verification.matchedInputsSha256 === submission.inputsSha256
  ) {
    return 2;
  }
  return 1;
}

export function tierBadge(tier: Tier): 'A' | 'A+' {
  return tier === 2 ? 'A+' : 'A';
}

export function tierLabel(tier: Tier): string {
  return tier === 2 ? 'Tier 2 · verified on live extension' : 'Tier 1 · config-verified';
}

function tierAccent(tier: Tier): string {
  return tier === 2 ? '#F5A623' : '#3FB950';
}

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

/**
 * A policy-set declaration in the shape both a submission and a crx's
 * `standdown.manifest.json` share: a named set, or an inline resolved array.
 */
export interface DeclaredInputs {
  policySet: PolicySet;
  policies?: StanddownPolicy[];
  disableHosts?: string[];
}

/**
 * Resolve a declared policy set (`policySet` + optional inline `policies` +
 * `disableHosts`) to the concrete, normalized policy array we hash. Shared by
 * submission verification and live-crx verification so a submission's SHA and a
 * crx-recovered SHA are computed identically.
 */
export function resolveDeclaredInputs(declared: DeclaredInputs): ResolvedInputs {
  const disableHosts = [...(declared.disableHosts ?? [])]
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean)
    .sort();

  switch (declared.policySet) {
    case 'allPolicies':
      return { policies: allPolicies, disableHosts };
    case 'allPolicies+experimental':
      return { policies: [...allPolicies, ...experimentalPolicies], disableHosts };
    case 'custom': {
      const policies = declared.policies ?? [];
      if (policies.length === 0) {
        throw new Error("policySet 'custom' requires a non-empty `policies` array");
      }
      for (const policy of policies) validatePolicy(policy);
      return { policies, disableHosts };
    }
    default:
      throw new Error(`unknown policySet: ${String(declared.policySet)}`);
  }
}

/** Resolve a submission's declared policy set to the concrete policy array. */
export function resolveInputs(submission: Submission): ResolvedInputs {
  return resolveDeclaredInputs(submission);
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
  tier?: Tier;
}

/**
 * Verify a submission end-to-end: recompute the SHA and the grade from the
 * declared inputs, and require the result be genuinely shareable (A-band, no
 * hijack, not inert). Returns the recomputed GradeResult so callers can render
 * the authoritative card.
 */
export async function verifySubmission(
  submission: Submission,
  verification?: LiveVerification | null,
): Promise<VerifyResult> {
  const errors: string[] = [];

  if (submission.schemaVersion !== 1) {
    return { ok: false, errors: [`unsupported schemaVersion: ${submission.schemaVersion}`] };
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(submission.slug)) {
    errors.push(`slug must be kebab-case: ${JSON.stringify(submission.slug)}`);
  }
  // Tier is CI-determined — a submission may not claim it.
  if ('tier' in submission || 'verification' in submission) {
    errors.push('remove `tier`/`verification` — the tier is determined by CI, not the submission');
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

  return {
    ok: errors.length === 0,
    errors,
    result,
    computedSha,
    tier: determineTier(submission, verification),
  };
}

// ── Reading + rendering ──────────────────────────────────────────────────────

export function loadSubmission(path: string): Submission {
  return JSON.parse(readFileSync(path, 'utf8')) as Submission;
}

export function listSubmissions(dir: string): { slug: string; path: string }[] {
  if (!existsSync(dir)) return []; // empty wall / fresh checkout
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => ({ slug: f.replace(/\.json$/, ''), path: join(dir, f) }));
}

/** Load a slug's live-verification record if one exists, else null. */
export function loadVerification(dir: string, slug: string): LiveVerification | null {
  const path = join(dir, `${slug}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as LiveVerification;
}

/**
 * The authoritative showcase card SVG — the badge letter reflects the
 * verification tier (Tier 1 → A, Tier 2 → A+), with the true conformance score
 * still shown. Derived from the CI-recomputed result, never the adopter's upload.
 */
export function renderShowcaseCard(result: GradeResult, tier: Tier): string {
  return renderShareSvg(result, {
    letter: tierBadge(tier),
    caption: tierLabel(tier),
    accent: tierAccent(tier),
    eyebrow: 'GRADED WITH STANDDOWN',
  });
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export interface Entry {
  submission: Submission;
  result: GradeResult;
  computedSha: string;
  tier: Tier;
  verification?: LiveVerification | null;
}

/** Render the full SHOWCASE.md gallery from verified entries. */
export function renderShowcaseMd(entries: Entry[], cardsRelDir = 'showcase/cards'): string {
  // Tier 2 (A+) above Tier 1 (A); within a tier, higher conformance score first.
  const sorted = [...entries].sort(
    (a, b) =>
      b.tier - a.tier ||
      b.result.score - a.result.score ||
      a.submission.slug.localeCompare(b.submission.slug),
  );

  const rows = sorted
    .map((e) => {
      const s = e.submission;
      const badge = tierBadge(e.tier);
      const name = s.extension.url
        ? `[${esc(s.extension.name)}](${s.extension.url})`
        : esc(s.extension.name);
      const card = `${cardsRelDir}/${s.slug}.svg`;
      const cws = s.extension.chromeWebStoreId
        ? ` · [Chrome Web Store](https://chrome.google.com/webstore/detail/${s.extension.chromeWebStoreId})`
        : '';
      const upgrade =
        e.tier === 1
          ? '\n\n> ⬆️ **Upgrade to A+:** verify this on the live published extension — ' +
            'see [showcase/README.md](./showcase/README.md#reach-a-tier-2).'
          : '';
      const live =
        e.tier === 2 && e.verification
          ? ` · live crx \`v${esc(e.verification.crxVersion)}\` (${esc(e.verification.method)}, ` +
            `${esc(e.verification.verifiedOn)})`
          : '';
      return [
        `### ${name} — ${badge}`,
        '',
        `<img src="${card}" alt="standdown ${badge} badge for ${esc(s.extension.name)}" width="520">`,
        '',
        `✅ **Reproduced by standdown CI** · **${esc(tierLabel(e.tier))}** · ` +
          `conformance ${e.result.letter} (${e.result.score}/100) · ` +
          `inputs \`sha256:${e.computedSha.slice(0, 12)}\` · ` +
          `${esc(s.policySet)} · submitted by ${esc(s.submittedBy)} · ${esc(s.date)}${cws}${live}${upgrade}`,
        '',
      ].join('\n');
    })
    .join('\n');

  return `# 🛡️ Graded with standdown

Extensions that ran the [standdown](./README.md) affiliate conformance grader and
proved they stand down instead of hijacking existing attribution.

**Every badge here is reproduced by CI**, and the letter reflects the
**verification tier**:

| Badge | Tier | What CI proved |
| --- | --- | --- |
| **A** | Tier 1 — config-verified | Re-ran \`conformanceGrade\` on the declared policy inputs and reproduced the grade. |
| **A+** | Tier 2 — live-verified | Additionally fetched the **published** crx from the Chrome Web Store and confirmed it bundles this exact policy set (matching inputs SHA). |

A submission declares only its policy inputs;
[\`showcase-verify.yml\`](./.github/workflows/showcase-verify.yml) recomputes the
grade + SHA and regenerates the card, rejecting any mismatch — the number can't be
faked and the card can't be hand-edited. The top mark (**A+**) is earned by
proving the *deployed* extension actually uses the graded config, so Tier 1 caps
at **A**. See [\`showcase/README.md\`](./showcase/README.md) to add yours (one
prompt, one PR).

---

${rows || '_No submissions yet — be the first: see [showcase/README.md](./showcase/README.md)._'}
`;
}
