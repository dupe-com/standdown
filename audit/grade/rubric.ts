/** Turn scenario observations into a percentage and an F→A+ letter grade. */
import type { ScenarioObservation } from './harness.ts';

export interface GradeResult {
  score: number; // 0..100
  letter: string;
  inert: boolean;
  standDownRate: number; // of attribution scenarios, how many were respected
  controlActivateRate: number; // of positive controls, how many actually activated
  hijacks: ScenarioObservation[];
  total: number;
  passed: number;
  note: string;
}

function band(score: number): string {
  if (score >= 95) return 'A+';
  if (score >= 90) return 'A';
  if (score >= 85) return 'A-';
  if (score >= 70) return 'B';
  if (score >= 55) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

export function grade(observations: ScenarioObservation[]): GradeResult {
  const attribution = observations.filter((o) => !o.expectedIntroduce);
  const controls = observations.filter((o) => o.expectedIntroduce);

  const standDownRespected = attribution.filter((o) => o.passed).length;
  const controlsActivated = controls.filter((o) => o.introducedAttribution).length;

  const standDownRate = attribution.length ? standDownRespected / attribution.length : 0;
  const controlActivateRate = controls.length ? controlsActivated / controls.length : 1;

  const passed = observations.filter((o) => o.passed).length;
  let score = observations.length ? (passed / observations.length) * 100 : 0;

  // Inert cap: an extension that never activates even when allowed hasn't proven
  // it does anything — it must not score A+. Cap at C and flag. A "disciplined"
  // extension that is actually just dead code is the failure mode this guards.
  const inert = controls.length > 0 && controlsActivated === 0;
  let note = '';
  if (inert) {
    score = Math.min(score, 55);
    note = 'INERT — never activated on any positive control; grade capped. Cannot distinguish disciplined stand-down from dead code.';
  } else if (standDownRate < 1) {
    note = `Hijacked ${attribution.length - standDownRespected}/${attribution.length} scenarios where attribution already existed.`;
  } else {
    note = 'Respected existing attribution across all tested networks and activated when allowed.';
  }

  return {
    score: Math.round(score),
    letter: inert ? `${band(score)} (inert)` : band(score),
    inert,
    standDownRate,
    controlActivateRate,
    hijacks: attribution.filter((o) => !o.passed),
    total: observations.length,
    passed,
    note,
  };
}
