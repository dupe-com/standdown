import { allPolicies } from 'standdown/policies';
import { createStanddown } from 'standdown/webext';

createStanddown({
  policies: allPolicies,
  selfPatterns: [
    // Scope your own click IDs so they only exempt your own affiliate traffic.
    // { name: 'dupe_click_id', networkId: 'cj' }
  ],
});
