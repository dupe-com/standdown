// Test double — WELL-BEHAVED. Activates (redirects through its own affiliate
// link) only when it detects NO existing affiliate attribution; otherwise it
// stands down. Hand-coded so the grader doesn't depend on the library it grades.
(() => {
  if (!/\/merchant\//.test(location.pathname)) return;
  if (sessionStorage.getItem('__syn_acted')) return; // once per tab
  sessionStorage.setItem('__syn_acted', '1');

  const KNOWN = [
    'cjevent', 'cjdata', 'awc', 'irclickid', 'irgwc', 'afsrc', 'ranSiteID',
    'siteID', 'ranMID', 'ranEAID', 'sscid', 'campid', 'mkcid', 'mkevt', 'clickref', 'tag',
  ];
  const u = new URL(location.href);
  const paramAttribution = KNOWN.some((p) => u.searchParams.has(p));
  const cookieAttribution = /(^|;\s*)(cje|cjevent|im_ref|lsclick|linkshare|sscid)/i.test(document.cookie);

  if (!paramAttribution && !cookieAttribution) {
    location.href = new URL('/aff/cj?actor=good', location.origin).href; // clear to earn it
  }
})();
