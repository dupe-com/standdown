import { describe, expect, it } from 'vitest';
import {
  inputsHash,
  renderShowcaseMd,
  resolveInputs,
  type Submission,
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

  it('verifies a correctly-declared submission', async () => {
    const verdict = await verifySubmission(await validSubmission());
    expect(verdict.ok).toBe(true);
    expect(verdict.result?.letter).toBe('A+');
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

  it('renders a gallery that references the CI-authoritative card and SHA', async () => {
    const sub = await validSubmission();
    const inputs = resolveInputs(sub);
    const { conformanceGrade } = await import('../grade/conformance.ts');
    const { result } = await conformanceGrade({ policies: inputs.policies, disableHosts: inputs.disableHosts });
    const md = renderShowcaseMd([{ submission: sub, result, computedSha: sub.inputsSha256 }]);
    expect(md).toContain('Reproduced by standdown CI');
    expect(md).toContain('showcase/cards/acme-saver.svg');
    expect(md).toContain(sub.inputsSha256.slice(0, 12));
  });
});
