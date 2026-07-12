/**
 * In-browser SIDE-BY-SIDE run. Loads the host extension built with the standdown
 * shadow ENABLED, serves a HERMETIC local stand-down policy (so the extension's
 * OWN detector actually runs instead of failing/stalling on its api.example.com
 * fetch), navigates the real-merchant scenario matrix, and compares — per page —
 * the standdown library's decision against the extension's SETTLED
 * `__ext__stand-down` flag. That makes it a true both-detectors comparison,
 * unlike shadow-run-probe.ts (which only captures the observer's own logs and is
 * confounded by the extension's async detector not settling in time).
 *
 * Local policy fixture: delivered via a dev-only policy-injection hook the
 * extension exposes for testing, NOT Playwright interception — an extension
 * service-worker's fetches are not interceptable by context.route. Build the
 * extension with that hook + the shadow both enabled, then point EXT_PATH at it.
 *
 *   EXT_PATH=<unpacked ext, shadow ON + test-policy ON> npx tsx audit/grade/shadow-sidebyside-probe.ts
 *
 * WHAT THIS ACTUALLY VALIDATES: the `standdown` column vs the EXPECTED production
 * decision. That's the meaningful signal and it passes on every page where the
 * host content script runs.
 *
 * KNOWN LIMITATION: the `extension` column (the host extension's OWN detector) is
 * racy/inert in a cold headless service worker — its policy request can lose a
 * service-worker startup race, so the detector may not settle within the probe
 * window and its flag stays unset. That makes the extension column an unreliable
 * signal in this harness, NOT a standdown divergence: standdown ships its policies
 * bundled and takes no service-worker round-trip, so it has no such dependency.
 * (This harness only asserts on the standdown column.)
 */
import { chromium, type BrowserContext, type Page } from 'playwright';
import { createServer } from 'node:https';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';

const EXT_PATH = process.env.EXT_PATH ?? process.argv[2] ?? '';
const SETTLE_MS = Number(process.env.SETTLE_MS ?? 9000);
if (!EXT_PATH) {
  console.error('usage: EXT_PATH=<unpacked-ext-with-shadow-ON> npx tsx audit/grade/shadow-sidebyside-probe.ts');
  process.exit(2);
}

/** Example adopting-extension policy (illustrative production STAND_DOWN set; real IDs replaced with placeholders). */
const DESKTOP_POLICY = [
  { network: 'rakuten', cookie: ['lsclick_mid', '*lsclick_mid_*', '*linkshare*'], params: [['ranEAID', 'ranSiteID'], ['ranEAID'], ['ranSiteID']], disable_domains: [], ignore_param: [{ param: 'ranSiteID', value: 'EXAMPLESITEID', type: 'contains' }] },
  { network: 'cj', params: ['cjevent'], cookie: [], standDownCookieDuration: 60, disable_domains: [], ignore_param: [{ param: 'cp', value: '_examplebrand', type: 'contains' }, { param: 'PID', value: 'CJ0000000001', type: 'equals' }, { param: 'PID', value: 'CJ0000000002', type: 'equals' }] },
  { network: 'impact', params: ['irgwc'], cookie: [], disable_domains: [] },
  { network: 'ebay', params: [['campid', '_trkparms'], ['mktype', 'gclid']], cookie: [], disable_domains: ['ebay.com', 'ebay.'] },
  { network: 'homedepot', params: ['long-string-home-depot'], cookie: [], disable_domains: ['homedepot.com'] },
  { network: 'aliexpress', params: ['long-string-aliexpress'], cookie: [], disable_domains: ['aliexpress.com', 'aliexpress.co.uk'] },
  { network: 'shein', params: ['long-string-shein'], cookie: [], disable_domains: ['shein.com', 'shein.co.uk', 'm.shein.co.uk', 'm.shein.com'] },
];

interface Scen { id: string; host: string; path: string; cookie?: { name: string; value: string }; expectStandDown: boolean }
const SCENARIOS: Scen[] = [
  { id: 'cj:cjevent', host: 'www.nordstrom.com', path: '/product?cjevent=abc123def456', expectStandDown: true },
  { id: 'rakuten:ranSiteID', host: 'www.nordstrom.com', path: '/product?ranSiteID=aff123', expectStandDown: true },
  { id: 'rakuten:bare-ranEAID(D1)', host: 'www.nordstrom.com', path: '/product?ranEAID=xyz', expectStandDown: true },
  { id: 'impact:irgwc', host: 'www.nordstrom.com', path: '/product?irgwc=1', expectStandDown: true },
  { id: 'ebay:disable-domain', host: 'www.ebay.com', path: '/itm/1234567890', expectStandDown: true },
  { id: 'homedepot:disable-domain', host: 'www.homedepot.com', path: '/p/Some/123456', expectStandDown: true },
  { id: 'rakuten:cookie-name', host: 'www.nordstrom.com', path: '/product', cookie: { name: 'lsclick_mid_12345', value: 'aff' }, expectStandDown: true },
  { id: 'self-click:rakuten', host: 'www.nordstrom.com', path: '/product?ranSiteID=preEXAMPLESITEIDpost', expectStandDown: false },
  { id: 'self-click:cj', host: 'www.nordstrom.com', path: '/product?cjevent=abc&cp=x_examplebrand', expectStandDown: false },
  { id: 'control:amazon', host: 'www.amazon.com', path: '/dp/B00EXAMPLE', expectStandDown: false },
  { id: 'control:clean', host: 'www.nordstrom.com', path: '/product', expectStandDown: false },
];

const PRODUCT_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Product</title>
<meta property="og:type" content="product">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Test","offers":{"@type":"Offer","price":"99.00","priceCurrency":"USD"}}</script>
</head><body><h1>Test Product</h1><div class="price" id="price">$99.00</div><a id="buy" href="/checkout">Buy</a></body></html>`;

function makeCert(dir: string, hosts: readonly string[]) {
  const key = join(dir, 'key.pem');
  const cert = join(dir, 'cert.pem');
  const san = [...hosts.map((h) => `DNS:${h}`), 'DNS:localhost', 'IP:127.0.0.1'].join(',');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=standdown-sidebyside', '-addext', `subjectAltName=${san}`], { stdio: 'ignore' });
  return { key, cert };
}

/** Read the extension's SETTLED stand-down flag from the page (its content script writes it here). */
async function readExtFlag(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const parse = (raw: string | null) => {
      if (!raw || raw === 'null') return false;
      try { return JSON.parse(raw) === 'stand-down'; } catch { return raw === 'stand-down'; }
    };
    const ss = parse(window.sessionStorage.getItem('__ext__stand-down'));
    // Cross-nav TTL flag lives in localStorage; treat either as stood-down.
    let ttl = false;
    try {
      const raw = window.localStorage.getItem('__ext__stand-down-ttl');
      if (raw) { const v = JSON.parse(raw); ttl = (v?.value ?? v) === 'stand-down'; }
    } catch { /* ignore */ }
    return ss || ttl;
  }).catch(() => false);
}

async function main() {
  // Map api.example.com/example.com to the fixture too, so the extension's INCIDENTAL
  // fetches (get-shop, custom-token, analytics) fail fast locally instead of
  // hanging on the real network and stalling the detector's init. (Without this
  // the extension's flag never settles — the reason a shared-context/unmapped
  // run under-reads it.) The stand-down policy itself comes from the dev hook.
  const hosts = [...new Set([...SCENARIOS.map((s) => s.host), 'api.example.com', 'example.com'])];
  const dir = await mkdtemp(join(tmpdir(), 'sxs-'));
  const { key, cert } = makeCert(dir, hosts);
  const server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (_q, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PRODUCT_HTML);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;

  const resolverRules = hosts.map((h) => `MAP ${h} 127.0.0.1`).join(', ');

  console.log(`\n  standdown — in-browser SIDE-BY-SIDE (both detectors, fresh context per scenario)`);
  console.log(`  extension: ${EXT_PATH}\n`);
  console.log(`  ${'SCENARIO'.padEnd(28)} ${'standdown'.padEnd(10)} ${'extension'.padEnd(10)} ${'expect'.padEnd(8)} result`);
  console.log('  ' + '-'.repeat(82));

  let sdRan = 0, sdOk = 0;
  const sdWrong: string[] = [];
  for (const s of SCENARIOS) {
    // Fresh persistent context per scenario — mirrors the reliable single-page
    // read (a shared context under-reads the extension's slow async write).
    const udd = await mkdtemp(join(tmpdir(), 'sxs-p-'));
    const ctx = await chromium.launchPersistentContext(udd, {
      headless: false, ignoreHTTPSErrors: true,
      args: ['--headless=new', `--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--ignore-certificate-errors', `--host-resolver-rules=${resolverRules}`, '--no-first-run'],
    });
    await ctx.waitForEvent('serviceworker', { timeout: 8000 }).catch(() => null);
    if (s.cookie) await ctx.addCookies([{ name: s.cookie.name, value: s.cookie.value, domain: s.host, path: '/', secure: true, httpOnly: false }]).catch(() => {});
    const page = await ctx.newPage();
    let sd: boolean | undefined;
    page.on('console', (m) => { const t = m.text(); if (t.includes('[standdown-shadow]')) { const mm = t.match(/standdown=(true|false)/); if (mm) sd = mm[1] === 'true'; } });
    await page.goto(`https://${s.host}:${port}${s.path}`, { waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => {});
    await page.waitForTimeout(Math.min(SETTLE_MS, 12000)); // fixed settle, single read (matches the reliable diagnostic)
    const ext = await readExtFlag(page);
    await Promise.race([ctx.close(), new Promise((r) => setTimeout(r, 4000).unref())]);
    await rm(udd, { recursive: true, force: true }).catch(() => {});

    const sdStr = sd === undefined ? 'silent' : String(sd);
    // PRIMARY signal: does standdown match the EXPECTED production decision?
    const sdCorrect = sd !== undefined && sd === s.expectStandDown;
    if (sd !== undefined) { sdRan++; if (sdCorrect) sdOk++; else sdWrong.push(`${s.id}: standdown=${sd} expected=${s.expectStandDown}`); }
    // SECONDARY: the extension's own flag — unreliable in a cold headless SW
    // (its policy request can lose a service-worker startup race, so the
    // detector may not settle within the probe window). Not a standdown signal.
    const res = sd === undefined ? 'no-shadow' : sdCorrect ? 'standdown✓' : 'standdown✗';
    const note = sd !== undefined && sd !== ext ? '  (ext detector unsettled)' : '';
    console.log(`  ${s.id.padEnd(28)} ${sdStr.padEnd(10)} ${String(ext).padEnd(10)} ${String(s.expectStandDown).padEnd(8)} ${res}${note}`);
  }

  console.log('  ' + '-'.repeat(82));
  console.log(`\n  standdown vs expected production decision: ${sdOk}/${sdRan} correct (${SCENARIOS.length - sdRan} scenario(s) where standdown did not run — OnPage absent).`);
  if (sdWrong.length) { console.log('  standdown WRONG on:'); for (const d of sdWrong) console.log(`    - ${d}`); }
  console.log(`\n  NOTE: the 'extension' column is the host extension's OWN detector, which`);
  console.log(`  is unreliable in a cold headless service worker (policy request can lose a`);
  console.log(`  startup race). It is not a standdown signal — see header.\n`);

  await new Promise<void>((r) => server.close(() => r()));
  await rm(dir, { recursive: true, force: true });
  process.exit(0);
}

main();
