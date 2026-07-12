/**
 * Discovery / observation harness for grading ARBITRARY extensions (no internal
 * knowledge). Loads an unpacked extension and records everything it does on a
 * merchant page that the browser is fooled into thinking is a real retailer.
 *
 * The trick that makes a synthetic fixture trigger a real affiliate extension:
 * Chromium `--host-resolver-rules="MAP <merchant> 127.0.0.1"` resolves a real
 * retailer hostname to our local HTTPS fixture. With a cert whose SAN covers that
 * host + --ignore-certificate-errors, the extension sees https://www.nordstrom.com/…
 * served by us, and its merchant-keyed activation logic fires against a page we
 * fully control. We then classify every request/redirect/cookie the extension
 * initiates against the bundled affiliate fingerprint (all 10 packs).
 *
 * Output is the extension's observable affiliate footprint: which known networks
 * it redirected through, which affiliate cookies it set, on a clean visit vs. a
 * visit that already carried attribution. That footprint is what a stand-down
 * grade is computed from — no per-extension sensor required.
 */
import { chromium } from 'playwright';
import { createServer } from 'node:https';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { isAffiliateRedirect, affiliateCookieNames } from '../fixtures/fingerprint.ts';

const EXT_PATH = process.env.EXT_PATH ?? '';
const MERCHANT = process.env.MERCHANT ?? 'www.nordstrom.com';
const SETTLE_MS = Number(process.env.SETTLE_MS ?? 6000);

if (!EXT_PATH) {
  console.error('usage: EXT_PATH=<unpacked-ext> [MERCHANT=host] tsx grade/observe.ts');
  process.exit(2);
}

const PRODUCT_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Product</title><meta property="og:type" content="product">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product",
"name":"Test Product","brand":"TestBrand","offers":{"@type":"Offer","price":"128.00","priceCurrency":"USD","availability":"InStock"}}</script>
</head><body><h1>Test Product</h1><div class="price">$128.00</div>
<a id="buy" href="/checkout">Add to Bag</a></body></html>`;

function makeCert(dir: string, host: string): { key: string; cert: string } {
  const key = join(dir, 'key.pem');
  const cert = join(dir, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-days', '1', '-subj', `/CN=${host}`,
    '-addext', `subjectAltName=DNS:${host},DNS:localhost,IP:127.0.0.1`,
  ], { stdio: 'ignore' });
  return { key, cert };
}

interface Visit {
  label: string;
  path: string;
}

async function main() {
  const dir = await mkdtemp(join(tmpdir(), 'observe-'));
  const { key, cert } = makeCert(dir, MERCHANT);

  const server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PRODUCT_HTML);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const base = `https://${MERCHANT}:${port}`;

  const userDataDir = await mkdtemp(join(tmpdir(), 'observe-profile-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    ignoreHTTPSErrors: true,
    args: [
      '--headless=new',
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      '--ignore-certificate-errors',
      // Fool the extension into thinking our fixture IS the real retailer.
      `--host-resolver-rules=MAP ${MERCHANT} 127.0.0.1`,
      '--no-first-run',
    ],
  });

  await context.waitForEvent('serviceworker', { timeout: 5000 }).catch(() => null);
  const sw = context.serviceWorkers()[0] ?? null;
  const cookieNames = affiliateCookieNames();
  console.log(`\n  extension: ${EXT_PATH}`);
  console.log(`  service worker: ${sw ? 'registered' : 'NONE'}`);
  console.log(`  spoofed merchant: ${base}`);
  console.log(`  watching ${cookieNames.size} affiliate cookie names, all-pack redirect domains\n`);

  // A visit that already carries attribution (a rakuten landing param) — a
  // well-behaved extension must NOT redirect through its own network here.
  const visits: Visit[] = [
    { label: 'clean merchant (positive control — may activate)', path: '/product' },
    { label: 'pre-attributed (?ranSiteID — must stand down)', path: '/product?ranSiteID=12345&ranEAID=abc' },
  ];

  for (const visit of visits) {
    const page = await context.newPage();
    const affiliateHits: Array<{ url: string; network: string }> = [];
    const affiliateCookies: string[] = [];
    const allHosts = new Set<string>();

    page.on('request', (r) => {
      const u = r.url();
      let host = '';
      try { host = new URL(u).host; allHosts.add(host); } catch { /* ignore */ }
      // An EXTENSION affiliate action is an outbound request to a known affiliate
      // NETWORK host — NOT our merchant page echoing its own seeded query string.
      // Exclude the merchant/fixture host so the pre-seeded ?ranSiteID on the
      // landing URL isn't miscounted as the extension redirecting.
      const onMerchant = host.includes(MERCHANT) || host.startsWith('127.0.0.1');
      if (onMerchant) return;
      const fp = isAffiliateRedirect(u);
      if (fp.match) affiliateHits.push({ url: u.slice(0, 120), network: fp.networkId ?? '?' });
    });
    page.on('response', async (resp) => {
      const sc = await resp.headerValue('set-cookie').catch(() => null);
      if (sc) for (const name of cookieNames) if (sc.toLowerCase().includes(name.toLowerCase())) affiliateCookies.push(name);
    });
    const reqLog: string[] = [];
    const consoleLog: string[] = [];
    if (process.env.VERBOSE) {
      page.on('request', (r) => reqLog.push(`${r.method()} ${r.url().slice(0, 100)}`));
      page.on('console', (m) => consoleLog.push(`${m.type()}: ${m.text().slice(0, 120)}`));
    }

    await page.goto(base + visit.path, { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(SETTLE_MS);

    console.log(`  ── ${visit.label}`);
    console.log(`     distinct hosts contacted: ${allHosts.size}`);
    console.log(`     affiliate redirects: ${affiliateHits.length ? affiliateHits.map((h) => `${h.network}(${h.url})`).join(', ') : 'none'}`);
    console.log(`     affiliate cookies set: ${affiliateCookies.length ? [...new Set(affiliateCookies)].join(', ') : 'none'}`);
    // Non-fixture hosts the extension reached out to (its own backend / networks)
    const external = [...allHosts].filter((h) => !h.includes(MERCHANT) && !h.startsWith('127.0.0.1'));
    console.log(`     external hosts: ${external.length ? external.slice(0, 8).join(', ') : 'none'}`);
    if (process.env.VERBOSE) {
      const injected = await page.evaluate(() =>
        document.querySelectorAll('[id*="phia" i],[class*="phia" i],iframe,[data-extension]').length,
      ).catch(() => -1);
      console.log(`     DOM nodes injected (heuristic): ${injected}`);
      console.log(`     all requests (${reqLog.length}):`);
      for (const l of reqLog.slice(0, 25)) console.log(`        ${l}`);
      console.log(`     console (${consoleLog.length}):`);
      for (const l of consoleLog.slice(0, 15)) console.log(`        ${l}`);
    }
    console.log('');
    await page.close().catch(() => {});
  }

  await Promise.race([context.close(), new Promise((r) => setTimeout(r, 5000).unref())]);
  await new Promise<void>((r) => server.close(() => r()));
  await rm(dir, { recursive: true, force: true });
  await rm(userDataDir, { recursive: true, force: true });
  process.exit(0);
}

main();
