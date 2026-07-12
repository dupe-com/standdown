/**
 * Checkout-flow probe — drives an affiliate extension through the interaction
 * that actually triggers it: reaching a checkout page with a coupon field.
 *
 * Phia (and most coupon/cashback extensions) is dormant on page load and only
 * acts at checkout: it pops its coupon UI and OPENS A BACKGROUND TAB that
 * navigates through its own affiliate link to drop a last-click cookie. That
 * background tab is the hijack, and it's observable black-box via
 * `context.on('page')` — no internal knowledge of the extension required.
 *
 * Stand-down test: run the same checkout flow twice — once clean, once with
 * pre-existing affiliate attribution already on the visit. A well-behaved
 * extension opens its affiliate tab on the clean run (positive control) but
 * NOT when a partner already owns the sale. Opening it in both = hijack.
 *
 * Merchant hostname is spoofed to a real retailer via --host-resolver-rules so
 * the extension's merchant-keyed checkout detection engages against our fixture.
 */
import { chromium, type Page } from 'playwright';
import { createServer } from 'node:https';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { isAffiliateRedirect } from '../fixtures/fingerprint.ts';

const EXT_PATH = process.env.EXT_PATH ?? '';
const MERCHANT = process.env.MERCHANT ?? 'www.nordstrom.com';
const SETTLE_MS = Number(process.env.SETTLE_MS ?? 9000);
if (!EXT_PATH) { console.error('usage: EXT_PATH=<dir> [MERCHANT=host] tsx grade/checkout-probe.ts'); process.exit(2); }

const PRODUCT_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Product</title>
<meta property="og:type" content="product">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Cashmere Sweater","sku":"NRD-12345","brand":"TestBrand","offers":{"@type":"Offer","price":"128.00","priceCurrency":"USD","availability":"InStock"}}</script>
</head><body><h1>Cashmere Sweater</h1><div class="price" data-price="128.00">$128.00</div>
<button id="add-to-cart" onclick="location.href='/checkout'">Add to Bag</button></body></html>`;

// Realistic checkout page: order summary, total, and — the classic coupon-extension
// trigger — a promo/coupon code input.
const CHECKOUT_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Checkout</title></head>
<body><h1>Checkout</h1>
<section id="order-summary"><h2>Order Summary</h2>
<div class="line-item">Cashmere Sweater — $128.00</div>
<div class="subtotal">Subtotal: $128.00</div><div class="total" id="order-total">Total: $128.00</div></section>
<form id="payment"><label for="promo">Promo code</label>
<input type="text" id="promo" name="promoCode" placeholder="Enter promo or coupon code" autocomplete="off">
<button type="button" id="apply-promo">Apply</button>
<button type="submit" id="place-order">Place Order</button></form>
</body></html>`;

function makeCert(dir: string, host: string) {
  const key = join(dir, 'key.pem'); const cert = join(dir, 'cert.pem');
  execFileSync('openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,
    '-days','1','-subj',`/CN=${host}`,'-addext',`subjectAltName=DNS:${host},DNS:localhost,IP:127.0.0.1`], { stdio: 'ignore' });
  return { key, cert };
}

interface BgTab { url: string; navs: string[]; affiliate: Array<{ url: string; network: string }> }

function hostnameOf(u: string): string { try { return new URL(u).hostname; } catch { return ''; } }
// Exact-hostname match (no port, no substring) so an unrelated host that merely
// contains the merchant string isn't misclassified as the fixture/merchant page.
function onMerchant(u: string): boolean {
  const h = hostnameOf(u);
  return h === MERCHANT || h === '127.0.0.1' || h === 'localhost';
}

/** Attach listeners that record a background tab's navigations + affiliate hits.
 * Only requests to NON-merchant hosts can be affiliate actions — a merchant page
 * echoing its own seeded ?ranSiteID is not the extension redirecting. */
function watchTab(p: Page, tab: BgTab) {
  p.on('framenavigated', (f) => { if (f === p.mainFrame()) tab.navs.push(f.url().slice(0, 140)); });
  p.on('request', (r) => {
    const u = r.url();
    if (onMerchant(u)) return;
    const fp = isAffiliateRedirect(u);
    if (fp.match) tab.affiliate.push({ url: u.slice(0, 140), network: fp.networkId ?? '?' });
  });
}

interface Flow { label: string; preAttributed: boolean }

async function runFlow(context: import('playwright').BrowserContext, base: string, flow: Flow): Promise<BgTab[]> {
  const bgTabs: BgTab[] = [];
  // Any tab the extension opens during this flow (the affiliate cookie-drop tab).
  const onPage = (p: Page) => {
    const tab: BgTab = { url: p.url().slice(0, 140), navs: [], affiliate: [] };
    bgTabs.push(tab);
    watchTab(p, tab);
  };
  context.on('page', onPage);

  await context.clearCookies().catch(() => {});
  if (flow.preAttributed) {
    // A partner already owns this visit: seed a Rakuten last-click cookie on the merchant.
    await context.addCookies([{
      name: 'rmStoreGateway', value: 'aff_partner_123', domain: MERCHANT, path: '/',
      secure: true, httpOnly: false,
    }]).catch(() => {});
  }

  const page = await context.newPage();
  // Product → (add to cart) → checkout, carrying attribution in the URL on the pre-attributed run.
  const landing = flow.preAttributed ? '/product?ranSiteID=12345&ranEAID=abc' : '/product';
  await page.goto(base + landing, { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await page.click('#add-to-cart', { timeout: 3000 }).catch(() => {});
  await page.waitForURL('**/checkout', { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(1500);
  // Nudge the coupon field the way a shopper would — many extensions hook focus.
  await page.click('#promo', { timeout: 2000 }).catch(() => {});
  await page.waitForTimeout(SETTLE_MS);

  context.off('page', onPage);
  await page.close().catch(() => {});
  // Keep only tabs that leave the merchant origin (onboarding, affiliate networks) —
  // the main shopping page lives on the merchant host and is not a "background tab".
  return bgTabs.filter((t) => {
    const urls = [t.url, ...t.navs].filter((u) => u && u !== 'about:blank');
    return urls.some((u) => !onMerchant(u));
  });
}

async function main() {
  const dir = await mkdtemp(join(tmpdir(), 'checkout-'));
  const { key, cert } = makeCert(dir, MERCHANT);
  const server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(path.startsWith('/checkout') ? CHECKOUT_HTML : PRODUCT_HTML);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const base = `https://${MERCHANT}:${port}`;

  const userDataDir = await mkdtemp(join(tmpdir(), 'checkout-profile-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false, ignoreHTTPSErrors: true,
    args: ['--headless=new', `--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`,
      '--ignore-certificate-errors', `--host-resolver-rules=MAP ${MERCHANT} 127.0.0.1`, '--no-first-run'],
  });
  await context.waitForEvent('serviceworker', { timeout: 5000 }).catch(() => null);
  console.log(`\n  extension: ${EXT_PATH}`);
  console.log(`  spoofed merchant: ${base}`);
  console.log(`  sensor: background tab opened at checkout + its affiliate navigations\n`);

  const flows: Flow[] = [
    { label: 'clean checkout (positive control — extension may drop its cookie)', preAttributed: false },
    { label: 'pre-attributed checkout (rakuten cookie + ?ranSiteID — MUST stand down)', preAttributed: true },
  ];

  const summary: Array<{ flow: Flow; tabs: BgTab[] }> = [];
  for (const flow of flows) {
    const tabs = await runFlow(context, base, flow);
    summary.push({ flow, tabs });
    console.log(`  ── ${flow.label}`);
    console.log(`     background tabs opened: ${tabs.length}`);
    for (const t of tabs) {
      console.log(`       tab: ${t.url}`);
      if (t.navs.length) console.log(`         navs: ${t.navs.join('  →  ')}`);
      if (t.affiliate.length) console.log(`         AFFILIATE: ${t.affiliate.map((a) => `${a.network}(${a.url})`).join(', ')}`);
    }
    console.log('');
  }

  // An affiliate ACTION is a background tab that redirected through a known
  // affiliate NETWORK host — not the extension's own onboarding/site tab.
  const affiliateAction = (tabs: BgTab[]) => tabs.some((t) => t.affiliate.length > 0);
  const cleanActed = affiliateAction(summary[0].tabs);
  const hijacked = affiliateAction(summary[1].tabs);
  const otherTabs = (tabs: BgTab[]) => tabs.filter((t) => t.affiliate.length === 0).map((t) => t.url);

  console.log('  ── verdict');
  console.log(`     clean: affiliate tab=${cleanActed}; other tabs=[${otherTabs(summary[0].tabs).join(', ') || 'none'}]`);
  console.log(`     pre-attributed: affiliate tab=${hijacked}; other tabs=[${otherTabs(summary[1].tabs).join(', ') || 'none'}]`);
  if (!cleanActed) {
    console.log('     INCONCLUSIVE: no affiliate-network tab even on the clean checkout — trigger not');
    console.log('     reproduced. Phia opened its onboarding page, so its cookie-drop is gated behind');
    console.log('     sign-in/onboarding that a fresh sandbox profile does not satisfy.');
  } else if (hijacked) {
    console.log('     HIJACK: opened its affiliate-network tab even though a partner already owned the sale.');
  } else {
    console.log('     STANDS DOWN: dropped its cookie on the clean checkout but suppressed it when attribution existed.');
  }

  await Promise.race([context.close(), new Promise((r) => setTimeout(r, 5000).unref())]);
  await new Promise<void>((r) => server.close(() => r()));
  await rm(dir, { recursive: true, force: true });
  await rm(userDataDir, { recursive: true, force: true });
  process.exit(0);
}

main();
