import { allPolicies } from 'standdown/policies';
import { createContentStanddown } from 'standdown/content';

// The content adapter runs in the page and collects only local signals
// (location.href, document.referrer, first-party cookie NAMES). It needs no
// webNavigation/webRequest permissions — which is exactly why an MV3 extension
// that can't hold those permissions uses standdown/content instead of webext.
createContentStanddown({
  policies: allPolicies,
  storage: 'session', // or 'local-ttl' for a sliding 24h envelope
  // Declare your own site + click IDs so the library never stands you down
  // against your own attribution:
  // publisherSites: ['your-site.com'],
  // selfPatterns: [{ name: 'your_click_id', networkId: 'cj' }],

  // onDecision fires on the initial evaluation AND on every SPA navigation
  // (the adapter hooks pushState/replaceState/popstate), so the gate below
  // stays current without any extra wiring.
  onDecision: applyDecision,
});

// Gate your on-page affiliate action on the decision. Fail closed: only act when
// NOT standing down. The content plane can't observe redirect chains, so a clean
// page comes back `{ standDown: false, degraded: true }` — gate on `standDown`
// ALONE (see AGENTS.md Step 4). Treating `degraded` as stand-down here would make
// the extension never activate on an ordinary page.
function applyDecision(decision) {
  if (decision.standDown) {
    removeOffer();
  } else {
    showOffer();
  }
}

function showOffer() {
  if (document.getElementById('standdown-demo-offer')) return;
  const el = document.createElement('div');
  el.id = 'standdown-demo-offer';
  el.textContent = 'standdown demo — clear to offer (no prior attribution)';
  Object.assign(el.style, {
    position: 'fixed',
    bottom: '12px',
    right: '12px',
    zIndex: '2147483647',
    padding: '8px 12px',
    borderRadius: '8px',
    color: '#fff',
    font: '12px system-ui, sans-serif',
    background: '#0b7a4b',
    boxShadow: '0 2px 8px rgba(0,0,0,.3)',
  });
  document.body.appendChild(el);
}

function removeOffer() {
  document.getElementById('standdown-demo-offer')?.remove();
}
