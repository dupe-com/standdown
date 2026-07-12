/**
 * P2 risk spike: can we load the reference MV3 extension in headless Chromium,
 * wake its service worker, observe network traffic, and reach the chrome APIs
 * standdown hooks? If this is green, the Track-B browser audit is viable.
 *
 * Run: npx tsx spike/mv3-spike.ts   (from audit/)
 */
import * as esbuild from 'esbuild';
import { chromium, type BrowserContext, type Worker } from 'playwright';
import { createServer } from 'node:http';
import { mkdtemp, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..'); // ~/Work/standdown
const EXAMPLE = join(REPO, 'examples', 'mv3-extension');
const DIST = join(REPO, 'dist');

const report: Record<string, string> = {};
function mark(k: string, ok: boolean, detail = '') {
  report[k] = `${ok ? 'PASS' : 'FAIL'}${detail ? ' — ' + detail : ''}`;
}

async function bundleExtension(): Promise<string> {
  const out = join(HERE, 'ext-dist');
  await rm(out, { recursive: true, force: true });
  await esbuild.build({
    entryPoints: [join(EXAMPLE, 'background.js'), join(EXAMPLE, 'popup.js')],
    outdir: out,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'chrome120',
    logLevel: 'silent',
    alias: {
      standdown: join(DIST, 'index.mjs'),
      'standdown/webext': join(DIST, 'webext.mjs'),
      'standdown/policies': join(DIST, 'policies.mjs'),
    },
  });
  await cp(join(EXAMPLE, 'manifest.json'), join(out, 'manifest.json'));
  await cp(join(EXAMPLE, 'popup.html'), join(out, 'popup.html')).catch(() => {});
  return out;
}

/** A tiny local page so R2 needs no external network. */
async function startLocalSite() {
  const server = createServer((req, res) => {
    if (req.url === '/ping') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('pong');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><html><body><h1>merchant</h1><script>fetch("/ping")</script></body></html>');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function launch(extPath: string): Promise<{ context: BrowserContext; userDataDir: string }> {
  const userDataDir = await mkdtemp(join(tmpdir(), 'standdown-spike-'));
  // New headless mode supports extensions and needs no visible window.
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      '--headless=new',
      `--disable-extensions-except=${extPath}`,
      `--load-extension=${extPath}`,
      '--no-first-run',
    ],
  });
  return { context, userDataDir };
}

async function getServiceWorker(context: BrowserContext): Promise<Worker | null> {
  const existing = context.serviceWorkers();
  if (existing.length) return existing[0];
  try {
    return await context.waitForEvent('serviceworker', { timeout: 8000 });
  } catch {
    return null;
  }
}

async function main() {
  const extPath = await bundleExtension();
  mark('bundle', true, 'esbuild ok');

  const site = await startLocalSite();
  const { context, userDataDir } = await launch(extPath);

  try {
    // R1 — service worker wakes
    const sw = await getServiceWorker(context);
    const extId = sw ? new URL(sw.url()).host : '';
    mark('R1_service_worker', !!sw, sw ? `id=${extId} url=${sw.url().split('/').pop()}` : 'no SW within 8s');

    // R1b — the chrome APIs standdown hooks are present inside the SW
    if (sw) {
      const apis = await sw.evaluate(() => ({
        webNavigation: typeof (globalThis as any).chrome?.webNavigation,
        webRequest: typeof (globalThis as any).chrome?.webRequest,
        storage: typeof (globalThis as any).chrome?.storage,
        runtime: typeof (globalThis as any).chrome?.runtime,
      }));
      const ok = apis.webNavigation === 'object' && apis.webRequest === 'object' && apis.storage === 'object';
      mark('R1b_chrome_apis', ok, JSON.stringify(apis));
    } else {
      mark('R1b_chrome_apis', false, 'skipped (no SW)');
    }

    // R2 — we can observe network traffic from a navigated page
    const page = await context.newPage();
    const seen: string[] = [];
    page.on('request', (r) => seen.push(r.url()));
    await page.goto(site.url, { waitUntil: 'networkidle', timeout: 10000 });
    const sawNav = seen.some((u) => u.startsWith(site.url) && !u.endsWith('/ping'));
    const sawSub = seen.some((u) => u.endsWith('/ping'));
    mark('R2_network_observe', sawNav && sawSub, `captured ${seen.length} reqs (nav=${sawNav}, subresource=${sawSub})`);

    // R3 (bonus) — CDP session attaches for lower-level network watching
    try {
      const cdp = await context.newCDPSession(page);
      await cdp.send('Network.enable');
      mark('R3_cdp_attach', true, 'Network.enable ok');
      await cdp.detach();
    } catch (e) {
      mark('R3_cdp_attach', false, String(e).slice(0, 80));
    }
  } finally {
    await context.close();
    await site.close();
    await rm(userDataDir, { recursive: true, force: true });
  }

  console.log('\n=== P2 MV3 SPIKE REPORT ===');
  for (const [k, v] of Object.entries(report)) console.log(`  ${k.padEnd(20)} ${v}`);
  const hardFail = ['R1_service_worker', 'R1b_chrome_apis', 'R2_network_observe'].some((k) => report[k].startsWith('FAIL'));
  console.log(`\n  VERDICT: ${hardFail ? 'BLOCKED — architecture risk NOT retired' : 'GREEN — Track-B browser audit is viable'}\n`);
  process.exit(hardFail ? 1 : 0);
}

main().catch((e) => {
  console.error('spike crashed:', e);
  process.exit(2);
});
