/**
 * Baseline conformance probe for Dupe's REAL browser extension (Phase 0 baseline
 * = the behavioral spec we must preserve when the standdown library is later
 * introduced as a shadow observer).
 *
 * What it grades: does the extension ACTIVATE (paint its own attribution surface
 * onto a merchant page) when it shouldn't — i.e. when a partner already owns the
 * sale — and does it correctly ACTIVATE on clean pages where it's allowed to
 * earn the click. Same F→A+ rubric as every other probe (grade/rubric.ts),
 * including the inert cap.
 *
 * Strictly black-box. Two rules this file must never break (a prior version was
 * deleted for breaking both):
 *   1. NO hardcoded user/build paths. The extension build dir comes from EXT_PATH
 *      (env) or argv[2]. Nothing else.
 *   2. NEVER read Dupe-internal storage keys (e.g. the `__dupe__…stand-down`
 *      sessionStorage flag). The only sensors are things any user could see:
 *        (a) the extension's own UI rendered into the merchant DOM — its wxt
 *            shadow hosts (`dupe-onpage`, `dupe-price-element`, …) with real
 *            rendered content, which `standDown` gates; the host element mounts
 *            unconditionally, so we require non-empty rendered content, not mere
 *            presence, to avoid a false "activated".
 *        (b) an outbound affiliate-network action (redirect / cookie), classified
 *            with the shared policy-pack fingerprint (fixtures/fingerprint.ts).
 *
 * How a synthetic fixture triggers the real, merchant-keyed extension: Chromium
 * `--host-resolver-rules="MAP <merchant> 127.0.0.1"` (per merchant host, NOT a
 * catch-all — dupe.com and the real networks must still resolve so the extension
 * can load its live policy) + a self-signed cert whose SAN covers every merchant
 * host + `--ignore-certificate-errors`. The extension believes it is on the real
 * retailer while we serve a page we fully control. Technique shared with
 * grade/observe.ts and grade/checkout-probe.ts.
 *
 * INCONCLUSIVE ≠ FAIL: if the extension never activates on ANY positive control
 * (policy never loaded, product context / auth not satisfied in the sandbox),
 * the rubric's inert cap fires and the grade is flagged — we do NOT report a
 * disciplined "A+" for what might be dead code, and we do NOT accuse it of
 * hijacking. Read an inert result as "could not exercise here", not "passes".
 */
import { chromium, type BrowserContext, type Page } from 'playwright';
import { createServer } from 'node:https';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { isAffiliateRedirect, affiliateCookieNames } from '../fixtures/fingerprint.ts';
import { grade } from './rubric.ts';
import type { ScenarioObservation } from './harness.ts';
import type { Scenario } from '../fixtures/scenarios.ts';

const EXT_PATH = process.env.EXT_PATH ?? process.argv[2] ?? '';
const SETTLE_MS = Number(process.env.SETTLE_MS ?? 6000);
const VERBOSE = !!process.env.VERBOSE;

if (!EXT_PATH) {
  console.error(
    'usage: EXT_PATH=<path-to-unpacked-extension> tsx grade/dupe-extension-probe.ts\n' +
      '   or: tsx grade/dupe-extension-probe.ts <path-to-unpacked-extension>\n\n' +
      'The path is the extension build output (e.g. apps/extension/.output/chrome-mv3).\n' +
      'No path is hardcoded — you MUST supply your own build dir.',
  );
  process.exit(2);
}

/**
 * A baseline scenario. `expectActivate` encodes the Phase-0 spec:
 *   false → a partner already owns the sale (or a merchant is on Dupe's
 *           unconditional disable list): the extension MUST stand down (paint
 *           nothing, take no affiliate action).
 *   true  → clean / allowed traffic: the extension is expected to activate.
 * `cookie` seeds a first-party attribution cookie on the merchant before nav.
 */
interface BaselineScenario {
  id: string;
  networkId: string;
  host: string;
  path: string;
  cookie?: { name: string; value: string };
  expectActivate: boolean;
  note: string;
}

/**
 * Phase-0 baseline matrix, derived from the extension's live stand-down policy
 * behavior (see the migration parity report). Hosts are real retailers so the
 * extension's merchant-keyed logic (disable_domains, ALLOW_AMAZON, …) engages;
 * we spoof each one to our fixture.
 */
const SCENARIOS: BaselineScenario[] = [
  // ── stand-down expected: prior attribution already present ──────────────────
  {
    id: 'rakuten:attribution:landing-param',
    networkId: 'rakuten',
    host: 'www.nordstrom.com',
    path: '/product?ranSiteID=29T8xR4CT5-abc&ranEAID=xyz',
    expectActivate: false,
    note: 'Rakuten ranSiteID+ranEAID present → partner owns it → stand down',
  },
  {
    id: 'cj:attribution:landing-param',
    networkId: 'cj',
    host: 'www.nordstrom.com',
    path: '/product?cjevent=abc123def456',
    expectActivate: false,
    note: 'CJ cjevent present → stand down',
  },
  {
    id: 'impact:attribution:landing-param',
    networkId: 'impact',
    host: 'www.nordstrom.com',
    path: '/product?irgwc=1&irclickid=abc',
    expectActivate: false,
    note: 'Impact irgwc present → stand down (baseline server policy includes impact)',
  },
  {
    id: 'rakuten:attribution:cookie',
    networkId: 'rakuten',
    host: 'www.nordstrom.com',
    path: '/product',
    cookie: { name: 'lsclick_mid_12345', value: 'aff_partner' },
    expectActivate: false,
    note: 'Rakuten/LinkShare lsclick_mid cookie present → stand down',
  },
  {
    id: 'ebay:disable-domain',
    networkId: 'ebay',
    host: 'www.ebay.com',
    path: '/itm/1234567890',
    expectActivate: false,
    note: 'ebay is an unconditional disable_domain → stand down regardless of params',
  },
  {
    id: 'homedepot:disable-domain',
    networkId: 'homedepot',
    host: 'www.homedepot.com',
    path: '/p/Some-Product/123456',
    expectActivate: false,
    note: 'homedepot.com is an unconditional disable_domain → stand down',
  },
  {
    id: 'aliexpress:disable-domain',
    networkId: 'aliexpress',
    host: 'www.aliexpress.com',
    path: '/item/1005001234567890.html',
    expectActivate: false,
    note: 'aliexpress.com is an unconditional disable_domain → stand down',
  },
  {
    id: 'shein:disable-domain',
    networkId: 'shein',
    host: 'www.shein.com',
    path: '/product-p-12345.html',
    expectActivate: false,
    note: 'shein.com is an unconditional disable_domain → stand down',
  },

  // ── positive controls: clean / allowed traffic — extension SHOULD activate ──
  {
    id: 'control:clean-merchant',
    networkId: 'none',
    host: 'www.nordstrom.com',
    path: '/product',
    expectActivate: true,
    note: 'Clean retailer, no attribution → extension is allowed to activate',
  },
  {
    id: 'control:amazon-allowed',
    networkId: 'amazon',
    host: 'www.amazon.com',
    path: '/dp/B0EXAMPLE01',
    expectActivate: true,
    note: 'ALLOW_AMAZON=true → extension stays ACTIVE on Amazon (baseline behavior)',
  },
  {
    id: 'control:wayfair-allowed',
    networkId: 'wayfair',
    host: 'www.wayfair.com',
    path: '/furniture/pdp/example-w1234.html',
    expectActivate: true,
    note: 'Wayfair filtered out of client policy → extension stays ACTIVE',
  },
  {
    id: 'control:self-click-exemption',
    networkId: 'cj',
    host: 'www.nordstrom.com',
    path: '/product?cjevent=abc123&cp=hello_Dupe.com',
    expectActivate: true,
    note: "Dupe self-click ignore_param (cp contains _Dupe.com) clears the CJ match → activate",
  },
];

const PRODUCT_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Product</title><meta property="og:type" content="product">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product",
"name":"Test Product","brand":"TestBrand","sku":"SKU-12345",
"offers":{"@type":"Offer","price":"128.00","priceCurrency":"USD","availability":"https://schema.org/InStock"}}</script>
</head><body><h1>Test Product</h1>
<div class="price" data-price="128.00" id="price">$128.00</div>
<a id="buy" href="/checkout">Add to Bag</a></body></html>`;

function makeCert(dir: string, hosts: readonly string[]): { key: string; cert: string } {
  const key = join(dir, 'key.pem');
  const cert = join(dir, 'cert.pem');
  const san = [...hosts.map((h) => `DNS:${h}`), 'DNS:localhost', 'IP:127.0.0.1'].join(',');
  execFileSync(
    'openssl',
    [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
      '-days', '1', '-subj', '/CN=standdown-audit-fixture', '-addext', `subjectAltName=${san}`,
    ],
    { stdio: 'ignore' },
  );
  return { key, cert };
}

/** True when the merchant host (or the fixture IP) served the request itself —
 * used to exclude the merchant page echoing its own seeded ?ranSiteID etc. from
 * being miscounted as the extension taking an affiliate action. */
function servedByFixture(reqUrl: string, merchant: string): boolean {
  try {
    // Exact hostname (no port, no substring) so an unrelated host that merely
    // contains the merchant string isn't treated as fixture-served.
    const h = new URL(reqUrl).hostname;
    return h === merchant || h === '127.0.0.1' || h === 'localhost';
  } catch {
    return false;
  }
}

/**
 * The DOM sensor. Returns whether the extension has painted its own UI with real
 * rendered content. We look at the extension's wxt shadow hosts (custom elements
 * whose tag begins with `dupe-`, each carrying a `wxt-shadow-root`) and require
 * NON-EMPTY rendered content inside the shadow root — ignoring the injected
 * <style>/<link> that wxt mounts even when React renders null under stand-down.
 * We deliberately do NOT read `window.__dupe_detection` or any sessionStorage:
 * detection runs even while stood down, so those are not activation signals.
 */
async function domActivated(page: Page): Promise<{ activated: boolean; detail: string }> {
  return page
    .evaluate(() => {
      const hosts = Array.from(document.querySelectorAll('*')).filter((el) => {
        const tag = el.tagName.toLowerCase();
        return tag.startsWith('dupe-') || (tag.includes('dupe') && !!(el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot);
      });
      const painted: string[] = [];
      for (const host of hosts) {
        const root = (host as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
        const scope: ParentNode = root ?? host;
        const rendered = Array.from(scope.querySelectorAll('*')).filter(
          (n) => !['STYLE', 'LINK', 'SCRIPT'].includes(n.tagName),
        );
        if (rendered.length > 0) painted.push(`${host.tagName.toLowerCase()}(${rendered.length})`);
      }
      // Light-DOM price badges the extension injects inline next to prices.
      const badges = document.querySelectorAll(
        '[class*="dupe-price" i],[id*="dupe-price" i],[class*="dupe-tab" i],[id*="dupe-tab" i]',
      ).length;
      if (badges > 0) painted.push(`price-badge(${badges})`);
      return { activated: painted.length > 0, detail: painted.join(', ') };
    })
    .catch(() => ({ activated: false, detail: 'eval-failed' }));
}

interface ProbeResult {
  scenario: BaselineScenario;
  activated: boolean;
  evidence: string;
}

async function runScenario(
  context: BrowserContext,
  port: number,
  scenario: BaselineScenario,
): Promise<ProbeResult> {
  const cookieNames = affiliateCookieNames();
  await context.clearCookies().catch(() => {});
  if (scenario.cookie) {
    await context
      .addCookies([
        {
          name: scenario.cookie.name,
          value: scenario.cookie.value,
          domain: scenario.host,
          path: '/',
          secure: true,
          httpOnly: false,
        },
      ])
      .catch(() => {});
  }

  const page = await context.newPage();
  const affiliateHits: string[] = [];
  const affiliateCookies: string[] = [];

  page.on('request', (r) => {
    const u = r.url();
    if (servedByFixture(u, scenario.host)) return; // merchant echoing its own params is not an ext action
    const fp = isAffiliateRedirect(u);
    if (fp.match) affiliateHits.push(`${fp.networkId}(${new URL(u).host})`);
  });
  page.on('response', async (resp) => {
    // Set-Cookie can appear multiple times; match on the cookie NAME (before '='),
    // not a substring of the whole header (which could hit a value).
    const headers = await resp.headersArray().catch(() => []);
    for (const h of headers) {
      if (h.name.toLowerCase() !== 'set-cookie') continue;
      const cookieName = h.value.split('=', 1)[0]!.trim().toLowerCase();
      for (const name of cookieNames) if (cookieName === name.toLowerCase()) affiliateCookies.push(name);
    }
  });

  const url = `https://${scenario.host}:${port}${scenario.path}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => {});
  await page.waitForTimeout(SETTLE_MS);

  const dom = await domActivated(page);
  const activated = dom.activated || affiliateHits.length > 0 || affiliateCookies.length > 0;

  const parts: string[] = [];
  if (dom.activated) parts.push(`ui[${dom.detail}]`);
  if (affiliateHits.length) parts.push(`redirect[${[...new Set(affiliateHits)].join(', ')}]`);
  if (affiliateCookies.length) parts.push(`cookie[${[...new Set(affiliateCookies)].join(', ')}]`);
  const evidence = activated ? `activated: ${parts.join(' ')}` : 'no observable activation';

  if (VERBOSE) console.log(`  · ${scenario.id.padEnd(34)} activated=${activated} ${evidence}`);
  await page.close().catch(() => {});
  return { scenario, activated, evidence };
}

/** Adapt a black-box probe result to the shared rubric's ScenarioObservation. */
function toObservation(r: ProbeResult): ScenarioObservation {
  const expectedIntroduce = r.scenario.expectActivate;
  const scenario: Scenario = {
    id: r.scenario.id,
    networkId: r.scenario.networkId,
    kind: r.scenario.expectActivate ? 'control-direct' : 'attribution',
    description: r.scenario.note,
    signals: { url: `https://${r.scenario.host}${r.scenario.path}`, now: 0 },
    landingPath: r.scenario.path,
    expectStandDown: !r.scenario.expectActivate,
  };
  return {
    scenario,
    introducedAttribution: r.activated,
    expectedIntroduce,
    passed: r.activated === expectedIntroduce,
    evidence: r.evidence,
  };
}

async function main() {
  const hosts = [...new Set(SCENARIOS.map((s) => s.host))];
  const dir = await mkdtemp(join(tmpdir(), 'dupe-probe-'));
  const { key, cert } = makeCert(dir, hosts);

  const server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PRODUCT_HTML);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;

  const userDataDir = await mkdtemp(join(tmpdir(), 'dupe-probe-profile-'));
  // Per-host MAP (NOT `MAP * 127.0.0.1`): dupe.com and the real affiliate hosts
  // must keep resolving so the extension can load its live policy and so an
  // outbound affiliate redirect is observable as a real off-fixture request.
  const resolverRules = hosts.map((h) => `MAP ${h} 127.0.0.1`).join(', ');
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    ignoreHTTPSErrors: true,
    args: [
      '--headless=new',
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      '--ignore-certificate-errors',
      `--host-resolver-rules=${resolverRules}`,
      '--no-first-run',
    ],
  });
  await context.waitForEvent('serviceworker', { timeout: 6000 }).catch(() => null);
  const sw = context.serviceWorkers()[0] ?? null;

  console.log(`\n  standdown — Dupe extension baseline conformance probe`);
  console.log(`  extension: ${EXT_PATH}`);
  console.log(`  service worker: ${sw ? 'registered' : 'NONE (activation likely inconclusive)'}`);
  console.log(`  spoofed merchant hosts: ${hosts.join(', ')}`);
  console.log(`  sensor: rendered Dupe UI in merchant DOM + affiliate-network redirect/cookie\n`);

  const results: ProbeResult[] = [];
  for (const scenario of SCENARIOS) {
    const r = await runScenario(context, port, scenario);
    results.push(r);
    const tag = r.scenario.expectActivate
      ? r.activated ? 'ok  ' : 'MISS'
      : r.activated ? 'HIJACK' : 'ok  ';
    console.log(`  [${tag}] ${r.scenario.id.padEnd(34)} ${r.evidence}`);
  }

  const observations = results.map(toObservation);
  const result = grade(observations);

  console.log(`\n  standdown grade: ${result.letter}  (${result.score}/100)`);
  console.log(`  ${result.note}`);
  if (result.inert) {
    console.log(
      `\n  INCONCLUSIVE, not FAIL: the extension never activated on any positive control in\n` +
        `  this sandbox (policy/product/auth context may be unmet). This is "could not\n` +
        `  exercise here", NOT "hijacks" and NOT a clean pass. Re-run with a build that can\n` +
        `  load its policy, or investigate service-worker/policy load before trusting a grade.`,
    );
  }
  if (result.hijacks.length) {
    console.log(`\n  HIJACKS (activated where a partner already owned the sale):`);
    for (const h of result.hijacks) console.log(`    - ${h.scenario.id}: ${h.evidence}`);
  }
  console.log('');

  await Promise.race([context.close(), new Promise((r) => setTimeout(r, 5000).unref())]);
  await new Promise<void>((r) => server.close(() => r()));
  await rm(dir, { recursive: true, force: true });
  await rm(userDataDir, { recursive: true, force: true });
  process.exit(0);
}

main();
