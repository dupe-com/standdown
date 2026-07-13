/**
 * In-browser SHADOW run. Loads the host extension built with the standdown
 * shadow ENABLED, navigates the real-merchant scenario matrix (spoofed to a
 * local fixture, same technique as host-extension-probe.ts), and captures the
 * `[standdown-shadow]` console divergence logs the observer emits on each page.
 *
 * This does NOT grade the extension; it validates that the observer FIRES in a
 * real content-script context and that its decisions match the current detector.
 *
 *   EXT_PATH=<unpacked ext with shadow ON> npx tsx audit/grade/shadow-run-probe.ts
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
const SETTLE_MS = Number(process.env.SETTLE_MS ?? 6000);
if (!EXT_PATH) {
  console.error('usage: EXT_PATH=<path-to-unpacked-extension-with-shadow-ON> npx tsx audit/grade/shadow-run-probe.ts');
  process.exit(2);
}

interface Scen {
  id: string;
  host: string;
  path: string;
  cookie?: { name: string; value: string };
  expectCurrentStandDown: boolean; // what the current extension does
}

const SCENARIOS: Scen[] = [
  { id: 'cj:cjevent', host: 'www.nordstrom.com', path: '/product?cjevent=abc123def456', expectCurrentStandDown: true },
  { id: 'rakuten:ranSiteID', host: 'www.nordstrom.com', path: '/product?ranSiteID=aff123', expectCurrentStandDown: true },
  { id: 'rakuten:bare-ranEAID(D1)', host: 'www.nordstrom.com', path: '/product?ranEAID=xyz', expectCurrentStandDown: true },
  { id: 'impact:irgwc', host: 'www.nordstrom.com', path: '/product?irgwc=1', expectCurrentStandDown: true },
  { id: 'ebay:disable-domain', host: 'www.ebay.com', path: '/itm/1234567890', expectCurrentStandDown: true },
  { id: 'homedepot:disable-domain', host: 'www.homedepot.com', path: '/p/Some-Product/123456', expectCurrentStandDown: true },
  { id: 'rakuten:cookie-name', host: 'www.nordstrom.com', path: '/product', cookie: { name: 'lsclick_mid_12345', value: 'aff' }, expectCurrentStandDown: true },
  { id: 'self-click:rakuten', host: 'www.nordstrom.com', path: '/product?ranSiteID=preEXAMPLESITEIDpost', expectCurrentStandDown: false },
  { id: 'self-click:cj', host: 'www.nordstrom.com', path: '/product?cjevent=abc&cp=x_examplebrand', expectCurrentStandDown: false },
  { id: 'control:amazon', host: 'www.amazon.com', path: '/dp/B00EXAMPLE', expectCurrentStandDown: false },
  { id: 'control:clean', host: 'www.nordstrom.com', path: '/product', expectCurrentStandDown: false },
];

const PRODUCT_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Product</title>
<meta property="og:type" content="product">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Test","offers":{"@type":"Offer","price":"99.00","priceCurrency":"USD"}}</script>
</head><body><h1>Test Product</h1><div class="price" id="price">$99.00</div><a id="buy" href="/checkout">Add to Bag</a></body></html>`;

function makeCert(dir: string, hosts: readonly string[]) {
  const key = join(dir, 'key.pem');
  const cert = join(dir, 'cert.pem');
  const san = [...hosts.map((h) => `DNS:${h}`), 'DNS:localhost', 'IP:127.0.0.1'].join(',');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-days', '1', '-subj', '/CN=standdown-shadow-fixture', '-addext', `subjectAltName=${san}`], { stdio: 'ignore' });
  return { key, cert };
}

interface ShadowLog { type: string; text: string }

async function runScenario(ctx: BrowserContext, port: number, s: Scen) {
  await ctx.clearCookies().catch(() => {});
  if (s.cookie) {
    await ctx.addCookies([{ name: s.cookie.name, value: s.cookie.value, domain: s.host, path: '/', secure: true, httpOnly: false }]).catch(() => {});
  }
  const page = await ctx.newPage();
  const shadow: ShadowLog[] = [];
  let totalConsole = 0;
  page.on('console', (m) => {
    totalConsole++;
    const t = m.text();
    if (t.includes('[standdown-shadow]')) shadow.push({ type: m.type(), text: t });
  });
  page.on('pageerror', () => {});
  const url = `https://${s.host}:${port}${s.path}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => {});
  await page.waitForTimeout(SETTLE_MS);
  await page.close().catch(() => {});
  return { shadow, totalConsole };
}

function parseDecision(text: string): { standDown?: boolean; kind: 'DIVERGENCE' | 'agree' | '?' } {
  const kind = text.includes('DIVERGENCE') ? 'DIVERGENCE' : text.includes('agree') ? 'agree' : '?';
  const m = text.match(/standdown=(true|false)/);
  return { standDown: m ? m[1] === 'true' : undefined, kind };
}

async function main() {
  const hosts = [...new Set(SCENARIOS.map((s) => s.host))];
  const dir = await mkdtemp(join(tmpdir(), 'shadow-run-'));
  const { key, cert } = makeCert(dir, hosts);
  const server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (_q, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PRODUCT_HTML);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;

  const userDataDir = await mkdtemp(join(tmpdir(), 'shadow-run-profile-'));
  const resolverRules = hosts.map((h) => `MAP ${h} 127.0.0.1`).join(', ');
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    ignoreHTTPSErrors: true,
    args: ['--headless=new', `--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`,
      '--ignore-certificate-errors', `--host-resolver-rules=${resolverRules}`, '--no-first-run'],
  });
  await ctx.waitForEvent('serviceworker', { timeout: 6000 }).catch(() => null);
  const sw = ctx.serviceWorkers()[0] ?? null;

  console.log(`\n  standdown — in-browser SHADOW run`);
  console.log(`  extension: ${EXT_PATH}`);
  console.log(`  service worker: ${sw ? 'registered' : 'NONE'}\n`);
  console.log(`  ${'SCENARIO'.padEnd(28)} ${'fired'.padEnd(6)} ${'sd'.padEnd(6)} ${'current'.padEnd(8)} result`);
  console.log('  ' + '-'.repeat(78));

  let fired = 0;
  const diverge: string[] = [];
  for (const s of SCENARIOS) {
    const { shadow, totalConsole } = await runScenario(ctx, port, s);
    const decisionLog = shadow.find((l) => /standdown=(true|false)/.test(l.text));
    if (!decisionLog) {
      console.log(`  ${s.id.padEnd(28)} ${'no'.padEnd(6)} ${'-'.padEnd(6)} ${String(s.expectCurrentStandDown).padEnd(8)} SILENT (console msgs=${totalConsole})`);
      continue;
    }
    fired++;
    const { standDown, kind } = parseDecision(decisionLog.text);
    const agree = standDown === s.expectCurrentStandDown;
    if (!agree) diverge.push(`${s.id}: standdown=${standDown} current=${s.expectCurrentStandDown}`);
    console.log(`  ${s.id.padEnd(28)} ${'yes'.padEnd(6)} ${String(standDown).padEnd(6)} ${String(s.expectCurrentStandDown).padEnd(8)} ${agree ? 'agree' : 'DIVERGE'} [${kind}]`);
  }

  console.log('  ' + '-'.repeat(78));
  console.log(`\n  shadow fired on ${fired}/${SCENARIOS.length} scenarios; ${diverge.length} divergence(s).`);
  if (fired === 0) {
    console.log(`  → SILENT everywhere: OnPage likely not mounting / content script not injecting / flag off.`);
  }
  for (const d of diverge) console.log(`    - ${d}`);
  console.log('');

  await Promise.race([ctx.close(), new Promise((r) => setTimeout(r, 5000).unref())]);
  await new Promise<void>((r) => server.close(() => r()));
  await rm(dir, { recursive: true, force: true });
  await rm(userDataDir, { recursive: true, force: true });
  process.exit(0);
}

main();
