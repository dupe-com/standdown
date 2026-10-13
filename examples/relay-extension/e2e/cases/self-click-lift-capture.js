import { allPolicies } from 'standdown/policies';
import { captureLanding } from 'standdown/relay/capture';

// Test-only host config: the host's own CJ click is cjevent=own-click.
captureLanding({
  policies: allPolicies,
  selfPatterns: [{ name: 'cjevent', value: 'own-click', match: 'equals', networkId: 'cj' }],
  selfClickLift: 'same-network',
});
