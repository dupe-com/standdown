import { describe, expect, it } from 'vitest';
import type { StanddownState } from '../src';
import {
  ChromeLocalStateStore,
  type ChromeStorageAreaLike,
  LocalStorageTtlStateStore,
  type WebStorageLike,
} from '../src/stores';

describe('StateStore implementations', () => {
  it('keeps chrome.storage.local ended-session records until their min-duration floor passes', async () => {
    const local = new FakeChromeStorageArea();
    await new ChromeLocalStateStore(local, {
      sessionId: 'browser-session-1',
      now: () => 0,
    }).save(stateWithSessionAndInactivityRecords());

    const loaded = await new ChromeLocalStateStore(local, {
      sessionId: 'browser-session-2',
      now: () => 1_799_999,
    }).load();

    expect(loaded?.sessions['session.example']).toMatchObject({
      sessionRule: 'session-or-min',
      policyId: 'test-session',
    });
    expect(loaded?.sessions['inactivity.example']).toMatchObject({
      sessionRule: 'inactivity-window',
      policyId: 'test-inactivity',
    });
  });

  it('drops chrome.storage.local ended-session records after their min-duration floor passes', async () => {
    const local = new FakeChromeStorageArea();
    await new ChromeLocalStateStore(local, {
      sessionId: 'browser-session-1',
      now: () => 0,
    }).save(stateWithSessionAndInactivityRecords());

    const loaded = await new ChromeLocalStateStore(local, {
      sessionId: 'browser-session-2',
      now: () => 1_800_000,
    }).load();

    expect(loaded?.sessions['session.example']).toBeUndefined();
    expect(loaded?.sessions['inactivity.example']).toMatchObject({
      sessionRule: 'inactivity-window',
      policyId: 'test-inactivity',
    });
  });

  it('treats missing chrome session identity as same-session', async () => {
    const local = new FakeChromeStorageArea();
    await new ChromeLocalStateStore(local, { now: () => 0 }).save(
      stateWithSessionAndInactivityRecords(),
    );

    const loaded = await new ChromeLocalStateStore(local, {
      now: () => 1_800_000,
    }).load();

    expect(loaded?.sessions['session.example']).toMatchObject({
      sessionRule: 'session-or-min',
      policyId: 'test-session',
    });
  });

  it('keeps localStorage-TTL ended-session records until their min-duration floor passes', async () => {
    const local = new FakeWebStorage();
    await new LocalStorageTtlStateStore(local, {
      sessionId: 'browser-session-1',
      ttlMs: 10_000,
      now: () => 1_000,
    }).save(stateWithSessionAndInactivityRecords());

    const loaded = await new LocalStorageTtlStateStore(local, {
      sessionId: 'browser-session-2',
      ttlMs: 2_000_000,
      now: () => 1_799_999,
    }).load();

    expect(loaded?.sessions['session.example']).toMatchObject({
      sessionRule: 'session-or-min',
      policyId: 'test-session',
    });
    expect(loaded?.sessions['inactivity.example']).toMatchObject({
      sessionRule: 'inactivity-window',
      policyId: 'test-inactivity',
    });
  });

  it('drops localStorage-TTL ended-session records after their min-duration floor passes', async () => {
    const local = new FakeWebStorage();
    await new LocalStorageTtlStateStore(local, {
      sessionId: 'browser-session-1',
      ttlMs: 2_000_000,
      now: () => 1_000,
    }).save(stateWithSessionAndInactivityRecords());

    const loaded = await new LocalStorageTtlStateStore(local, {
      sessionId: 'browser-session-2',
      ttlMs: 2_000_000,
      now: () => 1_800_000,
    }).load();

    expect(loaded?.sessions['session.example']).toBeUndefined();
    expect(loaded?.sessions['inactivity.example']).toMatchObject({
      sessionRule: 'inactivity-window',
      policyId: 'test-inactivity',
    });
  });

  it('uses localStorage identity when sessionStorage is unavailable', async () => {
    const local = new FakeWebStorage();
    await new LocalStorageTtlStateStore(local, {
      ttlMs: 2_000_000,
      now: () => 1_000,
    }).save(stateWithSessionAndInactivityRecords());

    const loaded = await new LocalStorageTtlStateStore(local, {
      ttlMs: 2_000_000,
      now: () => 2_000,
    }).load();

    expect(loaded?.sessions['session.example']).toMatchObject({
      sessionRule: 'session-or-min',
      policyId: 'test-session',
    });
  });

  it('expires localStorage-TTL state after its envelope TTL', async () => {
    const local = new FakeWebStorage();
    await new LocalStorageTtlStateStore(local, {
      sessionId: 'tab-session-1',
      ttlMs: 500,
      now: () => 1_000,
    }).save(stateWithSessionAndInactivityRecords());

    await expect(
      new LocalStorageTtlStateStore(local, {
        sessionId: 'tab-session-1',
        ttlMs: 500,
        now: () => 1_500,
      }).load(),
    ).resolves.toMatchObject({ sessions: {} });
  });

  it('keeps audit log when localStorage-TTL session state expires', async () => {
    const local = new FakeWebStorage();
    await new LocalStorageTtlStateStore(local, {
      sessionId: 'tab-session-1',
      ttlMs: 500,
      now: () => 1_000,
    }).save({
      ...stateWithSessionAndInactivityRecords(),
      auditLog: [
        {
          time: 1_000,
          action: 'ingest',
          advertiserHost: 'session.example',
          decision: {
            standDown: true,
            policyId: 'test-session',
            reason: 'test',
            behaviors: ['suppress-prompts'],
          },
        },
      ],
    });

    await expect(
      new LocalStorageTtlStateStore(local, {
        sessionId: 'tab-session-1',
        ttlMs: 500,
        now: () => 1_500,
      }).load(),
    ).resolves.toMatchObject({
      sessions: {},
      auditLog: [
        expect.objectContaining({
          action: 'ingest',
          advertiserHost: 'session.example',
        }),
      ],
    });
  });
});

function stateWithSessionAndInactivityRecords(): StanddownState {
  return {
    sessions: {
      'session.example': {
        advertiserHost: 'session.example',
        policyId: 'test-session',
        startedAt: 0,
        lastActivityAt: 0,
        sessionRule: 'session-or-min',
        minDurationMs: 1_800_000,
        behaviors: ['suppress-prompts'],
      },
      'inactivity.example': {
        advertiserHost: 'inactivity.example',
        policyId: 'test-inactivity',
        startedAt: 0,
        lastActivityAt: 0,
        expiresAt: 5_400_000,
        sessionRule: 'inactivity-window',
        minDurationMs: 5_400_000,
        inactivityMs: 3_600_000,
        behaviors: ['suppress-prompts'],
      },
    },
    auditLog: [],
  };
}

class FakeChromeStorageArea implements ChromeStorageAreaLike {
  readonly data: Record<string, unknown> = {};

  get(
    keys?: string | string[] | Record<string, unknown> | null,
    callback?: (items: Record<string, unknown>) => void,
  ): undefined {
    callback?.(this.itemsFor(keys));
    return undefined;
  }

  set(items: Record<string, unknown>, callback?: () => void): undefined {
    Object.assign(this.data, items);
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
