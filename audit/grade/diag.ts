import { loadExtension } from './browser.ts';
import { createFixtureServer } from '../fixtures/server.ts';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ext = await loadExtension(join(HERE, '..', 'testext', 'bad'));
const server = await createFixtureServer();
const page = await ext.context.newPage();
const reqs: string[] = [];
page.on('request', (r) => reqs.push(r.url()));

console.log('SW present:', !!ext.serviceWorker, ext.serviceWorker?.url());
await page.goto(server.url + '/merchant/cj', { waitUntil: 'commit', timeout: 10000 });
await page.waitForTimeout(3500);

const sw = ext.context.serviceWorkers()[0];
const diag = sw ? await sw.evaluate(() => (globalThis as any).__diag).catch((e: any) => `evalerr:${e}`) : 'no-sw';
console.log('final url:', page.url());
console.log('SW __diag:', JSON.stringify(diag));
console.log('/aff reqs:', reqs.filter((u) => u.includes('/aff/')));

await server.close();
await ext.close();
process.exit(0);
