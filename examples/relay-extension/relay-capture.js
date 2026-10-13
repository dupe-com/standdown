import { allPolicies } from 'standdown/policies';
import { captureLanding } from 'standdown/relay/capture';

// Runs at document_start, before the page's own scripts can strip the referral
// param with history.replaceState or forward to a clean URL. Keeps only the
// matched param NAMES, the host and a timestamp, and hands them to the
// background. Keep this script this small: it runs on every matched page load.
captureLanding({
  policies: allPolicies,
  // Declare your own click IDs so your own clicks never stand you down:
  // selfPatterns: [{ name: 'your_click_id', networkId: 'cj' }],
});
