import { allPolicies } from 'standdown/policies';
import { createContentStanddown } from 'standdown/content';

// Test-only stand-in for offer.js. At document_idle it asks the relay AND runs
// the plain `content` adapter on the same page, so each scenario shows the old
// and new answer side by side. The result goes on <html data-probe> for the
// runner to read (content scripts share the DOM with the page).
// __PROBE_CONTENT_OPTIONS__ is injected at bundle time by run.mjs.
const contentOptions = __PROBE_CONTENT_OPTIONS__;

(async () => {
  const out = { urlAtIdle: location.href };
  try {
    const d = await createContentStanddown({ policies: allPolicies, storage: 'session', ...contentOptions }).ready;
    out.content = { standDown: d.standDown, reason: d.reason };
  } catch (e) {
    out.content = { error: String(e) };
  }
  try {
    const r = await chrome.runtime.sendMessage({ type: 'standdown:relay:shouldStandDown', url: location.href });
    out.relay = { ok: r?.ok, standDown: r?.decision?.standDown, matchKind: r?.decision?.matchKind, reason: r?.decision?.reason };
  } catch (e) {
    out.relay = { error: String(e) };
  }
  document.documentElement.setAttribute('data-probe', JSON.stringify(out));
})();
