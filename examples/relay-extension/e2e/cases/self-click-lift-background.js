import { allPolicies } from 'standdown/policies';
import { createRelayStanddown } from 'standdown/relay/background';

createRelayStanddown({
  policies: allPolicies,
  selfPatterns: [{ name: 'cjevent', value: 'own-click', match: 'equals', networkId: 'cj' }],
  selfClickLift: 'same-network',
});
