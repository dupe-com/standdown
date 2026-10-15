import { describe, expect, it } from 'vitest';
import {
  canonicalPolicyBundlePayload,
  type SignedPolicyBundle,
  type StanddownPolicy,
} from '../src';
import { cjPolicy, impactPolicy, universalPolicy } from '../src/policies';
import type { ChromeStorageAreaLike } from '../src/stores';
import {
  type ChromeLike,
  createStanddown,
  type FetchLike,
  type RuntimeMessageSenderLike,
  type StanddownMessageResponse,
  type TabLike,
  type WebNavigationCommittedDetails,
  type WebRequestBeforeDetails,
} from '../src/webext';

const textEncoder = new TextEncoder();

describe('webext adapter: selfClickLift timing', () => {
  const selfPatterns = [{ name: 'cjevent', value: 'own', match: 'equals' as const, networkId: 'cj' }];
  const run = async (own: Partial<WebNavigationCommittedDetails>) => {
    const chrome = fakeChrome({ webRequest: false });
    let clock = 1_000;
    const controller = createStanddown({
      policies: [cjPolicy],
      chrome,
      selfPatterns,
      selfClickLift: 'same-network',
      now: () => clock,
    });
    chrome.webNavigation?.onCommitted?.emit({ tabId: 7, frameId: 0, url: 'https://merchant.example/?cjevent=abc' });
    await flushPromises();
    clock = 2_000;
    chrome.webNavigation?.onCommitted?.emit({ tabId: 7, frameId: 0, url: 'https://merchant.example/?cjevent=own', ...own });
    await flushPromises();
    return controller.shouldStandDown(7, 2_001);
  };

  it('a fresh navigation carrying our own click lifts the earlier competitor', async () => {
    await expect(run({ transitionType: 'link' })).resolves.toMatchObject({ standDown: false });
  });

  it('a reload of our own-click URL is not a new click', async () => {
    await expect(run({ transitionType: 'reload' })).resolves.toMatchObject({ standDown: true });
  });

  it('back/forward to our own-click URL is not a new click', async () => {
    await expect(
      run({ transitionType: 'link', transitionQualifiers: ['forward_back'] }),
    ).resolves.toMatchObject({ standDown: true });
  });
});

describe('webext adapter: shared afsrc=1', () => {
  const run = async (landing: string) => {
    const chrome = fakeChrome({ webRequest: true });
    const controller = createStanddown({
      policies: [cjPolicy, impactPolicy, universalPolicy],
      chrome,
      selfPatterns: [{ name: 'my_click_id', value: 'own', match: 'equals', networkId: 'cj' }],
      now: () => 1_000,
    });
    chrome.webRequest?.onBeforeRequest?.emit({ tabId: 5, type: 'main_frame', frameId: 0, url: landing });
    chrome.webNavigation?.onCommitted?.emit({ tabId: 5, frameId: 0, url: landing });
    await flushPromises();
    const decision = await controller.shouldStandDown(5, 1_001);
    controller.dispose();
    return decision;
  };

  it('the own click explains afsrc=1 in the landing URL and redirect chain', async () => {
    await expect(run('https://merchant.example/?my_click_id=own&afsrc=1')).resolves.toMatchObject({
      standDown: false,
    });
  });

  it('afsrc=1 alone still stands down', async () => {
    await expect(run('https://merchant.example/?afsrc=1')).resolves.toMatchObject({ standDown: true });
  });
});

describe('webext adapter', () => {
  it('assembles webRequest redirect chains before webNavigation evaluation', async () => {
    const chrome = fakeChrome({ webRequest: true });
    const controller = createStanddown({
      policies: [cjPolicy],
      chrome,
      now: () => 1_000,
    });

    chrome.webRequest?.onBeforeRequest?.emit({
      tabId: 7,
      type: 'main_frame',
      frameId: 0,
      url: 'https://www.dpbolvw.net/click-123',
    });
    chrome.webNavigation?.onCommitted?.emit({
      tabId: 7,
      frameId: 0,
      url: 'https://merchant.example/product',
    });
    await flushPromises();

    await expect(controller.shouldStandDown(7, 1_001)).resolves.toMatchObject({
      standDown: true,
      policyId: 'cj',
    });
    await expect(controller.session.exportAuditLog()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          detection: expect.objectContaining({
            matched: expect.arrayContaining([
              expect.objectContaining({
                kind: 'redirect-domain',
                rule: 'suffix:dpbolvw.net',
              }),
            ]),
          }),
        }),
      ]),
    );

    controller.dispose();
  });

  it('rehydrates chrome.storage.local state across service worker restarts', async () => {
    const chrome = fakeChrome({ webRequest: true });
    const first = createStanddown({
      policies: [cjPolicy],
      chrome,
      now: () => 2_000,
    });

    chrome.webNavigation?.onCommitted?.emit({
      tabId: 3,
      frameId: 0,
      url: 'https://merchant.example/?cjevent=abc',
    });
    await flushPromises();
    first.dispose();

    const restarted = createStanddown({
      policies: [cjPolicy],
      chrome,
      now: () => 2_500,
    });
    const response = await restarted.handleMessage(
      { type: 'standdown:shouldStandDown' },
      {
        tab: {
          id: 3,
          url: 'https://merchant.example/product',
        },
      },
    );

    expect(response?.decision).toMatchObject({
      standDown: true,
      policyId: 'cj',
    });

    restarted.dispose();
  });

  it('keeps stand-down across service worker restarts without chrome.storage.session', async () => {
    const local = new FakeChromeStorageArea();
    const firstChrome = fakeChrome({
      webRequest: false,
      storageSession: false,
      local,
    });
    const first = createStanddown({
      policies: [cjPolicy],
      chrome: firstChrome,
      now: () => 1_000,
    });

    firstChrome.webNavigation?.onCommitted?.emit({
      tabId: 1,
      frameId: 0,
      url: 'https://merchant.example/?cjevent=abc',
    });
    await flushPromises();
    await expect(
      first.shouldStandDownForUrl('https://merchant.example/p', 2_000),
    ).resolves.toMatchObject({
      standDown: true,
      policyId: 'cj',
    });
    first.dispose();

    const restartedChrome = fakeChrome({
      webRequest: false,
      storageSession: false,
      local,
    });
    const restarted = createStanddown({
      policies: [cjPolicy],
      chrome: restartedChrome,
      now: () => 3_000,
    });

    await expect(
      restarted.shouldStandDownForUrl('https://merchant.example/p', 3_000),
    ).resolves.toMatchObject({
      standDown: true,
      policyId: 'cj',
    });

    restartedChrome.webNavigation?.onCommitted?.emit({
      tabId: 2,
      frameId: 0,
      url: 'https://unrelated.example/',
    });
    await flushPromises();

    await expect(
      restarted.shouldStandDownForUrl('https://merchant.example/p', 3_500),
    ).resolves.toMatchObject({
      standDown: true,
      policyId: 'cj',
    });

    restarted.dispose();
  });

  it('degrades to webNavigation-only final URL parameter detection', async () => {
    const chrome = fakeChrome({ webRequest: false });
    const controller = createStanddown({
      policies: [cjPolicy],
      chrome,
      now: () => 3_000,
    });

    expect(controller.mode).toBe('webNavigation');

    chrome.webNavigation?.onCommitted?.emit({
      tabId: 9,
      frameId: 0,
      url: 'https://merchant.example/?cjevent=abc',
    });
    await flushPromises();

    await expect(controller.shouldStandDown(9, 3_001)).resolves.toMatchObject({
      standDown: true,
      policyId: 'cj',
    });

    controller.dispose();
  });

  it('does not infer redirect-domain matches in degraded mode', async () => {
    const chrome = fakeChrome({ webRequest: false });
    const controller = createStanddown({
      policies: [cjPolicy],
      chrome,
      now: () => 4_000,
    });

    chrome.webNavigation?.onCommitted?.emit({
      tabId: 10,
      frameId: 0,
      url: 'https://merchant.example/product',
    });
    await flushPromises();

    await expect(controller.shouldStandDown(10, 4_001)).resolves.toMatchObject({
      standDown: false,
      reason: 'no-active-standdown',
    });

    controller.dispose();
  });

  it('throws when webNavigation is unavailable', () => {
    const chrome = fakeChrome({ webRequest: true, webNavigation: false });

    expect(() =>
      createStanddown({
        policies: [cjPolicy],
        chrome,
        now: () => 4_500,
      }),
    ).toThrow('standdown/webext requires chrome.webNavigation.onCommitted');
  });

  it('keeps multi-hop redirect chains isolated across interleaved tabs', async () => {
    const chrome = fakeChrome({ webRequest: true });
    const controller = createStanddown({
      policies: [cjPolicy],
      chrome,
      now: () => 4_600,
    });

    chrome.webRequest?.onBeforeRequest?.emit({
      tabId: 21,
      type: 'main_frame',
      frameId: 0,
      requestId: 'tab-21',
      url: 'https://www.dpbolvw.net/click-123',
    });
    chrome.webRequest?.onBeforeRequest?.emit({
      tabId: 22,
      type: 'main_frame',
      frameId: 0,
      requestId: 'tab-22',
      url: 'https://unrelated.example/redirect',
    });
    chrome.webRequest?.onBeforeRequest?.emit({
      tabId: 21,
      type: 'main_frame',
      frameId: 0,
      requestId: 'tab-21',
      url: 'https://www.jdoqocy.com/click-456',
    });
    chrome.webNavigation?.onCommitted?.emit({
      tabId: 22,
      frameId: 0,
      url: 'https://other.example/product',
    });
    chrome.webNavigation?.onCommitted?.emit({
      tabId: 21,
      frameId: 0,
      url: 'https://merchant.example/product',
    });
    await flushPromises();

    await expect(controller.shouldStandDown(21, 4_601)).resolves.toMatchObject({
      standDown: true,
      policyId: 'cj',
    });
    await expect(controller.shouldStandDown(22, 4_601)).resolves.toMatchObject({
      standDown: false,
      reason: 'no-active-standdown',
    });
    await expect(controller.session.exportAuditLog()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          detection: expect.objectContaining({
            matched: expect.arrayContaining([
              expect.objectContaining({ rule: 'suffix:dpbolvw.net' }),
              expect.objectContaining({ rule: 'suffix:jdoqocy.com' }),
            ]),
          }),
        }),
      ]),
    );

    controller.dispose();
  });

  it('resets stale redirect chains when a later request starts before commit', async () => {
    const chrome = fakeChrome({ webRequest: true });
    const controller = createStanddown({
      policies: [cjPolicy],
      chrome,
      now: () => 4_700,
    });

    chrome.webRequest?.onBeforeRequest?.emit({
      tabId: 23,
      type: 'main_frame',
      frameId: 0,
      requestId: 'aborted',
      url: 'https://www.dpbolvw.net/click-123',
    });
    chrome.webRequest?.onBeforeRequest?.emit({
      tabId: 23,
      type: 'main_frame',
      frameId: 0,
      requestId: 'new-navigation',
      url: 'https://unrelated.example/redirect',
    });
    chrome.webNavigation?.onCommitted?.emit({
      tabId: 23,
      frameId: 0,
      url: 'https://merchant.example/product',
    });
    await flushPromises();

    await expect(controller.shouldStandDown(23, 4_701)).resolves.toMatchObject({
      standDown: false,
      reason: 'no-active-standdown',
    });

    controller.dispose();
  });

  it('fails closed when chrome.storage.local fails', async () => {
    const chrome = fakeChrome({ webRequest: false });
    chrome.storage.local.failGet = true;
    const controller = createStanddown({
      policies: [cjPolicy],
      chrome,
      now: () => 5_000,
    });

    await expect(
      controller.shouldStandDownForUrl('https://merchant.example/product', 5_001),
    ).resolves.toMatchObject({
      standDown: true,
      reason: 'store-error',
    });

    controller.dispose();
  });

  it('fails closed when chrome.storage.local set fails', async () => {
    const chrome = fakeChrome({ webRequest: false });
    chrome.storage.local.failSet = true;
    const controller = createStanddown({
      policies: [cjPolicy],
      chrome,
      now: () => 5_500,
    });

    await expect(
      controller.ingestNavigation(30, 'https://merchant.example/?cjevent=abc'),
    ).resolves.toMatchObject({
      standDown: true,
      reason: 'store-error',
    });

    controller.dispose();
  });

  it('responds to shouldStandDown runtime messages', async () => {
    const chrome = fakeChrome({ webRequest: false });
    createStanddown({
      policies: [cjPolicy],
      chrome,
      now: () => 6_000,
    });

    chrome.webNavigation?.onCommitted?.emit({
      tabId: 11,
      frameId: 0,
      url: 'https://merchant.example/?cjevent=abc',
    });
    await flushPromises();

    const response = await chrome.runtime.onMessage.emitWithResponse(
      { type: 'standdown:shouldStandDown', tabId: 11 },
      {},
    );

    expect(response?.decision).toMatchObject({
      standDown: true,
      policyId: 'cj',
    });
  });

  it('cleans tab state when tabs are removed', async () => {
    const chrome = fakeChrome({ webRequest: false });
    const controller = createStanddown({
      policies: [cjPolicy],
      chrome,
      now: () => 7_000,
    });

    chrome.webNavigation?.onCommitted?.emit({
      tabId: 40,
      frameId: 0,
      url: 'https://merchant.example/?cjevent=abc',
    });
    await flushPromises();
    await expect(controller.shouldStandDown(40, 7_001)).resolves.toMatchObject({
      standDown: true,
      policyId: 'cj',
    });

    chrome.tabs.onRemoved.emit(40);

    await expect(controller.shouldStandDown(40, 7_002)).resolves.toMatchObject({
      standDown: true,
      reason: 'missing-tab-url',
    });

    controller.dispose();
  });

  it('reads tabs and URLs through a configured sessionKey resolver', async () => {
    const chrome = fakeChrome({ webRequest: false });
    const controller = createStanddown({
      policies: [cjPolicy],
      chrome,
      now: () => 9_000,
      // Collapse a merchant's hosts onto one advertiser key.
      sessionKey: (url) =>
        new URL(url).hostname.endsWith('merchant.example')
          ? 'merchant.example'
          : undefined,
    });

    chrome.webNavigation?.onCommitted?.emit({
      tabId: 12,
      frameId: 0,
      url: 'https://www.merchant.example/?cjevent=abc',
    });
    await flushPromises();

    // The tab read finds the bucket the navigation was filed under, not the
    // www host it landed on.
    await expect(controller.shouldStandDown(12, 9_001)).resolves.toMatchObject({
      standDown: true,
      policyId: 'cj',
    });
    // So does a URL read for a sibling host that never navigated itself.
    await expect(
      controller.shouldStandDownForUrl(
        'https://checkout.merchant.example/pay',
        9_002,
      ),
    ).resolves.toMatchObject({ standDown: true, policyId: 'cj' });

    controller.dispose();
  });

  it('reads a tab it never saw navigate through the tab URL', async () => {
    const chrome = fakeChrome({
      webRequest: false,
      tabUrls: new Map([[21, 'https://merchant.example/cart']]),
    });
    const controller = createStanddown({
      policies: [cjPolicy],
      chrome,
      now: () => 10_000,
    });

    // Tab 30 lands on the merchant and files an active stand-down.
    chrome.webNavigation?.onCommitted?.emit({
      tabId: 30,
      frameId: 0,
      url: 'https://merchant.example/?cjevent=abc',
    });
    await flushPromises();

    // Tab 21 has no cached key, so the read falls back to chrome.tabs.get and
    // resolves the URL that tab is currently on.
    await expect(controller.shouldStandDown(21, 10_001)).resolves.toMatchObject({
      standDown: true,
      policyId: 'cj',
    });

    controller.dispose();
  });

  it('drops a cached tab key when a navigation resolves to no key', async () => {
    const tabUrls = new Map([[12, 'https://www.merchant.example/']]);
    const chrome = fakeChrome({ webRequest: false, tabUrls });
    const controller = createStanddown({
      policies: [cjPolicy],
      chrome,
      now: () => 12_000,
      sessionKey: (url) =>
        new URL(url).hostname.endsWith('merchant.example')
          ? 'merchant.example'
          : undefined,
    });

    // A first navigation caches the bucket it filed state under. Nothing is
    // standing down in it.
    chrome.webNavigation?.onCommitted?.emit({
      tabId: 12,
      frameId: 0,
      url: 'https://www.merchant.example/',
    });
    await flushPromises();
    await expect(controller.shouldStandDown(12, 12_001)).resolves.toMatchObject({
      standDown: false,
      reason: 'no-active-standdown',
    });

    // The next navigation in the same tab is unparseable, so the resolver
    // throws and ingest fails it closed.
    tabUrls.set(12, 'not a url');
    chrome.webNavigation?.onCommitted?.emit({
      tabId: 12,
      frameId: 0,
      url: 'not a url',
    });
    await flushPromises();

    // The stale key must not answer for it — that would report the previous
    // page's bucket for a navigation that just failed closed. The read
    // re-resolves and fails closed too.
    await expect(controller.shouldStandDown(12, 12_002)).resolves.toMatchObject({
      standDown: true,
      reason: 'missing-tab-url',
    });

    controller.dispose();
  });

  it('applies verified refresh bundles outside the decision path', async () => {
    const keyPair = await createSigningKeyPair();
    const updatedPolicy = additivePolicy(cjPolicy);
    const bundle = await signedBundle([updatedPolicy], keyPair.privateKey);
    const controller = createStanddown({
      policies: [cjPolicy],
      chrome: fakeChrome({ webRequest: false }),
      fetch: fakeFetch(bundle),
      refresh: {
        url: 'https://policies.example/bundle.json',
        publicKeyJwk: keyPair.publicJwk,
        intervalMs: 0,
      },
      now: () => 8_000,
    });

    expect(controller.getPolicies()[0]?.detection.redirectDomains).toHaveLength(
      cjPolicy.detection.redirectDomains?.length,
    );

    await expect(controller.refreshNow()).resolves.toEqual({
      ok: true,
      applied: 1,
    });
    expect(controller.getPolicies()[0]?.detection.redirectDomains).toHaveLength(
      (cjPolicy.detection.redirectDomains?.length ?? 0) + 1,
    );
    await expect(controller.session.exportAuditLog()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'refresh',
          decision: expect.objectContaining({
            reason: 'refresh-applied:1',
          }),
        }),
      ]),
    );

    controller.dispose();
  });

  it('rejects narrowed refresh bundles and keeps current policies', async () => {
    const keyPair = await createSigningKeyPair();
    const narrowed = clonePolicy(cjPolicy);
    narrowed.detection = {
      ...narrowed.detection,
      landingParams: (narrowed.detection.landingParams ?? []).slice(1),
    };
    const bundle = await signedBundle([narrowed], keyPair.privateKey);
    const controller = createStanddown({
      policies: [cjPolicy],
      chrome: fakeChrome({ webRequest: false }),
      fetch: fakeFetch(bundle),
      refresh: {
        url: 'https://policies.example/bundle.json',
        publicKeyJwk: keyPair.publicJwk,
        intervalMs: 0,
      },
      now: () => 8_500,
    });

    await expect(controller.refreshNow()).resolves.toEqual({
      ok: false,
      violation: 'cj:landing-params-narrowed',
    });
    expect(controller.getPolicies()[0]?.detection.landingParams).toEqual(
      cjPolicy.detection.landingParams,
    );
    await expect(controller.session.exportAuditLog()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'refresh',
          decision: expect.objectContaining({
            reason: 'refresh-rejected:cj:landing-params-narrowed',
          }),
        }),
      ]),
    );

    controller.dispose();
  });
});

function fakeChrome(opts: {
  webRequest: boolean;
  webNavigation?: boolean;
  storageSession?: boolean;
  local?: FakeChromeStorageArea;
  session?: FakeChromeStorageArea;
  /** Present ⇒ chrome.tabs.get exists and answers from this map. */
  tabUrls?: Map<number, string>;
}): ChromeLike & {
  webRequest?: { onBeforeRequest: FakeEvent<[WebRequestBeforeDetails]> };
  webNavigation?: { onCommitted: FakeEvent<[WebNavigationCommittedDetails]> };
  runtime: {
    onMessage: FakeMessageEvent;
  };
  storage: {
    local: FakeChromeStorageArea;
    session?: FakeChromeStorageArea;
  };
  tabs: {
    onRemoved: FakeEvent<[number]>;
  };
} {
  const includeWebNavigation = opts.webNavigation ?? true;
  const includeStorageSession = opts.storageSession ?? true;
  const tabUrls = opts.tabUrls;
  const tabs: {
    onRemoved: FakeEvent<[number]>;
    get?: (
      tabId: number,
      callback?: (tab: TabLike | undefined) => void,
    ) => undefined;
  } = { onRemoved: new FakeEvent<[number]>() };

  if (tabUrls !== undefined) {
    tabs.get = (tabId, callback) => {
      const url = tabUrls.get(tabId);
      callback?.(url === undefined ? undefined : { id: tabId, url });
      return undefined;
    };
  }

  const chrome = {
    runtime: {
      onMessage: new FakeMessageEvent(),
    },
    storage: {
      local: opts.local ?? new FakeChromeStorageArea(),
    },
    tabs,
  };
  const withWebNavigation = includeWebNavigation
    ? {
        ...chrome,
        webNavigation: {
          onCommitted: new FakeEvent<[WebNavigationCommittedDetails]>(),
        },
      }
    : chrome;
  const withStorage = includeStorageSession
    ? {
        ...withWebNavigation,
        storage: {
          ...withWebNavigation.storage,
          session: opts.session ?? new FakeChromeStorageArea(),
        },
      }
    : withWebNavigation;

  return opts.webRequest
    ? {
        ...withStorage,
        webRequest: {
          onBeforeRequest: new FakeEvent<[WebRequestBeforeDetails]>(),
        },
      }
    : withStorage;
}

class FakeEvent<TArgs extends unknown[]> {
  readonly #listeners = new Set<(...args: TArgs) => unknown>();

  addListener(listener: (...args: TArgs) => unknown): void {
    this.#listeners.add(listener);
  }

  removeListener(listener: (...args: TArgs) => unknown): void {
    this.#listeners.delete(listener);
  }

  emit(...args: TArgs): void {
    for (const listener of this.#listeners) {
      listener(...args);
    }
  }
}

class FakeMessageEvent {
  readonly #listeners = new Set<
    (
      message: unknown,
      sender: RuntimeMessageSenderLike,
      sendResponse: (response: StanddownMessageResponse | undefined) => void,
    ) => boolean | undefined
  >();

  addListener(
    listener: (
      message: unknown,
      sender: RuntimeMessageSenderLike,
      sendResponse: (response: StanddownMessageResponse | undefined) => void,
    ) => boolean | undefined,
  ): void {
    this.#listeners.add(listener);
  }

  removeListener(
    listener: (
      message: unknown,
      sender: RuntimeMessageSenderLike,
      sendResponse: (response: StanddownMessageResponse | undefined) => void,
    ) => boolean | undefined,
  ): void {
    this.#listeners.delete(listener);
  }

  async emitWithResponse(
    message: unknown,
    sender: RuntimeMessageSenderLike,
  ): Promise<StanddownMessageResponse | undefined> {
    return new Promise((resolve) => {
      for (const listener of this.#listeners) {
        const keepAlive = listener(message, sender, resolve);

        if (keepAlive === true) {
          return;
        }
      }

      resolve(undefined);
    });
  }
}

class FakeChromeStorageArea implements ChromeStorageAreaLike {
  readonly data: Record<string, unknown> = {};
  failGet = false;
  failSet = false;

  get(
    keys?: string | string[] | Record<string, unknown> | null,
    callback?: (items: Record<string, unknown>) => void,
  ): undefined {
    if (this.failGet) {
      throw new Error('storage get failed');
    }

    callback?.(this.itemsFor(keys));
    return undefined;
  }

  set(items: Record<string, unknown>, callback?: () => void): undefined {
    if (this.failSet) {
      throw new Error('storage set failed');
    }

    Object.assign(this.data, items);
    callback?.();
    return undefined;
  }

  remove(keys: string | string[], callback?: () => void): undefined {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      delete this.data[key];
    }

    callback?.();
    return undefined;
  }

  private itemsFor(
    keys?: string | string[] | Record<string, unknown> | null,
  ): Record<string, unknown> {
    if (keys === undefined || keys === null) {
      return { ...this.data };
    }

    if (typeof keys === 'string') {
      return this.data[keys] === undefined ? {} : { [keys]: this.data[keys] };
    }

    if (Array.isArray(keys)) {
      return Object.fromEntries(
        keys
          .filter((key) => this.data[key] !== undefined)
          .map((key) => [key, this.data[key]]),
      );
    }

    return Object.fromEntries(
      Object.entries(keys).map(([key, fallback]) => [
        key,
        this.data[key] ?? fallback,
      ]),
    );
  }
}

async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function createSigningKeyPair(): Promise<{
  privateKey: CryptoKey;
  publicJwk: JsonWebKey;
}> {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );

  return {
    privateKey: keyPair.privateKey,
    publicJwk: await crypto.subtle.exportKey('jwk', keyPair.publicKey),
  };
}

async function signedBundle(
  policies: readonly StanddownPolicy[],
  privateKey: CryptoKey,
): Promise<SignedPolicyBundle> {
  const unsigned = {
    schemaVersion: 1,
    policies,
  } as const;
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    textEncoder.encode(canonicalPolicyBundlePayload(unsigned)),
  );

  return {
    ...unsigned,
    signature: {
      algorithm: 'ECDSA-P256',
      value: bytesToBase64Url(new Uint8Array(signature)),
    },
  };
}

function fakeFetch(bundle: SignedPolicyBundle): FetchLike {
  return async () => ({
    ok: true,
    status: 200,
    async json() {
      return bundle;
    },
  });
}

function additivePolicy(policy: StanddownPolicy): StanddownPolicy {
  const next = clonePolicy(policy);
  next.detection = {
    ...next.detection,
    redirectDomains: [
      ...(next.detection.redirectDomains ?? []),
      { pattern: 'new-cj.example', kind: 'suffix' },
    ],
  };
  return next;
}

function clonePolicy(policy: StanddownPolicy): StanddownPolicy {
  return JSON.parse(JSON.stringify(policy)) as StanddownPolicy;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
