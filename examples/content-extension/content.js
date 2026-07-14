import { allPolicies } from 'standdown/policies';
import { createContentStanddown } from 'standdown/content';

// The content adapter runs in the page and collects only local signals
// (location.href, document.referrer, first-party cookie NAMES). It needs no
// webNavigation/webRequest permissions — which is exactly why an MV3 extension
// that can't hold those permissions uses standdown/content instead of webext.
const standdown = createContentStanddown({
  policies: allPolicies,
  storage: 'session', // or 'local-ttl' for a sliding 24h envelope
  // Declare your own site + click IDs so the library never stands you down
  // against your own attribution:
  // publisherSites: ['your-site.com'],
  // selfPatterns: [{ name: 'your_click_id', networkId: 'cj' }],

  // onDecision fires on the initial evaluation and whenever the adapter's own
  // history hooks (pushState/replaceState/popstate) fire.
  //
  // ISOLATED-WORLD CAVEAT: those hooks patch `history` in the world this script
  // runs in. In a real content script that is the *isolated* world, so a SPA
  // that calls `history.pushState` from its own (main-world) code will NOT
  // trigger re-evaluation. Only `popstate` reliably crosses worlds. If your
  // target sites are single-page apps, drive re-evaluation yourself from a
  // navigation detector — see below.
  onDecision: applyDecision,
});

// Recommended for SPAs: re-evaluate on client-side route changes the adapter's
// isolated-world history hooks cannot see. `evaluate()` recomputes from current
// page signals and fires onDecision.
//
// PREFER A SINGLE NAVIGATION SOURCE. Hook your framework's router and call
// evaluate() once per real navigation. Feeding evaluate() from more than one
// source (e.g. the poll below AND the adapter's own popstate hook) can run two
// evaluations concurrently; they are not coalesced, so overlapping runs can
// lose-update the shared session store. One source per navigation avoids that.
//
// The URL poll below is only a last-resort, framework-agnostic fallback. Know
// the tradeoffs before you ship it:
//   - up to POLL_MS of latency before a newly-attributed page re-evaluates, so
//     the gate can briefly read the stale decision on an already-attributed page,
//   - it also fires for navigations the adapter already caught (popstate,
//     isolated-world pushState), duplicating that work and reopening the race above.
const POLL_MS = 1000;
let lastUrl = location.href;
const navPoll = setInterval(() => {
  if (location.href === lastUrl) return;
  lastUrl = location.href;
  // evaluate() fails closed internally, but ingest can still reject; swallow so
  // one bad tick doesn't become an unhandled rejection and kill the poll.
  standdown.evaluate().catch(() => {});
}, POLL_MS);

// On teardown (extension update, SPA unmount) clear the timer yourself. The
// public evaluate() does not check the controller's disposed flag, so a leftover
// interval would keep re-firing onDecision after dispose():
//   clearInterval(navPoll);
//   standdown.dispose();

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
