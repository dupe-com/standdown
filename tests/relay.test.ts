import { afterEach, describe, expect, it, vi } from 'vitest';
import { cjPolicy, impactPolicy } from '../src/policies';
import {
  createRelayStanddown,
  type RelayChromeLike,
  type RelayMessageResponse,
  type RelaySenderLike,
} from '../src/relay/background';
import {
  type CaptureWindowLike,
  captureLanding,
  RELAY_SESSION_STORAGE_KEY,
  type RelayCaptureMessage,
} from '../src/relay/capture';
import type { ChromeStorageAreaLike } from '../src/stores';
import type { SelfExemption, StanddownPolicy } from '../src/types';
import { validatePolicy } from '../src/validation';

const TAB = 7;

describe('relay: capture at document_start, decide in background', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stands down with kind "landing" when the shop strips the param with replaceState before DOMContentLoaded', async () => {
    const h = harness();

    // document_start: the param is still there.
    const page = h.open('https://shop.example/product?cjevent=abc', 1_000);
    // Page script, before DOMContentLoaded: strip it.
    page.window.location.href = 'https://shop.example/product';
    await h.flush();

    const decision = await h.query('https://shop.example/product', 1_500);

    expect(decision).toMatchObject({ standDown: true, policyId: 'cj', matchKind: 'landing' });
  });

  it('baseline: without a capture, the stripped URL alone does not stand down', async () => {
    const h = harness();

    const decision = await h.query('https://shop.example/product', 1_500);

    expect(decision.standDown).toBe(false);
    expect(decision.matchKind).toBeUndefined();
  });

  it('leaves matchKind unset when the param is still in the URL', async () => {
    const h = harness();
    h.open('https://shop.example/?cjevent=abc', 1_000);
    await h.flush();

    const decision = await h.query('https://shop.example/?cjevent=abc', 1_100);

    expect(decision.standDown).toBe(true);
    expect(decision.matchKind).toBeUndefined();
  });

  it('stands down when the param is stripped later with pushState', async () => {
    const h = harness();
    const page = h.open('https://shop.example/?cjevent=abc', 1_000);
    await h.flush();

    // Much later, a SPA route change drops the param (same document, no new capture).
    page.window.location.href = 'https://shop.example/cart';

    await expect(h.query('https://shop.example/cart', 60_000)).resolves.toMatchObject({
      standDown: true,
      matchKind: 'landing',
    });
  });

  it('stands down after a same-site script redirect (background record path)', async () => {
    const h = harness();
    h.open('https://shop.example/?cjevent=abc', 1_000);
    // Script forward to a clean URL; cross-origin-style referrer (origin only).
    h.open('https://shop.example/landing', 1_200, 'https://shop.example/');
    await h.flush();

    await expect(h.query('https://shop.example/landing', 1_300)).resolves.toMatchObject({
      standDown: true,
      matchKind: 'landing',
    });
  });

  it('stands down after a same-origin script redirect via the full referrer (no prior record)', async () => {
    const h = harness();
    // The first page's capture never reached the background (e.g. worker not up),
    // but the same-origin referrer still carries the param.
    const page = h.open(
      'https://shop.example/landing',
      1_200,
      'https://shop.example/?cjevent=abc',
    );
    await h.flush();

    expect(page.record?.matches).toEqual([{ policyId: 'cj', params: ['cjevent'] }]);
    await expect(h.query('https://shop.example/landing', 1_300)).resolves.toMatchObject({
      standDown: true,
      matchKind: 'landing',
    });
  });

  it('stands down when link.<shop> forwards to www.<shop> by script', async () => {
    const h = harness();
    h.open('https://link.shop.example/go?cjevent=abc', 1_000);
    h.open('https://www.shop.example/product', 2_000, 'https://link.shop.example/');
    await h.flush();

    await expect(h.query('https://www.shop.example/product', 2_500)).resolves.toMatchObject({
      standDown: true,
      matchKind: 'landing',
    });
    await expect(h.relay.landingFor(TAB, 2_500)).resolves.toMatchObject({
      host: 'www.shop.example',
    });
  });

  it('carries a forward even if the query races ahead of the second capture', async () => {
    const h = harness();
    h.open('https://link.shop.example/go?cjevent=abc', 1_000);
    await h.flush();

    await expect(h.query('https://www.shop.example/product', 2_000)).resolves.toMatchObject({
      standDown: true,
      matchKind: 'landing',
    });
  });

  it('does not carry a same-base forward that arrives after the hop window', async () => {
    const h = harness();
    h.open('https://link.shop.example/go?cjevent=abc', 1_000);
    h.open('https://www.shop.example/product', 1_000 + 30_000);
    await h.flush();

    await expect(h.query('https://www.shop.example/product', 31_500)).resolves.toMatchObject({
      standDown: false,
    });
  });

  it('carries from a policy tracking host to the advertiser', async () => {
    const tracked: StanddownPolicy = {
      ...cjPolicy,
      detection: {
        ...cjPolicy.detection,
        trackingHosts: [{ pattern: 'click.tracker.example', kind: 'suffix' }],
      },
    };
    const h = harness({ policies: [tracked] });
    h.open('https://click.tracker.example/r?cjevent=abc', 1_000);
    h.open('https://shop.example/product', 1_500);
    await h.flush();

    await expect(h.query('https://shop.example/product', 1_600)).resolves.toMatchObject({
      standDown: true,
      matchKind: 'landing',
    });
  });

  it('does not carry a param seen on an unrelated site over to the next shop in the same tab', async () => {
    const h = harness();
    h.open('https://other.example/?cjevent=abc', 1_000);
    h.open('https://shop.example/product', 1_500, 'https://other.example/');
    await h.flush();

    await expect(h.query('https://shop.example/product', 1_600)).resolves.toMatchObject({
      standDown: false,
    });
    await expect(h.relay.landingFor(TAB, 1_600)).resolves.toBeUndefined();
  });

  it("still exempts the host's own click params, and still stands down on a competing value", async () => {
    const selfPatterns: SelfExemption[] = [
      { name: 'cjevent', value: 'own-click', match: 'equals', networkId: 'cj' },
    ];
    const own = harness({ selfPatterns });
    own.open('https://shop.example/?cjevent=own-click', 1_000);
    await own.flush();

    await expect(own.query('https://shop.example/', 1_500)).resolves.toMatchObject({
      standDown: false,
    });

    const competing = harness({ selfPatterns });
    competing.open('https://shop.example/?cjevent=someone-else', 1_000);
    await competing.flush();

    await expect(competing.query('https://shop.example/', 1_500)).resolves.toMatchObject({
      standDown: true,
      matchKind: 'landing',
    });
  });

  it('matches landing param names in any casing, like detection (?CJEVENT=abc stripped)', async () => {
    const h = harness();
    const page = h.open('https://shop.example/?CJEVENT=abc', 1_000);
    page.window.location.href = 'https://shop.example/';
    await h.flush();

    expect(page.record?.matches).toEqual([{ policyId: 'cj', params: ['cjevent'] }]);
    await expect(h.query('https://shop.example/', 1_500)).resolves.toMatchObject({
      standDown: true,
      matchKind: 'landing',
    });
  });

  it('keeps own-click matching exact-case: ?CJEVENT=own-click is not our click', async () => {
    const selfPatterns: SelfExemption[] = [
      { name: 'cjevent', value: 'own-click', match: 'equals', networkId: 'cj' },
    ];
    const h = harness({ selfPatterns });
    h.open('https://shop.example/?CJEVENT=own-click', 1_000);
    await h.flush();

    await expect(h.query('https://shop.example/', 1_500)).resolves.toMatchObject({ standDown: true });
  });

  it('passes sessionKey through: a later checkout.<shop> visit in another tab still stands down', async () => {
    const chrome = fakeChrome();
    const relay = createRelayStanddown({
      policies: [cjPolicy],
      chrome,
      now: () => 0,
      sessionKey: (url) => new URL(url).hostname.split('.').slice(-2).join('.'),
    });
    await relay.ingestCapture(
      TAB,
      { v: 1, host: 'www.shop.example', at: 1_000, matches: [{ policyId: 'cj', params: ['cjevent'] }] },
      1_000,
    );
    await expect(relay.shouldStandDown(TAB, 'https://www.shop.example/', 1_000)).resolves.toMatchObject({
      standDown: true,
    });

    // Another tab, long after the hop window, on another host of the same shop.
    await expect(
      relay.shouldStandDown(TAB + 1, 'https://checkout.shop.example/', 120_000),
    ).resolves.toMatchObject({ standDown: true, reason: 'active-standdown:cj' });
  });

  it("an own click in the referrer doesn't hide a competitor's param in this page's URL", async () => {
    const selfPatterns: SelfExemption[] = [
      { name: 'cjevent', value: 'own-click', match: 'equals', networkId: 'cj' },
    ];
    const h = harness({ selfPatterns });
    // Browsing on from our own-click page to a page carrying a competitor's param,
    // which the page then strips.
    const page = h.open(
      'https://shop.example/deal?cjevent=someone-else',
      1_000,
      'https://shop.example/?cjevent=own-click',
    );
    page.window.location.href = 'https://shop.example/deal';
    await h.flush();

    expect(page.record?.matches).toEqual([{ policyId: 'cj', params: ['cjevent'] }]);
    await expect(h.query('https://shop.example/deal', 1_500)).resolves.toMatchObject({
      standDown: true,
      matchKind: 'landing',
    });
  });

  it('an own click in the referrer still exempts the referrer itself', async () => {
    const selfPatterns: SelfExemption[] = [
      { name: 'cjevent', value: 'own-click', match: 'equals', networkId: 'cj' },
    ];
    const h = harness({ selfPatterns });
    const page = h.open('https://shop.example/cart', 1_000, 'https://shop.example/?cjevent=own-click');
    await h.flush();

    expect(page.record?.matches).toEqual([]);
    await expect(h.query('https://shop.example/cart', 1_500)).resolves.toMatchObject({ standDown: false });
  });

  it('expires the landing record after the window', async () => {
    const h = harness({ maxAgeMs: 5_000 });
    h.open('https://shop.example/?cjevent=abc', 1_000);
    await h.flush();

    await expect(h.relay.landingFor(TAB, 5_999)).resolves.toBeDefined();
    await expect(h.query('https://shop.example/', 6_001)).resolves.toMatchObject({
      standDown: false,
    });
    expect(h.sessionArea.data.has(`standdown:relay:tab:${TAB}`)).toBe(false);
  });

  it('deletes the landing record when the tab closes', async () => {
    const h = harness();
    h.open('https://shop.example/?cjevent=abc', 1_000);
    await h.flush();
    expect(h.sessionArea.data.has(`standdown:relay:tab:${TAB}`)).toBe(true);

    h.chrome.tabs.onRemoved.emit(TAB);
    await h.flush();

    expect(h.sessionArea.data.has(`standdown:relay:tab:${TAB}`)).toBe(false);
    await expect(h.query('https://shop.example/', 1_100)).resolves.toMatchObject({
      standDown: false,
    });
  });

  it('keeps no full URL and no param values in anything it stores or sends', async () => {
    const h = harness();
    const page = h.open(
      'https://shop.example/secret-path?cjevent=VALUE123&email=person%40mail.example',
      1_000,
      'https://ref.example/from?token=REFVALUE',
    );
    await h.flush();

    const expected = { v: 1, host: 'shop.example', at: 1_000, matches: [{ policyId: 'cj', params: ['cjevent'] }] };
    expect(page.record).toEqual(expected);
    expect(JSON.parse(page.window.storage.get(RELAY_SESSION_STORAGE_KEY) ?? 'null')).toEqual(expected);
    expect(h.sent).toEqual([{ type: 'standdown:relay:capture', record: expected }]);
    expect(h.sessionArea.data.get(`standdown:relay:tab:${TAB}`)).toEqual({
      host: 'shop.example',
      at: 1_000,
      lastAt: 1_000,
      matches: [{ policyId: 'cj', params: ['cjevent'] }],
    });

    const everything = JSON.stringify([
      [...page.window.storage.entries()],
      h.sent,
      [...h.sessionArea.data.entries()],
      [...h.localArea.data.entries()],
    ]);
    for (const leaked of ['VALUE123', 'secret-path', 'email', 'person', 'ref.example', 'REFVALUE']) {
      expect(everything).not.toContain(leaked);
    }
  });

  it('re-sends the stored record after a same-tab reload of the stripped URL', async () => {
    const h = harness();
    const first = h.open('https://shop.example/?cjevent=abc', 1_000);
    first.window.location.href = 'https://shop.example/';
    await h.flush();
    // Background loses its record (e.g. browser restored the tab).
    await h.relay.forgetTab(TAB);

    h.open('https://shop.example/', 2_000, undefined, first.window.storage);
    await h.flush();

    await expect(h.query('https://shop.example/', 2_100)).resolves.toMatchObject({
      standDown: true,
      matchKind: 'landing',
    });
  });

  it('retries the send once when the background is not listening yet', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const result = captureLanding({
      policies: [cjPolicy],
      window: fakeWindow('https://shop.example/?cjevent=abc').window,
      now: () => 1_000,
      retryDelayMs: 250,
      sendMessage: () => {
        calls += 1;
        return calls === 1
          ? Promise.reject(new Error('Receiving end does not exist.'))
          : Promise.resolve();
      },
    });

    await vi.advanceTimersByTimeAsync(250);
    await expect(result?.delivered).resolves.toBe(true);
    expect(calls).toBe(2);
  });

  it('does nothing in sub-frames', () => {
    const fake = fakeWindow('https://ads.example/?cjevent=abc');
    const result = captureLanding({
      policies: [cjPolicy],
      window: { ...fake.window, top: {}, self: fake.window },
      sendMessage: () => undefined,
    });

    expect(result).toBeUndefined();
  });

  it('rejects captures from sub-frames, without a tab, from another host, or malformed', async () => {
    const h = harness();
    const record = { v: 1, host: 'shop.example', at: 1_000, matches: [{ policyId: 'cj', params: ['cjevent'] }] };
    const capture = { type: 'standdown:relay:capture', record };

    const rejected: [unknown, RelaySenderLike][] = [
      [capture, { tab: { id: TAB }, frameId: 3 }],
      [capture, { frameId: 0 }],
      [capture, { tab: { id: TAB }, frameId: 0, url: 'https://other.example/' }],
      [{ ...capture, record: { ...record, url: 'https://shop.example/?cjevent=abc' } }, { tab: { id: TAB }, frameId: 0 }],
      [{ ...capture, record: { ...record, matches: [{ policyId: 'cj', params: [] }] } }, { tab: { id: TAB }, frameId: 0 }],
    ];

    for (const [message, sender] of rejected) {
      await expect(h.relay.handleMessage(message, sender)).resolves.toEqual({ ok: false });
    }
    expect(h.sessionArea.data.size).toBe(0);
  });

  it('answers shouldStandDown messages keyed by sender.tab.id', async () => {
    const h = harness();
    h.open('https://shop.example/?cjevent=abc', 1_000);
    await h.flush();

    const response = await h.chrome.runtime.onMessage.dispatch(
      { type: 'standdown:relay:shouldStandDown', url: 'https://shop.example/' },
      { tab: { id: TAB }, frameId: 0 },
    );
    expect(response).toMatchObject({ ok: true, decision: { standDown: true, matchKind: 'landing' } });

    const otherTab = await h.chrome.runtime.onMessage.dispatch(
      { type: 'standdown:relay:shouldStandDown', url: 'https://shop.example/' },
      { tab: { id: TAB + 1 }, frameId: 0 },
    );
    expect(otherTab).toMatchObject({ ok: true, decision: { standDown: true } });
    // Tab 8 is covered by the session stand-down the first query recorded for the
    // host, not by a landing record of its own.
    expect(otherTab?.decision?.matchKind).toBeUndefined();
  });

  it('fails closed on an unparseable URL', async () => {
    const h = harness();
    await expect(h.query('not a url', 1_000)).resolves.toMatchObject({ standDown: true });
  });
});

describe('relay: failure and edge paths', () => {
  it('accepts a top-frame capture through the runtime message listener', async () => {
    const h = harness();
    const record = { v: 1, host: 'shop.example', at: 1_000, matches: [{ policyId: 'cj', params: ['cjevent'] }] };

    await expect(
      h.chrome.runtime.onMessage.dispatch(
        { type: 'standdown:relay:capture', record },
        { tab: { id: TAB }, frameId: 0, url: 'https://shop.example/' },
      ),
    ).resolves.toEqual({ ok: true });
    await expect(h.query('https://shop.example/', 1_100)).resolves.toMatchObject({ standDown: true });
  });

  it('fails closed when the per-tab landing store throws', async () => {
    const h = harness();
    h.sessionArea.get = () => {
      throw new Error('storage gone');
    };

    await expect(h.query('https://shop.example/', 1_000)).resolves.toMatchObject({
      standDown: true,
      reason: 'relay-store-error',
    });
  });

  it('fails closed when chrome.storage.local is unavailable', async () => {
    const chrome = fakeChrome();
    const relay = createRelayStanddown({
      policies: [cjPolicy],
      chrome: { ...chrome, storage: { session: chrome.storage.session } },
      now: () => 0,
    });

    await expect(relay.shouldStandDown(TAB, 'https://shop.example/', 1_000)).resolves.toMatchObject({
      standDown: true,
    });
  });

  it('ignores garbage a page wrote into the sessionStorage slot', async () => {
    const h = harness();
    const storage = new Map([[RELAY_SESSION_STORAGE_KEY, '{not json']]);
    const page = h.open('https://shop.example/', 1_000, undefined, storage);
    await h.flush();

    expect(page.record).toEqual({ v: 1, host: 'shop.example', at: 1_000, matches: [] });
    await expect(h.query('https://shop.example/', 1_100)).resolves.toMatchObject({ standDown: false });
  });

  it("drops a stored record from another shop instead of re-sending it", async () => {
    const h = harness();
    const storage = new Map([
      [
        RELAY_SESSION_STORAGE_KEY,
        JSON.stringify({ v: 1, host: 'other.example', at: 900, matches: [{ policyId: 'cj', params: ['cjevent'] }] }),
      ],
    ]);
    const page = h.open('https://shop.example/', 1_000, undefined, storage);
    await h.flush();

    expect(page.record?.matches).toEqual([]);
    expect(storage.has(RELAY_SESSION_STORAGE_KEY)).toBe(false);
    await expect(h.query('https://shop.example/', 1_100)).resolves.toMatchObject({ standDown: false });
  });

  it("a fresh referral on a new shop replaces the previous shop's record", async () => {
    const h = harness();
    h.open('https://other.example/?cjevent=abc', 1_000);
    h.open('https://shop.example/?cjevent=def', 60_000);
    await h.flush();

    await expect(h.relay.landingFor(TAB, 60_000)).resolves.toMatchObject({ host: 'shop.example' });
    await expect(h.query('https://shop.example/', 60_100)).resolves.toMatchObject({ standDown: true });
  });

  it('ignores a malformed record passed straight to ingestCapture', async () => {
    const h = harness();
    await h.relay.ingestCapture(TAB, { v: 2, host: 'shop.example' } as never, 1_000);

    await expect(h.relay.landingFor(TAB, 1_000)).resolves.toBeUndefined();
  });
});

describe('relay: selfClickLift', () => {
  const selfPatterns: SelfExemption[] = [
    { name: 'cjevent', value: 'own-click', match: 'equals', networkId: 'cj' },
  ];
  const policies = [cjPolicy, impactPolicy];
  const lifting = () => harness({ policies, selfPatterns, selfClickLift: 'same-network' });

  it("lifts a competitor's earlier CJ stand-down after our own CJ click, even when the page strips it", async () => {
    const h = lifting();
    h.open('https://shop.example/?cjevent=someone-else', 1_000);
    await h.flush();
    await expect(h.query('https://shop.example/', 1_100)).resolves.toMatchObject({ standDown: true });

    const own = h.open('https://shop.example/?cjevent=own-click', 2_000);
    own.window.location.href = 'https://shop.example/';
    await h.flush();

    await expect(h.query('https://shop.example/', 2_500)).resolves.toMatchObject({
      standDown: false,
      reason: 'self-click-lifted',
    });
    // And on later pages of the visit.
    h.open('https://shop.example/cart', 3_000);
    await h.flush();
    await expect(h.query('https://shop.example/cart', 3_100)).resolves.toMatchObject({ standDown: false });
  });

  it('drops an unqueried earlier CJ landing in the tab once our own CJ click lands', async () => {
    const h = lifting();
    h.open('https://shop.example/?cjevent=someone-else', 1_000);
    h.open('https://shop.example/?cjevent=own-click', 2_000);
    await h.flush();

    await expect(h.query('https://shop.example/', 2_500)).resolves.toMatchObject({ standDown: false });
  });

  it('a competitor click after our own click stands down', async () => {
    const h = lifting();
    h.open('https://shop.example/?cjevent=own-click', 1_000);
    h.open('https://shop.example/?cjevent=someone-else', 2_000);
    await h.flush();

    await expect(h.query('https://shop.example/', 2_500)).resolves.toMatchObject({ standDown: true });
  });

  it("a competitor's referral in another tab after our click keeps the stand-down", async () => {
    const h = lifting();
    h.open('https://shop.example/?cjevent=own-click', 1_000);
    await h.flush();

    await h.relay.ingestCapture(
      TAB + 1,
      { v: 1, host: 'shop.example', at: 2_000, matches: [{ policyId: 'cj', params: ['cjevent'] }] },
      2_000,
    );
    await expect(h.relay.shouldStandDown(TAB + 1, 'https://shop.example/', 2_000)).resolves.toMatchObject({
      standDown: true,
    });

    await expect(h.query('https://shop.example/', 2_500)).resolves.toMatchObject({ standDown: true });
  });

  it('never lifts another network: our CJ click leaves an Impact stand-down alone', async () => {
    const h = lifting();
    h.open('https://shop.example/?irclickid=someone-else', 1_000);
    await h.flush();
    await h.query('https://shop.example/', 1_100);

    h.open('https://shop.example/?cjevent=own-click', 2_000);
    await h.flush();

    await expect(h.query('https://shop.example/', 2_500)).resolves.toMatchObject({
      standDown: true,
      policyId: 'impact',
    });
  });

  it('is off by default: our own click only exempts, the earlier stand-down holds', async () => {
    const h = harness({ policies, selfPatterns });
    h.open('https://shop.example/?cjevent=someone-else', 1_000);
    await h.flush();
    await h.query('https://shop.example/', 1_100);

    const own = h.open('https://shop.example/?cjevent=own-click', 2_000);
    await h.flush();

    expect(own.record).not.toHaveProperty('self');
    await expect(h.query('https://shop.example/', 2_500)).resolves.toMatchObject({ standDown: true });
  });

  it('never trusts an own click read back from page-writable sessionStorage', async () => {
    const h = lifting();
    h.open('https://shop.example/?cjevent=someone-else', 1_000);
    await h.flush();
    await expect(h.query('https://shop.example/', 1_100)).resolves.toMatchObject({ standDown: true });

    // A page script plants a fake "own click" record in sessionStorage.
    const storage = new Map([
      [
        RELAY_SESSION_STORAGE_KEY,
        JSON.stringify({ v: 1, host: 'shop.example', at: 1_500, matches: [], self: ['cj'] }),
      ],
    ]);
    const page = h.open('https://shop.example/cart', 2_000, undefined, storage);
    await h.flush();

    expect(page.record).not.toHaveProperty('self');
    await expect(h.query('https://shop.example/cart', 2_100)).resolves.toMatchObject({ standDown: true });
  });

  it("a stale own click re-sent from storage can't erase a newer competitor forward", async () => {
    const h = lifting();
    const www = new Map<string, string>();
    // Our own click on www (mirrored to www's sessionStorage).
    h.open('https://www.shop.example/?cjevent=own-click', 1_000, undefined, www);
    // Later, a competitor's click lands on link.<shop> and forwards to www.
    h.open('https://link.shop.example/go?cjevent=someone-else', 2_000);
    h.open('https://www.shop.example/product', 2_500, 'https://link.shop.example/', www);
    await h.flush();

    await expect(h.query('https://www.shop.example/product', 2_600)).resolves.toMatchObject({
      standDown: true,
    });
  });

  it("an own click only counts in the page's own URL, not a later page's referrer", async () => {
    const h = lifting();
    // Our own click, then a competitor's CJ referral (another tab) is decided.
    h.open('https://shop.example/?cjevent=own-click', 1_000);
    await h.flush();
    await h.relay.ingestCapture(
      TAB + 1,
      { v: 1, host: 'shop.example', at: 2_000, matches: [{ policyId: 'cj', params: ['cjevent'] }] },
      2_000,
    );
    await h.relay.shouldStandDown(TAB + 1, 'https://shop.example/', 2_000);

    // Back in our tab, the shopper clicks through; the full referrer still holds
    // our param. That is not a new own click.
    const next = h.open('https://shop.example/cart', 3_000, 'https://shop.example/?cjevent=own-click');
    await h.flush();

    expect(next.record).not.toHaveProperty('self');
    await expect(h.query('https://shop.example/cart', 3_100)).resolves.toMatchObject({ standDown: true });
  });

  it('reports the own click by policy id only, never the value', async () => {
    const h = lifting();
    h.open('https://shop.example/?cjevent=own-click&email=person@example.com', 1_000);
    await h.flush();

    expect(h.sent.at(-1)?.record).toEqual({
      v: 1,
      host: 'shop.example',
      at: 1_000,
      matches: [],
      self: ['cj'],
    });
    expect(JSON.stringify(h.sent)).not.toContain('own-click');
  });
});

describe('policy.detection.trackingHosts', () => {
  it('validates as a DomainRule list', () => {
    expect(() =>
      validatePolicy({
        ...cjPolicy,
        detection: { ...cjPolicy.detection, trackingHosts: [{ pattern: 'go.example', kind: 'suffix' }] },
      }),
    ).not.toThrow();
    expect(() =>
      validatePolicy({
        ...cjPolicy,
        detection: { ...cjPolicy.detection, trackingHosts: [{ pattern: 'go.example', kind: 'glob' }] },
      }),
    ).toThrow(/DomainRule.kind/);
  });
});

function harness(
  opts: {
    policies?: readonly StanddownPolicy[];
    selfPatterns?: readonly SelfExemption[];
    maxAgeMs?: number;
    selfClickLift?: 'off' | 'same-network';
  } = {},
) {
  const policies = opts.policies ?? [cjPolicy];
  const chrome = fakeChrome();
  const pending: Promise<unknown>[] = [];
  const sent: RelayCaptureMessage[] = [];
  const relay = createRelayStanddown({
    policies,
    chrome,
    now: () => 0,
    ...(opts.selfPatterns ? { selfPatterns: opts.selfPatterns } : {}),
    ...(opts.maxAgeMs ? { maxAgeMs: opts.maxAgeMs } : {}),
    ...(opts.selfClickLift ? { selfClickLift: opts.selfClickLift } : {}),
  });

  return {
    chrome,
    relay,
    sent,
    sessionArea: chrome.storage.session,
    localArea: chrome.storage.local,
    open(url: string, at: number, referrer?: string, storage?: Map<string, string>) {
      const fake = fakeWindow(url, referrer, storage);
      const result = captureLanding({
        policies,
        window: fake.window,
        now: () => at,
        ...(opts.selfPatterns ? { selfPatterns: opts.selfPatterns } : {}),
        ...(opts.maxAgeMs ? { maxAgeMs: opts.maxAgeMs } : {}),
        ...(opts.selfClickLift ? { selfClickLift: opts.selfClickLift } : {}),
        sendMessage: (message) => {
          sent.push(structuredClone(message));
          const host = new URL(url).hostname;
          const delivery = relay.ingestCapture(TAB, message.record, at).then(() => host);
          pending.push(delivery);
          return delivery;
        },
      });
      return { window: fake.window, record: result?.record };
    },
    async flush() {
      await Promise.all(pending);
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    query(url: string, at: number) {
      return relay.shouldStandDown(TAB, url, at);
    },
  };
}

function fakeWindow(url: string, referrer?: string, storage = new Map<string, string>()) {
  const window: CaptureWindowLike & { location: { href: string }; storage: Map<string, string> } = {
    location: { href: url },
    document: { referrer: referrer ?? '' },
    // A real browser on a fresh navigation (own clicks count only then).
    performance: { timeOrigin: 0, getEntriesByType: () => [{ type: 'navigate' }] },
    storage,
    sessionStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => {
        storage.set(key, value);
      },
      removeItem: (key) => {
        storage.delete(key);
      },
    },
  };
  return { window };
}

class MemoryArea implements ChromeStorageAreaLike {
  readonly data = new Map<string, unknown>();

  get(keys?: string | string[] | Record<string, unknown> | null) {
    const wanted =
      keys === null || keys === undefined
        ? [...this.data.keys()]
        : typeof keys === 'string'
          ? [keys]
          : Array.isArray(keys)
            ? keys
            : Object.keys(keys);
    const out: Record<string, unknown> = {};
    for (const key of wanted) {
      if (this.data.has(key)) out[key] = structuredClone(this.data.get(key));
    }
    return Promise.resolve(out);
  }

  set(items: Record<string, unknown>) {
    for (const [key, value] of Object.entries(items)) this.data.set(key, structuredClone(value));
    return Promise.resolve();
  }

  remove(keys: string | string[]) {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.data.delete(key);
    return Promise.resolve();
  }
}

function fakeEvent<T extends (...args: never[]) => unknown>() {
  const listeners = new Set<T>();
  return {
    listeners,
    addListener: (listener: T) => {
      listeners.add(listener);
    },
    removeListener: (listener: T) => {
      listeners.delete(listener);
    },
  };
}

function fakeChrome() {
  type MessageListener = Parameters<
    NonNullable<NonNullable<RelayChromeLike['runtime']>['onMessage']>['addListener']
  >[0];
  const onMessage = fakeEvent<MessageListener>();
  const onRemoved = fakeEvent<(tabId: number) => void>();

  return {
    runtime: {
      onMessage: {
        ...onMessage,
        dispatch(message: unknown, sender: RelaySenderLike) {
          return new Promise<RelayMessageResponse | undefined>((resolve) => {
            for (const listener of onMessage.listeners) {
              if (listener(message, sender, resolve) === true) return;
            }
            resolve(undefined);
          });
        },
      },
    },
    storage: { local: new MemoryArea(), session: new MemoryArea() },
    tabs: {
      onRemoved: {
        ...onRemoved,
        emit(tabId: number) {
          for (const listener of onRemoved.listeners) listener(tabId);
        },
      },
    },
  };
}
