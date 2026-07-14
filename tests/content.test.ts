import { describe, expect, it, vi } from 'vitest';
import type { Decision } from '../src';
import {
  type ContentHistoryLike,
  type ContentWindowLike,
  collectContentSignals,
  createContentStanddown,
} from '../src/content';
import { cjPolicy } from '../src/policies';
import type { WebStorageLike } from '../src/stores';

describe('content adapter', () => {
  it('collects cookie names without exposing cookie values', () => {
    const windowLike = new FakeContentWindow(
      'https://merchant.example/product',
      'session_id=secret; cjevent_dc=hidden=value; unrelated=abc',
    );

    const signals = collectContentSignals({
      window: windowLike,
      now: () => 1_000,
    });

    expect(signals.cookieNames).toEqual([
      'session_id',
      'cjevent_dc',
      'unrelated',
    ]);
    expect(JSON.stringify(signals)).not.toContain('secret');
    expect(JSON.stringify(signals)).not.toContain('hidden=value');
  });

  it('warns once at construction on a bare-label suffix disableHost', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const controller = createContentStanddown({
        // `'ebay.'` is inert as a suffix rule — the substring mis-port footgun.
        // The adapter should surface it at wiring time, not only per-navigation.
        policies: [
          {
            ...cjPolicy,
            detection: { disableHosts: [{ pattern: 'ebay.', kind: 'suffix' }] },
          },
        ],
        window: new FakeContentWindow('https://merchant.example/product', ''),
        now: () => 1_000,
      });
      // The construction lint runs synchronously, before any ingest — so the
      // FIRST warn is the wiring-time surfacing we care about. (A later ingest's
      // validatePolicies may warn again; that's pre-existing and harmless.)
      expect(warn).toHaveBeenCalled();
      expect(warn.mock.calls[0]?.[0]).toMatch(/bare/);
      controller.dispose?.();
    } finally {
      warn.mockRestore();
    }
  });

  it('does not warn at construction for a clean policy set', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const controller = createContentStanddown({
        policies: [cjPolicy],
        window: new FakeContentWindow('https://merchant.example/product', ''),
        now: () => 1_000,
      });
      controller.dispose?.();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('reports partial signal coverage (no redirect-chain plane)', () => {
    const signals = collectContentSignals({
      window: new FakeContentWindow('https://merchant.example/product', ''),
      now: () => 1_000,
    });

    expect(signals.signalCoverage).toBe('partial');
  });

  it('matches cookie rules only against extracted names', async () => {
    const windowLike = new FakeContentWindow(
      'https://merchant.example/product',
      'unrelated=cjevent_dc',
    );
    const controller = createContentStanddown({
      policies: [cjPolicy],
      window: windowLike,
      now: () => 2_000,
    });

    await expect(controller.ready).resolves.toMatchObject({
      standDown: false,
      reason: 'no-active-standdown',
    });

    controller.dispose();
  });

  it('re-evaluates on SPA pushState navigations', async () => {
    let now = 3_000;
    const decisions: Decision[] = [];
    const windowLike = new FakeContentWindow(
      'https://merchant.example/product',
      '',
    );
    const controller = createContentStanddown({
      policies: [cjPolicy],
      window: windowLike,
      now: () => now,
      onDecision: (decision) => {
        decisions.push(decision);
      },
    });

    await expect(controller.ready).resolves.toMatchObject({
      standDown: false,
      reason: 'no-active-standdown',
    });

    now = 3_500;
    windowLike.history.pushState(
      null,
      '',
      'https://merchant.example/product?cjevent=abc',
    );
    await flushPromises();

    expect(decisions.at(-1)).toMatchObject({
      standDown: true,
      policyId: 'cj',
    });
    await expect(controller.shouldStandDown(undefined, 3_501)).resolves.toMatchObject({
      standDown: true,
      policyId: 'cj',
    });

    controller.dispose();
  });

  it('re-evaluates on SPA replaceState and popstate navigations', async () => {
    let now = 4_000;
    const decisions: Decision[] = [];
    const windowLike = new FakeContentWindow(
      'https://merchant.example/product',
      '',
    );
    const controller = createContentStanddown({
      policies: [cjPolicy],
      window: windowLike,
      now: () => now,
      onDecision: (decision) => {
        decisions.push(decision);
      },
    });

    await controller.ready;
    now = 4_500;
    windowLike.history.replaceState(
      null,
      '',
      'https://merchant.example/product?cjevent=abc',
    );
    await flushPromises();

    expect(decisions.at(-1)).toMatchObject({
      standDown: true,
      policyId: 'cj',
    });

    now = 5_000;
    windowLike.location.href = 'https://other.example/product';
    windowLike.dispatchPopState();
    await flushPromises();

    expect(decisions.at(-1)).toMatchObject({
      standDown: false,
      reason: 'no-active-standdown',
    });

    controller.dispose();
  });

  it('keeps local-ttl stand-down across same browser-session tabs', async () => {
    const sharedLocal = new FakeWebStorage();
    const tabA = createContentStanddown({
      policies: [cjPolicy],
      window: new FakeContentWindow(
        'https://merchant.example/?cjevent=abc',
        '',
        '',
        { localStorage: sharedLocal },
      ),
      storage: 'local-ttl',
      now: () => 1_000,
    });

    await tabA.ready;
    await expect(tabA.shouldStandDown('merchant.example', 2_000)).resolves.toMatchObject({
      standDown: true,
      policyId: 'cj',
    });

    const tabB = createContentStanddown({
      policies: [cjPolicy],
      window: new FakeContentWindow('https://merchant.example/', '', '', {
        localStorage: sharedLocal,
      }),
      storage: 'local-ttl',
      now: () => 3_000,
    });

    await tabB.ready;
    await expect(tabB.shouldStandDown('merchant.example', 3_500)).resolves.toMatchObject({
      standDown: true,
      policyId: 'cj',
    });
    await expect(tabA.shouldStandDown('merchant.example', 4_000)).resolves.toMatchObject({
      standDown: true,
      policyId: 'cj',
    });

    tabA.dispose();
    tabB.dispose();
  });

  it('supports local-ttl mode without sessionStorage', async () => {
    const controller = createContentStanddown({
      policies: [cjPolicy],
      window: new FakeContentWindow(
        'https://merchant.example/?cjevent=abc',
        '',
        '',
        { sessionStorage: false },
      ),
      storage: 'local-ttl',
      now: () => 5_000,
    });

    await expect(controller.ready).resolves.toMatchObject({
      standDown: true,
      policyId: 'cj',
    });

    controller.dispose();
  });

  it('fails closed when content storage fails', async () => {
    const controller = createContentStanddown({
      policies: [cjPolicy],
      window: new FakeContentWindow(
        'https://merchant.example/?cjevent=abc',
        '',
        '',
        { sessionStorage: new ThrowingWebStorage() },
      ),
      now: () => 6_000,
    });

    await expect(controller.ready).resolves.toMatchObject({
      standDown: true,
      reason: 'store-error',
    });

    controller.dispose();
  });

  it('fails closed and stops firing onDecision after dispose', async () => {
    let now = 7_000;
    const decisions: Decision[] = [];
    const windowLike = new FakeContentWindow(
      'https://merchant.example/product',
      '',
    );
    const controller = createContentStanddown({
      policies: [cjPolicy],
      window: windowLike,
      now: () => now,
      onDecision: (decision) => {
        decisions.push(decision);
      },
    });

    await controller.ready;
    const countBeforeDispose = decisions.length;

    controller.dispose();

    now = 7_500;
    windowLike.location.href = 'https://merchant.example/product?cjevent=abc';
    await expect(controller.evaluate()).resolves.toMatchObject({
      standDown: true,
      reason: 'controller-disposed',
    });

    expect(decisions).toHaveLength(countBeforeDispose);
  });
});

class FakeContentWindow implements ContentWindowLike {
  readonly location: { href: string };
  readonly document: { referrer: string; cookie: string };
  readonly sessionStorage: WebStorageLike | undefined;
  readonly localStorage: WebStorageLike | undefined;
  readonly history: ContentHistoryLike;
  readonly #popStateListeners = new Set<() => void>();

  constructor(
    href: string,
    cookie: string,
    referrer = '',
    storage: {
      sessionStorage?: WebStorageLike | false;
      localStorage?: WebStorageLike | false;
    } = {},
  ) {
    this.location = { href };
    this.document = { referrer, cookie };
    this.sessionStorage =
      storage.sessionStorage === false
        ? undefined
        : storage.sessionStorage ?? new FakeWebStorage();
    this.localStorage =
      storage.localStorage === false
        ? undefined
        : storage.localStorage ?? new FakeWebStorage();
    this.history = {
      pushState: (_data, _unused, url) => {
        this.setUrl(url);
      },
      replaceState: (_data, _unused, url) => {
        this.setUrl(url);
      },
    };
  }

  setTimeout(handler: () => void): number {
    queueMicrotask(handler);
    return 0;
  }

  addEventListener(type: 'popstate', listener: () => void): void {
    if (type === 'popstate') {
      this.#popStateListeners.add(listener);
    }
  }

  removeEventListener(type: 'popstate', listener: () => void): void {
    if (type === 'popstate') {
      this.#popStateListeners.delete(listener);
    }
  }

  dispatchPopState(): void {
    for (const listener of this.#popStateListeners) {
      listener();
    }
  }

  private setUrl(url: string | URL | null | undefined): void {
    if (url !== undefined && url !== null) {
      this.location.href = new URL(String(url), this.location.href).href;
    }
  }
}

class FakeWebStorage implements WebStorageLike {
  readonly #items = new Map<string, string>();

  getItem(key: string): string | null {
    return this.#items.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.#items.set(key, value);
  }

  removeItem(key: string): void {
    this.#items.delete(key);
  }
}

class ThrowingWebStorage implements WebStorageLike {
  getItem(_key: string): string | null {
    throw new Error('storage get failed');
  }

  setItem(_key: string, _value: string): void {
    throw new Error('storage set failed');
  }

  removeItem(_key: string): void {
    throw new Error('storage remove failed');
  }
}

async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
