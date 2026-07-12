// Test double — HIJACKER. On any merchant page it redirects through its own
// affiliate link regardless of existing attribution. Should score F.
// Content-script model (like real extensions); reliable in headless.
(() => {
  if (!/\/merchant\//.test(location.pathname)) return;
  if (sessionStorage.getItem('__syn_acted')) return; // once per tab (breaks the redirect loop)
  sessionStorage.setItem('__syn_acted', '1');
  location.href = new URL('/aff/cj?actor=bad', location.origin).href;
})();
