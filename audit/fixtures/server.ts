import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { StanddownPolicy } from 'standdown';
import { allPolicies } from 'standdown/policies';
import { servedFor, type Mechanism } from './packDerive.ts';

/**
 * Zero-dependency mock fixture server for the browser audit path. It presents
 * two families of routes on an ephemeral localhost port:
 *
 *   GET /merchant/:network  — a mock merchant product page that reflects the
 *                             network and any landing params into the DOM.
 *   GET /aff/:network        — a mock affiliate redirector that seeds a
 *                             mechanism (landing param / cookie / redirect /
 *                             afsrc) then 302s to the merchant page.
 *
 * NOTE (browser-host limitation): host-scoped packs (amazon, ebay-epn) can only
 * be exercised end-to-end in a real browser once the fixture presents as the
 * real advertiser host. That needs Playwright `--host-resolver-rules` + a TLS
 * cert (later phase); do NOT solve it here. The in-process conformance path
 * (scenario.signals) already covers those packs host-accurately today.
 */

const KINDS: readonly Mechanism[] = ['landing-param', 'cookie', 'redirect', 'afsrc'];

const policyByNetwork = new Map<string, StanddownPolicy>(
  allPolicies.map((policy) => [policy.network.id, policy]),
);

export interface FixtureServer {
  url: string;
  close(): Promise<void>;
}

/** Boot the fixture server on 127.0.0.1:0 and resolve its base URL + closer. */
export function createFixtureServer(): Promise<FixtureServer> {
  const server = http.createServer((req, res) => handle(req, res));

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      const url = `http://127.0.0.1:${port}`;
      resolve({
        url,
        close: () =>
          new Promise<void>((done, fail) =>
            server.close((err) => (err ? fail(err) : done())),
          ),
      });
    });
  });
}

function handle(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const merchant = url.pathname.match(/^\/merchant\/([^/]+)$/);
  const aff = url.pathname.match(/^\/aff\/([^/]+)$/);

  if (merchant) {
    return serveMerchant(res, decodeURIComponent(merchant[1]), url.searchParams);
  }
  if (aff) {
    return serveAff(res, decodeURIComponent(aff[1]), url.searchParams);
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
}

function serveMerchant(
  res: http.ServerResponse,
  network: string,
  params: URLSearchParams,
): void {
  const policy = policyByNetwork.get(network);
  if (!policy) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('unknown network');
    return;
  }

  const paramEntries = [...params.entries()];
  const dataAttrs = paramEntries
    .map(([k, v]) => `data-param-${escapeAttr(k)}="${escapeAttr(v)}"`)
    .join(' ');
  const paramList = paramEntries.length
    ? paramEntries.map(([k, v]) => `<li>${escapeHtml(k)} = ${escapeHtml(v)}</li>`).join('')
    : '<li>none</li>';

  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Demo Merchant — ${escapeHtml(policy.network.name)}</title></head>
<body>
  <main id="product"
        data-network="${escapeAttr(network)}"
        data-network-name="${escapeAttr(policy.network.name)}"
        ${dataAttrs}>
    <h1 id="product-title">Demo Widget</h1>
    <p id="product-price" data-price="49.99">$49.99</p>
    <ul id="landing-params">${paramList}</ul>
    <div id="offer-region">
      <button id="activate-offer" type="button">Activate offer</button>
    </div>
  </main>
</body>
</html>`);
}

function serveAff(
  res: http.ServerResponse,
  network: string,
  query: URLSearchParams,
): void {
  const policy = policyByNetwork.get(network);
  if (!policy) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('unknown network');
    return;
  }

  const kind = (query.get('kind') ?? 'landing-param') as Mechanism;
  if (!KINDS.includes(kind)) {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('unknown kind');
    return;
  }

  const served = servedFor(policy, kind);
  const location = new URL(`http://127.0.0.1/merchant/${encodeURIComponent(network)}`);
  for (const pair of served.params) {
    location.searchParams.set(pair.name, pair.value);
  }

  const headers: http.OutgoingHttpHeaders = {
    location: location.pathname + location.search,
  };
  if (served.cookies.length > 0) {
    headers['set-cookie'] = served.cookies.map(
      (name) => `${name}=seed; Path=/; SameSite=Lax`,
    );
  }

  res.writeHead(302, headers);
  res.end();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/"/g, '&quot;');
}
