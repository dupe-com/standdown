// End-to-end check of standdown/relay in a real Chromium.
//
// Builds examples/relay-extension (swapping offer.js for e2e/probe.js), serves
// local shop pages, maps *.example to 127.0.0.1, and runs each scenario in a
// fresh tab. Every scenario gets its own shop domain because the engine
// deliberately remembers a stand-down per shop for the browsing session.
//
//   npm run build && (cd audit && npm install && npx playwright install chromium)
//   node examples/relay-extension/e2e/run.mjs
//
// Env:
//   CHROMIUM_PATH   use an existing Chromium instead of Playwright's download
//   EXTRA_CASES     path to a module exporting { routes?, scenarios?, background?,
//                   capture?, probeContentOptions? } to add cases or swap entries
//   HEADED=1        show the browser
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const exampleDir = resolve(here, '..');
const repoRoot = resolve(exampleDir, '../..');
const requireRoot = createRequire(join(repoRoot, 'package.json'));
const requireAudit = createRequire(join(repoRoot, 'audit/package.json'));
const esbuild = requireRoot('esbuild');
const { chromium } = requireAudit('playwright');

const PORT = Number(process.env.PORT ?? 8787);
const u = (host, path) => `http://${host}:${PORT}${path}`;
const html = (head = '') =>
  `<!doctype html><html><head><meta charset="utf-8">${head}</head><body><h1>shop</h1></body></html>`;

// Shop pages. /strip and /later reproduce the bug: the page removes the
// referral param before (replaceState) or just after (pushState) load.
const baseRoutes = {
  '/strip': html('<script>history.replaceState(null, "", location.pathname)</script>'),
  '/later': html('<script>setTimeout(() => history.pushState(null, "", "/later-clean"), 0)</script>'),
  '/forward': html(
    `<script>location.replace("http://www." + location.hostname.replace(/^link\\./, "") + ":${PORT}/clean")</script>`,
  ),
  '/clean': html(),
  '/later-clean': html(),
};

// steps: a URL to open, 'RELOAD', 'RESTART' (close and reopen the browser with
// the same profile), or { waitMs }. The last page is judged.
// expect.relay is required; expect.content is optional.
const baseScenarios = [
  { name: 'replaceState strips ?cjevent=abc before load', steps: [u('s1.example', '/strip?cjevent=abc')], expect: { relay: true, matchKind: 'landing' } },
  { name: 'pushState strips ?cjevent=abc just after load', steps: [u('s2.example', '/later?cjevent=abc')], expect: { relay: true } },
  { name: 'utm_source=cj stripped (value compared in page)', steps: [u('s3.example', '/strip?utm_source=cj')], expect: { relay: true } },
  { name: 'utm_source=google stripped (not CJ)', steps: [u('s4.example', '/strip?utm_source=google')], expect: { relay: false } },
  { name: 'link.shop?cjevent=abc -> script -> www.shop', steps: [u('link.s5.example', '/forward?cjevent=abc')], expect: { relay: true } },
  { name: 'clean visit, no referral (positive control)', steps: [u('s6.example', '/clean')], expect: { relay: false } },
  { name: 'param on unrelated site, then shop in same tab', steps: [u('other.example', '/clean?cjevent=abc'), u('s7.example', '/clean')], expect: { relay: false } },
  { name: 'reload after strip (sessionStorage mirror)', steps: [u('s8.example', '/strip?cjevent=abc'), 'RELOAD'], expect: { relay: true } },
  // Known limit, asserted so it stays documented: a server-side 302 that drops
  // the param before any page loads is invisible to relay and content alike.
  { name: 'LIMIT: shop server 302s ?cjevent=abc away before any page loads -> not seen', steps: [u('s9.example', '/server-strip?cjevent=abc')], expect: { relay: false, content: false } },
];

const extra = process.env.EXTRA_CASES
  ? (await import(pathToFileURL(resolve(process.env.EXTRA_CASES)).href)).default({ u, html, PORT })
  : {};
const routes = { ...baseRoutes, ...extra.routes };
const scenarios = [...baseScenarios, ...(extra.scenarios ?? [])];

// Build the extension into a temp dir.
const ext = mkdtempSync(join(tmpdir(), 'standdown-relay-e2e-'));
const manifest = JSON.parse(readFileSync(join(exampleDir, 'manifest.json'), 'utf8'));
manifest.content_scripts[1].js = ['probe.js'];
writeFileSync(join(ext, 'manifest.json'), JSON.stringify(manifest, null, 2));
const build = (entry, outfile, format, define = {}) =>
  esbuild.build({ entryPoints: [entry], outfile: join(ext, outfile), bundle: true, format, platform: 'browser', target: 'chrome120', logLevel: 'error', absWorkingDir: repoRoot, define });
await build(extra.capture ?? join(exampleDir, 'relay-capture.js'), 'relay-capture.js', 'iife');
await build(extra.background ?? join(exampleDir, 'background.js'), 'background.js', 'esm');
await build(join(here, 'probe.js'), 'probe.js', 'iife', {
  __PROBE_CONTENT_OPTIONS__: JSON.stringify(extra.probeContentOptions ?? {}),
});

const server = http
  .createServer((req, res) => {
    // /server-strip: the shop's SERVER reads the param and 302s to a clean URL
    // before any page loads. Nothing in the page can see it (documented limit).
    if (new URL(req.url, 'http://x').pathname === '/server-strip') {
      res.writeHead(302, { location: '/clean' });
      res.end();
      return;
    }
    const body = routes[new URL(req.url, 'http://x').pathname];
    res.writeHead(body ? 200 : 404, { 'content-type': 'text/html' });
    res.end(body ?? 'not found');
  })
  .listen(PORT);

// A real profile directory, so a 'RESTART' step can close the browser and open
// it again: chrome.storage.session is wiped, chrome.storage.local survives.
const profile = mkdtempSync(join(tmpdir(), 'standdown-relay-e2e-profile-'));
async function launch() {
  const context = await chromium.launchPersistentContext(profile, {
    headless: !process.env.HEADED,
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    args: [
      `--disable-extensions-except=${ext}`,
      `--load-extension=${ext}`,
      '--host-resolver-rules=MAP *.example 127.0.0.1, MAP *.*.example 127.0.0.1',
    ],
  });
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  return { context, sw };
}
let { context: ctx, sw: worker } = await launch();

async function readProbe(page) {
  await page.waitForFunction(() => document.documentElement.hasAttribute('data-probe'), null, { timeout: 8000 });
  return JSON.parse(await page.getAttribute('html', 'data-probe'));
}

let failures = 0;
const results = [];
for (const s of scenarios) {
  let page = await ctx.newPage();
  let r;
  try {
    for (const step of s.steps) {
      if (step === 'RESTART') {
        await ctx.close();
        ({ context: ctx, sw: worker } = await launch());
        page = await ctx.newPage();
        continue;
      }
      if (step === 'RELOAD') {
        await page.evaluate(() => document.documentElement.removeAttribute('data-probe'));
        await page.reload();
      } else if (typeof step === 'object' && step.waitMs) {
        await page.waitForTimeout(step.waitMs);
        continue;
      } else {
        await page.goto(step);
      }
      r = await readProbe(page);
    }
  } catch (e) {
    r = { error: String(e) };
  }
  const want = s.expect;
  const pass =
    r?.relay?.standDown === want.relay &&
    (want.content === undefined || r?.content?.standDown === want.content) &&
    (want.matchKind === undefined || r?.relay?.matchKind === want.matchKind);
  if (!pass) failures++;
  results.push({ name: s.name, pass, ...r });
  console.log(
    `${pass ? 'PASS' : 'FAIL'}  ${s.name}\n` +
      `      url at idle: ${r?.urlAtIdle}\n` +
      `      content adapter: ${JSON.stringify(r?.content)}\n` +
      `      relay:           ${JSON.stringify(r?.relay ?? r)}`,
  );
  await page.close();
}

// Closing a tab must delete its landing record (tabs.onRemoved). Checks the
// current browser run only: a RESTART already wipes chrome.storage.session.
const leftover = Object.keys(await worker.evaluate(() => chrome.storage.session.get(null))).filter((k) =>
  k.startsWith('standdown:relay:tab:'),
);
const cleanupPass = leftover.length === 0;
if (!cleanupPass) failures++;
console.log(`${cleanupPass ? 'PASS' : 'FAIL'}  closed tabs leave no landing records (${leftover.length} left)`);

if (process.env.RESULTS_JSON) writeFileSync(process.env.RESULTS_JSON, JSON.stringify({ results, cleanupPass }, null, 2));
console.log(failures ? `\n${failures} FAILED` : `\nALL ${scenarios.length + 1} PASSED`);
await ctx.close();
server.close();
rmSync(ext, { recursive: true, force: true });
rmSync(profile, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
