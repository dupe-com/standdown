import { allPolicies } from 'standdown/policies';
import { createRelayStanddown } from 'standdown/relay/background';

// Keeps a short per-tab landing record in chrome.storage.session and answers
// `standdown:relay:shouldStandDown` through the regular decision engine.
createRelayStanddown({
  policies: allPolicies,
  // Must match the selfPatterns in relay-capture.js:
  // selfPatterns: [{ name: 'your_click_id', networkId: 'cj' }],
  // publisherSites: ['your-site.com'],
});
