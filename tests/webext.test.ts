import { describe, expect, it } from 'vitest';
import {
  canonicalPolicyBundlePayload,
  type SignedPolicyBundle,
  type StanddownPolicy,
} from '../src';
import { cjPolicy } from '../src/policies';
import type { ChromeStorageAreaLike } from '../src/stores';
import {
  type ChromeLike,
  createStanddown,
  type FetchLike,
  type RuntimeMessageSenderLike,
  type StanddownMessageResponse,
  type WebNavigationCommittedDetails,
  type WebRequestBeforeDetails,
} from '../src/webext';

const textEncoder = new TextEncoder();

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
  const chrome = {
    runtime: {
      onMessage: new FakeMessageEvent(),
    },
    storage: {
      local: opts.local ?? new FakeChromeStorageArea(),
    },
    tabs: {
      onRemoved: new FakeEvent<[number]>(),
    },
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
