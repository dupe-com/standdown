import { describe, expect, it } from 'vitest';
import {
  determineTier,
  inputsHash,
  type LiveVerification,
  renderShowcaseCard,
  renderShowcaseMd,
  resolveInputs,
  type Submission,
  tierBadge,
  verifySubmission,
} from './lib.ts';

/** Build a submission whose declared grade + SHA are correct for its inputs. */
async function validSubmission(over: Partial<Submission> = {}): Promise<Submission> {
  const base: Submission = {
    schemaVersion: 1,
    slug: 'acme-saver',
    extension: { name: 'Acme Saver', url: 'https://acme.example' },
    submittedBy: 'octocat',
    policySet: 'allPolicies',
    disableHosts: ['ebay.com'],
    grade: { letter: '', score: 0 },
    inputsSha256: '',
    generatedWith: 'standdown',
    date: '2026-07-13',
    ...over,
  };
  const inputs = resolveInputs(base);
  const { conformanceGrade } = await import('../grade/conformance.ts');
  const { result } = await conformanceGrade({
    policies: inputs.policies,
    disableHosts: inputs.disableHosts,
  });
  return {
    ...base,
    grade: { letter: result.letter, score: result.score },
    inputsSha256: inputsHash(inputs),
  };
}

describe('showcase lib', () => {
  it('hashes resolved inputs deterministically and independent of disableHosts order', () => {
    const a = resolveInputs({ policySet: 'allPolicies', disableHosts: ['ebay.com', 'x.com'] } as Submission);
    const b = resolveInputs({ policySet: 'allPolicies', disableHosts: ['X.com', 'EBAY.com'] } as Submission);
    expect(inputsHash(a)).toBe(inputsHash(b));
  });

  it('verifies a correctly-declared submission and assigns Tier 1', async () => {
    const verdict = await verifySubmission(await validSubmission());
    expect(verdict.ok).toBe(true);
    expect(verdict.result?.letter).toBe('A+');
    expect(verdict.tier).toBe(1); // Tier 2 (live-verify) not yet implemented
  });

  it('rejects a self-claimed tier', async () => {
    const sub = { ...(await validSubmission()), tier: 2 } as unknown as Submission;
    const verdict = await verifySubmission(sub);
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.join(' ')).toMatch(/determined by CI/);
  });

  it('maps tier to badge: Tier 1 → A, Tier 2 → A+', () => {
    expect(tierBadge(1)).toBe('A');
    expect(tierBadge(2)).toBe('A+');
  });

  it('grants Tier 2 only for a verification record whose SHA matches the submission', async () => {
    const sub = await validSubmission();
    const matching: LiveVerification = {
      schemaVersion: 1,
      slug: sub.slug,
      chromeWebStoreId: 'abc123',
      method: 'manifest',
      crxVersion: '1.2.3',
      matchedInputsSha256: sub.inputsSha256,
      verifiedOn: '2026-07-13',
    };
    expect(determineTier(sub, matching)).toBe(2);
    // Wrong SHA, wrong slug, or no record all stay Tier 1.
    expect(determineTier(sub, { ...matching, matchedInputsSha256: 'deadbeef' })).toBe(1);
    expect(determineTier(sub, { ...matching, slug: 'someone-else' })).toBe(1);
    expect(determineTier(sub, null)).toBe(1);

    const verdict = await verifySubmission(sub, matching);
    expect(verdict.ok).toBe(true);
    expect(verdict.tier).toBe(2);
  });

  it('renders a Tier-2 gallery with an A+ badge, live crx provenance, and no upgrade CTA', async () => {
    const sub = await validSubmission();
    const inputs = resolveInputs(sub);
    const { conformanceGrade } = await import('../grade/conformance.ts');
    const { result } = await conformanceGrade({ policies: inputs.policies, disableHosts: inputs.disableHosts });
    const verification: LiveVerification = {
      schemaVersion: 1,
      slug: sub.slug,
      chromeWebStoreId: 'abc123',
      method: 'manifest',
      crxVersion: '4.5.6',
      matchedInputsSha256: sub.inputsSha256,
      verifiedOn: '2026-07-13',
    };
    const md = renderShowcaseMd([
      { submission: sub, result, computedSha: sub.inputsSha256, tier: 2, verification },
    ]);
    expect(md).toContain(`### [${sub.extension.name}](${sub.extension.url}) — A+`);
    expect(md).toContain('Tier 2 · verified on live extension');
    expect(md).toContain('live crx `v4.5.6` (manifest, 2026-07-13)');
    expect(md).not.toContain('Upgrade to A+');
  });

  it('rejects a faked grade', async () => {
    const sub = await validSubmission();
    sub.grade = { letter: 'A+', score: 42 };
    const verdict = await verifySubmission(sub);
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.join(' ')).toMatch(/grade mismatch/);
  });

  it('rejects a tampered SHA', async () => {
    const sub = await validSubmission();
    sub.inputsSha256 = `deadbeef${sub.inputsSha256.slice(8)}`;
    const verdict = await verifySubmission(sub);
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.join(' ')).toMatch(/inputsSha256 mismatch/);
  });

  it('rejects a non-kebab slug and unknown policySet', async () => {
    const bad = await validSubmission({ slug: 'Not Kebab' });
    expect((await verifySubmission(bad)).errors.join(' ')).toMatch(/kebab/);
    const unknown = { ...(await validSubmission()), policySet: 'bogus' } as unknown as Submission;
    expect((await verifySubmission(unknown)).ok).toBe(false);
  });

  it('renders a Tier-1 gallery with an A badge, the real conformance score, and the card/SHA', async () => {
    const sub = await validSubmission();
    const inputs = resolveInputs(sub);
    const { conformanceGrade } = await import('../grade/conformance.ts');
    const { result } = await conformanceGrade({ policies: inputs.policies, disableHosts: inputs.disableHosts });
    const md = renderShowcaseMd([
      { submission: sub, result, computedSha: sub.inputsSha256, tier: 1 },
    ]);
    expect(md).toContain('Reproduced by standdown CI');
    expect(md).toContain('Tier 1 · config-verified');
    expect(md).toContain(`### [${sub.extension.name}](${sub.extension.url}) — A`); // badge caps at A
    expect(md).toContain(`conformance ${result.letter} (${result.score}/100)`); // true score still shown
    expect(md).toContain('Upgrade to A+');
    expect(md).toContain('showcase/cards/acme-saver.svg');
    expect(md).toContain(sub.inputsSha256.slice(0, 12));
  });

  it('renders a card whose badge letter is tier-driven, not the raw grade', async () => {
    const { result } = { result: { score: 100, letter: 'A+', inert: false, standDownRate: 1, controlActivateRate: 1, hijacks: [], total: 20, passed: 20, note: '' } };
    const t1 = renderShowcaseCard(result, 1);
    const t2 = renderShowcaseCard(result, 2);
    expect(t1).toContain('GRADED WITH STANDDOWN');
    expect(t1).toContain('Tier 1 · config-verified');
    // ring badge is A for tier 1 even though the conformance letter is A+
    expect(t1).toMatch(/dominant-baseline="central">A</);
    expect(t2).toMatch(/dominant-baseline="central">A\+</);
    expect(t2).toContain('Tier 2 · verified on live extension');
  });
});
