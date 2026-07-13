import { zipSync, strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { allPolicies } from 'standdown/policies';
import { inputsHash, resolveInputs, type Submission } from './lib.ts';
import { crxToZip, recoverCandidates, unpackCrx, verifyLiveCrx } from './crx.ts';

/** A submission over a small custom policy set with a known-good SHA. */
function customSubmission(chromeWebStoreId = 'abcdefghijklmnopabcdefghijklmnop'): Submission {
  const policies = [allPolicies[0]!, allPolicies[1]!];
  const inputs = resolveInputs({ policySet: 'custom', policies, disableHosts: [] } as Submission);
  return {
    schemaVersion: 1,
    slug: 'demo-ext',
    extension: { name: 'Demo', chromeWebStoreId },
    submittedBy: 'octocat',
    policySet: 'custom',
    policies,
    disableHosts: [],
    grade: { letter: 'A+', score: 100 },
    inputsSha256: inputsHash(inputs),
    generatedWith: 'standdown',
    date: '2026-07-13',
  };
}

/** Wrap a zip buffer in a minimal CRX3 envelope (magic · version 3 · headerLen=0). */
function asCrx3(zip: Uint8Array): Buffer {
  const head = Buffer.alloc(12);
  head.write('Cr24', 0, 'latin1');
  head.writeUInt32LE(3, 4);
  head.writeUInt32LE(0, 8);
  return Buffer.concat([head, Buffer.from(zip)]);
}

function makeCrx(files: Record<string, string>, version = '1.0.0'): Buffer {
  const entries: Record<string, Uint8Array> = { 'manifest.json': strToU8(JSON.stringify({ version })) };
  for (const [name, content] of Object.entries(files)) entries[name] = strToU8(content);
  return asCrx3(zipSync(entries));
}

describe('crxToZip', () => {
  it('strips a CRX3 header to expose the PK zip', () => {
    const zip = zipSync({ 'a.txt': strToU8('hi') });
    const stripped = crxToZip(asCrx3(zip));
    expect(stripped.toString('latin1', 0, 2)).toBe('PK');
  });

  it('passes through a bare zip and rejects non-crx bytes', () => {
    const zip = Buffer.from(zipSync({ 'a.txt': strToU8('hi') }));
    expect(crxToZip(zip).toString('latin1', 0, 2)).toBe('PK');
    expect(() => crxToZip(Buffer.from('not a crx at all'))).toThrow(/not a crx/);
  });
});

describe('recoverCandidates', () => {
  it('reads a standdown.manifest.json as an authoritative manifest candidate', () => {
    const sub = customSubmission();
    const crx = makeCrx({
      'standdown.manifest.json': JSON.stringify({
        schemaVersion: 1,
        policySet: 'custom',
        policies: sub.policies,
        disableHosts: [],
        standdownVersion: '0.2.6',
      }),
    });
    const candidates = recoverCandidates(unpackCrx(crx), sub);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.method).toBe('manifest');
  });

  it('falls back to scanning JSON assets when no manifest is present', () => {
    const sub = customSubmission();
    const crx = makeCrx({ 'assets/policies.json': JSON.stringify(sub.policies) });
    const candidates = recoverCandidates(unpackCrx(crx), sub);
    expect(candidates.some((c) => c.method === 'bundle-scan')).toBe(true);
  });
});

describe('verifyLiveCrx', () => {
  it('confirms Tier 2 via the manifest convention (SHA matches)', () => {
    const sub = customSubmission();
    const crx = makeCrx(
      { 'standdown.manifest.json': JSON.stringify({ policySet: 'custom', policies: sub.policies, disableHosts: [] }) },
      '2.1.0',
    );
    const outcome = verifyLiveCrx({ crx, submission: sub, verifiedOn: '2026-07-13' });
    expect(outcome.ok).toBe(true);
    expect(outcome.verification?.method).toBe('manifest');
    expect(outcome.verification?.crxVersion).toBe('2.1.0');
    expect(outcome.verification?.matchedInputsSha256).toBe(sub.inputsSha256);
  });

  it('verifies a bare .zip (no CRX header) carrying a manifest — the wxt/CRX_FILE dry-run case', () => {
    const sub = customSubmission();
    // `wxt zip` and the CRX_FILE dry-run hand us a plain PK zip, not a signed crx.
    const zip = zipSync({
      'manifest.json': strToU8(JSON.stringify({ version: '0.3.1' })),
      'standdown.manifest.json': strToU8(
        JSON.stringify({ schemaVersion: 1, policySet: 'custom', policies: sub.policies, disableHosts: [] }),
      ),
    });
    const outcome = verifyLiveCrx({ crx: Buffer.from(zip), submission: sub, verifiedOn: '2026-07-13' });
    expect(outcome.ok).toBe(true);
    expect(outcome.verification?.method).toBe('manifest');
    expect(outcome.verification?.crxVersion).toBe('0.3.1');
  });

  it('confirms Tier 2 via bundle-scan when the policy array ships as a JSON asset', () => {
    const sub = customSubmission();
    const crx = makeCrx({ 'config/policies.json': JSON.stringify(sub.policies) });
    const outcome = verifyLiveCrx({ crx, submission: sub, verifiedOn: '2026-07-13' });
    expect(outcome.ok).toBe(true);
    expect(outcome.verification?.method).toBe('bundle-scan');
  });

  it('refuses when the live crx bundles a different policy set', () => {
    const sub = customSubmission();
    const crx = makeCrx({
      'standdown.manifest.json': JSON.stringify({ policySet: 'custom', policies: [allPolicies[2]!], disableHosts: [] }),
    });
    const outcome = verifyLiveCrx({ crx, submission: sub, verifiedOn: '2026-07-13' });
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toMatch(/does not bundle/);
  });

  it('refuses when nothing recoverable is in the bundle', () => {
    const sub = customSubmission();
    const crx = makeCrx({ 'readme.txt': 'no policies here' });
    const outcome = verifyLiveCrx({ crx, submission: sub, verifiedOn: '2026-07-13' });
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toMatch(/no standdown\.manifest\.json/);
  });
});
