/**
 * Live-crx verification — the un-fakeable half of Tier 2.
 *
 * We download the *published* extension package (`.crx`) straight from the
 * Chrome Web Store (no API key, no secrets), unzip it, and try to recover the
 * exact policy set it ships. Two methods, in order of confidence:
 *
 *   1. `manifest`     — the crx contains a `standdown.manifest.json` declaring
 *                       the resolved `policies` (+ `disableHosts`) it shipped.
 *                       We hash *those bytes*, never a label, so a version skew
 *                       can't slip a different set through.
 *   2. `bundle-scan`  — no manifest: we scan the crx's JSON assets for a policy
 *                       array that, paired with the submission's declared
 *                       disableHosts, hashes to the submission's inputs SHA.
 *
 * Either way the proof is a single equality: a SHA recovered *from the live crx*
 * equals the submission's `inputsSha256`. If nothing matches, the extension
 * stays Tier 1 — we never grant A+ on a guess.
 *
 * This module owns the only network + unzip dependency; `lib.ts` stays offline.
 */
import { unzipSync } from 'fflate';
import { validatePolicy, type StanddownPolicy } from 'standdown';
import {
  inputsHash,
  resolveDeclaredInputs,
  type DeclaredInputs,
  type LiveVerification,
  type LiveVerifyMethod,
  type PolicySet,
  type Submission,
} from './lib.ts';

/** Chrome build we present to the Web Store's update endpoint. Any recent major works. */
const PRODVERSION = '124.0.0.0';

/**
 * Download the published crx for a Chrome Web Store id. Uses the long-standing
 * unauthenticated update endpoint (`clients2.google.com/.../crx`), which 302s to
 * the actual package. Throws on any non-2xx or empty body.
 */
export async function fetchCrx(chromeWebStoreId: string, prodversion = PRODVERSION): Promise<Buffer> {
  const url =
    'https://clients2.google.com/service/update2/crx' +
    `?response=redirect&acceptformat=crx2,crx3&prodversion=${encodeURIComponent(prodversion)}` +
    `&x=${encodeURIComponent(`id=${chromeWebStoreId}&installsource=ondemand&uc`)}`;
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`crx download failed for ${chromeWebStoreId}: HTTP ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error(`crx download for ${chromeWebStoreId} was empty`);
  return buf;
}

/**
 * Strip the CRX2/CRX3 header, returning the embedded zip. CRX layout:
 *   magic "Cr24" (4) · version u32le (4) · …header… · zip
 * v2 header = pubkeyLen(4) + sigLen(4) + pubkey + sig; v3 header = headerLen(4) + header.
 */
export function crxToZip(buf: Buffer): Buffer {
  if (buf.length < 16 || buf.toString('latin1', 0, 4) !== 'Cr24') {
    // Some mirrors serve the bare zip already (PK\x03\x04).
    if (buf.toString('latin1', 0, 2) === 'PK') return buf;
    throw new Error('not a crx: missing Cr24 magic');
  }
  const version = buf.readUInt32LE(4);
  if (version === 2) {
    const pubKeyLen = buf.readUInt32LE(8);
    const sigLen = buf.readUInt32LE(12);
    return buf.subarray(16 + pubKeyLen + sigLen);
  }
  if (version === 3) {
    const headerLen = buf.readUInt32LE(8);
    return buf.subarray(12 + headerLen);
  }
  throw new Error(`unsupported crx version: ${version}`);
}

/** Unzip a crx buffer to a map of archive path → bytes. */
export function unpackCrx(crx: Buffer): Record<string, Uint8Array> {
  return unzipSync(crxToZip(crx));
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder('utf8', { fatal: false }).decode(bytes);
}

/** The crx's own manifest.json `version` (for the record), or 'unknown'. */
export function readCrxVersion(files: Record<string, Uint8Array>): string {
  const raw = files['manifest.json'];
  if (!raw) return 'unknown';
  try {
    const v = (JSON.parse(decode(raw)) as { version?: unknown }).version;
    return typeof v === 'string' ? v : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** True if `value` is a non-empty array of objects that all pass validatePolicy. */
function asPolicyArray(value: unknown): StanddownPolicy[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (!value.every((v) => v && typeof v === 'object' && !Array.isArray(v))) return null;
  try {
    for (const p of value) validatePolicy(p as StanddownPolicy);
  } catch {
    return null;
  }
  return value as StanddownPolicy[];
}

/** Pull every plausible policy array out of an arbitrary parsed JSON value. */
function harvestPolicyArrays(value: unknown, out: StanddownPolicy[][]): void {
  const direct = asPolicyArray(value);
  if (direct) out.push(direct);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const v of Object.values(value as Record<string, unknown>)) harvestPolicyArrays(v, out);
  } else if (Array.isArray(value) && !direct) {
    for (const v of value) harvestPolicyArrays(v, out);
  }
}

export interface Candidate {
  method: LiveVerifyMethod;
  inputs: DeclaredInputs;
}

/**
 * Recover candidate policy sets from an unpacked crx.
 *   - A `standdown.manifest.json` yields one high-confidence `manifest` candidate
 *     (self-describing: its own policySet/policies/disableHosts).
 *   - Otherwise every policy array found in the crx's JSON assets becomes a
 *     `bundle-scan` candidate, paired with the submission's declared disableHosts
 *     (the SHA still pins the exact policy *content*).
 */
export function recoverCandidates(
  files: Record<string, Uint8Array>,
  submission: Submission,
): Candidate[] {
  const candidates: Candidate[] = [];

  for (const [name, bytes] of Object.entries(files)) {
    if (name.endsWith('standdown.manifest.json')) {
      try {
        const m = JSON.parse(decode(bytes)) as {
          policySet?: PolicySet;
          policies?: StanddownPolicy[];
          disableHosts?: string[];
        };
        candidates.push({
          method: 'manifest',
          inputs: {
            policySet: m.policySet ?? 'custom',
            ...(m.policies ? { policies: m.policies } : {}),
            ...(m.disableHosts ? { disableHosts: m.disableHosts } : {}),
          },
        });
      } catch {
        /* malformed manifest → fall through to scan */
      }
    }
  }

  // Bundle-scan: only when no manifest candidate was found (manifest is authoritative).
  if (candidates.length === 0) {
    const seen = new Set<string>();
    for (const [name, bytes] of Object.entries(files)) {
      if (!/\.(json|js)$/.test(name)) continue;
      if (name === 'manifest.json' || name.endsWith('/manifest.json')) continue;
      const text = decode(bytes);
      const arrays: StanddownPolicy[][] = [];
      try {
        harvestPolicyArrays(JSON.parse(text), arrays);
      } catch {
        // Not pure JSON (e.g. a .js bundle): pull out embedded JSON array literals.
        for (const chunk of text.match(/\[\s*\{[\s\S]*?\}\s*\]/g) ?? []) {
          try {
            harvestPolicyArrays(JSON.parse(chunk), arrays);
          } catch {
            /* not a JSON array literal */
          }
        }
      }
      for (const policies of arrays) {
        const key = JSON.stringify(policies);
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push({
          method: 'bundle-scan',
          inputs: {
            policySet: 'custom',
            policies,
            disableHosts: submission.disableHosts ?? [],
          },
        });
      }
    }
  }

  return candidates;
}

export interface LiveVerifyOutcome {
  ok: boolean;
  reason?: string;
  verification?: LiveVerification;
}

/**
 * The full live check: recover candidates from the crx and return a verification
 * record iff one hashes to the submission's `inputsSha256`. Pure given the crx
 * bytes (network fetch is the caller's job) so it's unit-testable end to end.
 */
export function verifyLiveCrx(args: {
  crx: Buffer;
  submission: Submission;
  verifiedOn: string;
}): LiveVerifyOutcome {
  const { crx, submission, verifiedOn } = args;
  const chromeWebStoreId = submission.extension.chromeWebStoreId;
  if (!chromeWebStoreId) {
    return { ok: false, reason: 'submission has no extension.chromeWebStoreId to verify against' };
  }

  let files: Record<string, Uint8Array>;
  try {
    files = unpackCrx(crx);
  } catch (error) {
    return { ok: false, reason: `could not unpack crx: ${(error as Error).message}` };
  }

  const crxVersion = readCrxVersion(files);
  const candidates = recoverCandidates(files, submission);
  if (candidates.length === 0) {
    return {
      ok: false,
      reason:
        'no standdown.manifest.json and no policy array recoverable from the bundle — ' +
        'add the manifest convention to reach Tier 2 (see showcase/README.md).',
    };
  }

  for (const candidate of candidates) {
    let sha: string;
    try {
      sha = inputsHash(resolveDeclaredInputs(candidate.inputs));
    } catch {
      continue; // unresolvable candidate (e.g. bad policy) — skip
    }
    if (sha === submission.inputsSha256) {
      return {
        ok: true,
        verification: {
          schemaVersion: 1,
          slug: submission.slug,
          chromeWebStoreId,
          method: candidate.method,
          crxVersion,
          matchedInputsSha256: sha,
          verifiedOn,
        },
      };
    }
  }

  return {
    ok: false,
    reason:
      `the live crx (v${crxVersion}) does not bundle the graded policy set — ` +
      `no recovered candidate matched inputs sha256:${submission.inputsSha256.slice(0, 12)}…. ` +
      'Publish the graded config, then re-verify.',
  };
}
