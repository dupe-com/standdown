import type { ParamMatcher, SelfExemption, StanddownPolicy } from './types';

/**
 * Expand one self-click matcher into a policy-scoped {@link SelfExemption} per
 * policy, so a publisher's own attribution param clears stand-down for **every**
 * network in the set — the common "our click wins regardless of which network was
 * in play" (`ignore_param`) semantics — without hand-enumerating one pattern per
 * policy (which silently under-exempts the moment you forget a network).
 *
 * Deriving from the same `policies` array you pass the adapter keeps the two in
 * lockstep: add a policy and the exemption expands to cover it automatically.
 *
 * This is pure authoring sugar over the existing scoped-exemption path — it emits
 * ordinary `policyId`-scoped exemptions the engine already handles, so it adds no
 * new decision semantics and no new hijack surface. An **unscoped** matcher (no
 * `policyId`/`networkId`) is reported as a self-match but never clears a
 * third-party stand-down, by design; this helper is how you opt a self-param into
 * clearing, explicitly.
 *
 * Match specificity is yours to get right: prefer a `value` + `match` (your exact
 * click id) over a name-only matcher, since a name-only clear-all fires on any URL
 * carrying that param name.
 *
 * @example
 * selfPatterns: [
 *   ...expandSelfExemption({ name: 'PID', value: 'CJ0000000001', match: 'equals' }, policies),
 *   ...expandSelfExemption({ name: 'ranSiteID', value: 'EXAMPLEID', match: 'contains' }, policies),
 * ]
 */
export function expandSelfExemption(
  matcher: ParamMatcher,
  policies: readonly StanddownPolicy[],
): SelfExemption[] {
  return (policies ?? []).map((policy) => ({ ...matcher, policyId: policy.id }));
}
