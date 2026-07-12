import { MemoryStateStore, StanddownSession, detect } from 'standdown';
import { allPolicies } from 'standdown/policies';
import { createFixtureServer } from './server.ts';
import { buildScenarios, type Scenario } from './scenarios.ts';

/**
 * Closing-the-loop self-test for the fixture substrate. For every scenario:
 *  1. Feed its logical signals into both detect() and a fresh session.ingest()
 *     and assert the stand-down decision matches expectations.
 *  2. Drive the fixture server's /aff redirect (manual-follow, cookie
 *     accumulation) and assert it actually serves what the scenario claims.
 * Prints a summary table and exits non-zero on any failure.
 */

interface Row {
  network: string;
  scenario: string;
  expected: string;
  got: string;
  pass: boolean;
  detail?: string;
}

async function main(): Promise<void> {
  const scenarios = buildScenarios();
  const rows: Row[] = [];

  // ---- 1. In-process conformance (detect + session.ingest) ----
  for (const scenario of scenarios) {
    rows.push(await checkConformance(scenario));
  }

  // ---- 2. Served-page conformance (fixture HTTP server) ----
  const server = await createFixtureServer();
  try {
    for (const scenario of scenarios) {
      rows.push(await checkServed(server.url, scenario));
    }
  } finally {
    await server.close();
  }

  printTable(rows);

  const failed = rows.filter((r) => !r.pass);
  const networks = new Set(scenarios.map((s) => s.networkId));
  console.log(
    `\n${rows.length} checks over ${scenarios.length} scenarios / ${networks.size} networks — ` +
      `${rows.length - failed.length} passed, ${failed.length} failed`,
  );

  if (failed.length > 0) {
    console.error('\nFAILURES:');
    for (const f of failed) {
      console.error(`  ✗ ${f.network}/${f.scenario}: ${f.detail ?? 'mismatch'}`);
    }
    process.exit(1);
  }
}

async function checkConformance(scenario: Scenario): Promise<Row> {
  const label = scenario.mechanism
    ? `conformance:${scenario.kind}:${scenario.mechanism}`
    : `conformance:${scenario.kind}`;

  const detection = detect(scenario.signals, allPolicies);
  const session = new StanddownSession(new MemoryStateStore());
  const decision = await session.ingest(scenario.signals, allPolicies);

  const matchedNetworks = detection.matched.map((m) => m.networkId);
  const got = `standDown=${decision.standDown} matched=[${dedupe(matchedNetworks).join(',') || '-'}]`;

  let pass: boolean;
  let detail: string | undefined;

  if (scenario.expectStandDown) {
    const hitTarget = matchedNetworks.includes(scenario.networkId);
    pass = hitTarget && decision.standDown === true;
    if (!hitTarget) {
      detail = `expected match for '${scenario.networkId}', got [${matchedNetworks.join(',') || 'none'}]`;
    } else if (!decision.standDown) {
      detail = `matched '${scenario.networkId}' but decision.standDown=false (${decision.reason})`;
    }
  } else {
    // controls: no third-party match, no stand-down.
    pass = detection.matched.length === 0 && decision.standDown === false;
    if (detection.matched.length > 0) {
      detail = `control unexpectedly matched [${matchedNetworks.join(',')}]`;
    } else if (decision.standDown) {
      detail = `control decision.standDown=true (${decision.reason})`;
    }
  }

  return {
    network: scenario.networkId,
    scenario: label,
    expected: `standDown=${scenario.expectStandDown}`,
    got,
    pass,
    detail,
  };
}

async function checkServed(baseUrl: string, scenario: Scenario): Promise<Row> {
  const label = scenario.mechanism
    ? `served:${scenario.kind}:${scenario.mechanism}`
    : `served:${scenario.kind}`;

  const start = scenario.seed?.affPath ?? scenario.landingPath;
  const { finalUrl, cookies, hops } = await followManually(baseUrl + start);

  const expectedPath = new URL(baseUrl + scenario.landingPath).pathname;
  const expectedParams = [
    ...new URL(baseUrl + scenario.landingPath).searchParams.keys(),
  ];
  const expectedCookies = scenario.seed?.setCookies ?? [];

  const final = new URL(finalUrl);
  const pathOk = final.pathname === expectedPath;
  const paramsOk = expectedParams.every((p) => final.searchParams.has(p));
  const cookiesOk = expectedCookies.every((c) => cookies.has(c));
  // attribution scenarios seed via /aff, so a redirect hop must have occurred.
  const hopOk = scenario.kind === 'attribution' ? hops >= 1 : true;

  const pass = pathOk && paramsOk && cookiesOk && hopOk;
  const got =
    `path=${final.pathname} params=[${[...final.searchParams.keys()].join(',') || '-'}] ` +
    `cookies=[${[...cookies].join(',') || '-'}] hops=${hops}`;

  let detail: string | undefined;
  if (!pathOk) {
    detail = `path ${final.pathname} !== ${expectedPath}`;
  } else if (!paramsOk) {
    detail = `missing params; want [${expectedParams.join(',')}], got [${[...final.searchParams.keys()].join(',')}]`;
  } else if (!cookiesOk) {
    detail = `missing cookies; want [${expectedCookies.join(',')}], got [${[...cookies].join(',')}]`;
  } else if (!hopOk) {
    detail = 'expected a redirect hop from /aff';
  }

  return {
    network: scenario.networkId,
    scenario: label,
    expected: `path=${expectedPath} cookies=[${expectedCookies.join(',') || '-'}]`,
    got,
    pass,
    detail,
  };
}

/** Follow 3xx redirects by hand (redirect: 'manual'), accumulating cookie names. */
async function followManually(
  startUrl: string,
): Promise<{ finalUrl: string; cookies: Set<string>; hops: number }> {
  const cookies = new Set<string>();
  let current = startUrl;
  let hops = 0;

  for (let i = 0; i < 8; i++) {
    const res = await fetch(current, { redirect: 'manual' });

    for (const raw of setCookieHeaders(res.headers)) {
      const name = raw.split('=')[0]?.trim();
      if (name) {
        cookies.add(name);
      }
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) {
        break;
      }
      current = new URL(location, current).href;
      hops += 1;
      continue;
    }

    await res.text(); // drain body
    break;
  }

  return { finalUrl: current, cookies, hops };
}

function setCookieHeaders(headers: Headers): string[] {
  const withGetter = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof withGetter.getSetCookie === 'function') {
    return withGetter.getSetCookie();
  }
  const single = headers.get('set-cookie');
  return single ? [single] : [];
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function printTable(rows: Row[]): void {
  const headers = ['NETWORK', 'SCENARIO', 'EXPECTED', 'GOT', 'RESULT'];
  const cols = [
    (r: Row) => r.network,
    (r: Row) => r.scenario,
    (r: Row) => r.expected,
    (r: Row) => r.got,
    (r: Row) => (r.pass ? 'PASS' : 'FAIL'),
  ];
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => cols[i](r).length)),
  );
  const line = (cells: string[]) =>
    cells.map((c, i) => c.padEnd(widths[i])).join('  ');

  console.log(line(headers));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) {
    console.log(line(cols.map((c) => c(r))));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
