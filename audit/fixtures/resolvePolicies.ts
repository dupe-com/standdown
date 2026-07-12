import type { StanddownPolicy } from 'standdown';
import { allPolicies } from 'standdown/policies';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

/**
 * Resolve the policy set the audit grades against.
 *
 * Defaults to standdown's own bundled packs (`allPolicies`) so `npm run grade`
 * works out of the box. To grade YOUR OWN policy pack instead — the common case
 * for a consumer adopting the library — point `POLICY_PACK` at a module that
 * exports your policies:
 *
 *   POLICY_PACK=./my-packs.ts npx tsx grade/grade.ts <ext-path>
 *
 * The module may export the `StanddownPolicy[]` as its default export, or as a
 * named `policies` / `allPolicies` export. Because the whole scenario matrix is
 * DERIVED from the packs (see fixtures/scenarios.ts), supplying your policy is
 * all that's needed — the harness generates the merchant/param/cookie scenarios
 * and expected decisions from your `detection` blocks. No affiliate identifiers
 * are hardcoded in this path.
 */
export async function resolvePolicies(
  spec: string | undefined = process.env.POLICY_PACK,
): Promise<readonly StanddownPolicy[]> {
  if (!spec) return allPolicies;

  const url = pathToFileURL(resolve(spec)).href;
  let mod: Record<string, unknown>;
  try {
    mod = (await import(url)) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`POLICY_PACK: failed to import '${spec}': ${(err as Error).message}`);
  }

  const picked = mod.default ?? mod.policies ?? mod.allPolicies;
  if (!Array.isArray(picked) || picked.length === 0) {
    throw new Error(
      `POLICY_PACK: module '${spec}' must export a non-empty policy array ` +
        `(as its default export, or a named 'policies' / 'allPolicies' export).`,
    );
  }
  return picked as StanddownPolicy[];
}

/** Human-readable label for the resolved source, for run logging. */
export function policySourceLabel(spec: string | undefined = process.env.POLICY_PACK): string {
  return spec ? `POLICY_PACK=${spec}` : 'standdown bundled packs (allPolicies)';
}
