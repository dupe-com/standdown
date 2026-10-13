// Runs at document_idle, which is when a host usually decides whether to show
// UI. By now the shop may already have stripped `?cjevent=abc` from the URL; the
// relay still remembers it was there. The tab comes from sender.tab.id, so the
// message only needs the current URL.
chrome.runtime
  .sendMessage({ type: 'standdown:relay:shouldStandDown', url: location.href })
  .then(({ decision }) => {
    // Fail closed: show nothing unless the decision clearly says "not standing
    // down". Like `content`, gate on `standDown` ALONE (see AGENTS.md Step 4).
    if (decision?.standDown === false) showOffer();
  })
  .catch(() => {});

function showOffer() {
  if (document.getElementById('standdown-demo-offer')) return;
  const el = document.createElement('div');
  el.id = 'standdown-demo-offer';
  el.textContent = 'standdown relay demo — clear to offer (no prior attribution)';
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
