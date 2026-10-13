import { allPolicies, cjPolicy } from 'standdown/policies';
import { createRelayStanddown } from 'standdown/relay/background';

// Test-only: CJ's 60-minute minimum shortened to 8 seconds so a run can check
// "kept", "dropped" and "re-armed" across a real browser restart in seconds.
const FLOOR_MS = 8_000;
const policies = allPolicies.map((p) =>
  p.id === cjPolicy.id ? { ...p, standdown: { ...p.standdown, minDurationMs: FLOOR_MS } } : p,
);

createRelayStanddown({ policies });
