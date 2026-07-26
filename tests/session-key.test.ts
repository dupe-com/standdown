import { describe, expect, it } from 'vitest';
import {
  type Behavior,
  MemoryStateStore,
  type Signals,
  type StanddownPolicy,
  StanddownSession,
} from '../src';

const behaviors = [
  'suppress-prompts',
  'no-cookie-write',
  'no-redirect',
  'no-background-tracking',
] as const satisfies readonly Behavior[];

const netPolicy: StanddownPolicy = {
  id: 'alfa',
  schemaVersion: 3,
  policyVersion: '0.0.0-test',
  network: { id: 'alfa', name: 'alfa network' },
  detection: {
    landingParams: [{ anyOf: [{ allOf: [{ name: 'alfa_click' }] }] }],
    cookiePatterns: [{ name: 'alfa_cookie', match: 'exact' }],
  },
  standdown: {
    scope: 'advertiser',
    sessionRule: 'session-or-min',
    minDurationMs: 1_800_000,
    behaviors,
  },
  activation: { mode: 'user-click' },
  metadata: {
    sourceUrl: 'https://example.com/policy',
    lastVerified: '2026-07-11',
  },
} as const satisfies StanddownPolicy;

/** Collapses a merchant's www/checkout hosts onto one advertiser key. */
function merchantKey(url: string): string | undefined {
  const host = new URL(url).hostname.toLowerCase();
  return host.endsWith('merchant.example') ? 'merchant.example' : host;
}

/** The same key, returned un-normalized: mixed case and a trailing dot. */
function messyMerchantKey(url: string): string | undefined {
  const host = new URL(url).hostname.toLowerCase();
  return host.endsWith('merchant.example') ? 'Merchant.Example.' : host;
}

describe('sessionKey', () => {
  it('defaults to the landing hostname, keeping hosts isolated', async () => {
    const session = new StanddownSession(new MemoryStateStore());

    await expect(
      session.ingest(
        { url: 'https://www.merchant.example/p?alfa_click=1', now: 0 },
        [netPolicy],
      ),
    ).resolves.toMatchObject({ standDown: true, policyId: 'alfa' });

    // Without a resolver the checkout host is a different bucket.
    await expect(
      session.shouldStandDown('checkout.merchant.example', 1_000),
    ).resolves.toMatchObject({ standDown: false });
  });

  it('shares a stand-down session across hosts that resolve to one key', async () => {
    const session = new StanddownSession(new MemoryStateStore(), {
      sessionKey: merchantKey,
    });

    await expect(
      session.ingest(
        { url: 'https://www.merchant.example/p?alfa_click=1', now: 0 },
        [netPolicy],
      ),
    ).resolves.toMatchObject({ standDown: true, policyId: 'alfa' });

    // The checkout host now reads the same bucket.
    await expect(
      session.ingest({ url: 'https://checkout.merchant.example/pay', now: 1_000 }, [
        netPolicy,
      ]),
    ).resolves.toMatchObject({ standDown: true, policyId: 'alfa' });
  });

  it('shares a session self-exemption across hosts that resolve to one key', async () => {
    const session = new StanddownSession(new MemoryStateStore(), {
      sessionKey: merchantKey,
      selfExemptionScope: 'session',
    });
    const selfPatterns = [
      { name: 'alfa_click', value: 'me', match: 'equals' as const, networkId: 'alfa' },
    ];

    await expect(
      session.ingest(
        { url: 'https://www.merchant.example/p?alfa_click=me', now: 0, selfPatterns },
        [netPolicy],
      ),
    ).resolves.toMatchObject({ standDown: false });

    // The exemption follows the merchant, so the lingering cookie on the checkout
    // host is still attributed to us rather than standing us down.
    await expect(
      session.ingest(
        {
          url: 'https://checkout.merchant.example/pay',
          now: 1_000,
          cookieNames: ['alfa_cookie'],
        },
        [netPolicy],
      ),
    ).resolves.toMatchObject({ standDown: false, reason: 'self-exempted-session' });
  });

  it('normalizes the resolved key so exemptions are written and read under one bucket', async () => {
    const store = new MemoryStateStore();
    const session = new StanddownSession(store, {
      sessionKey: messyMerchantKey,
      selfExemptionScope: 'session',
    });
    const selfPatterns = [
      { name: 'alfa_click', value: 'me', match: 'equals' as const, networkId: 'alfa' },
    ];

    await expect(
      session.ingest(
        { url: 'https://www.merchant.example/p?alfa_click=me', now: 0, selfPatterns },
        [netPolicy],
      ),
    ).resolves.toMatchObject({ standDown: false });

    // The exemption is filed under the normalized key and read back under the
    // same one — an un-normalized key would stand us down against our own
    // lingering cookie on the checkout host.
    await expect(
      session.ingest(
        {
          url: 'https://checkout.merchant.example/pay',
          now: 1_000,
          cookieNames: ['alfa_cookie'],
        },
        [netPolicy],
      ),
    ).resolves.toMatchObject({ standDown: false, reason: 'self-exempted-session' });

    const state = await store.load();
    expect(Object.keys(state?.exemptions ?? {})).toEqual(['merchant.example']);
    // Like SessionRecord, the exemption record keeps the real landing host.
    expect(state?.exemptions?.['merchant.example']?.advertiserHost).toBe(
      'www.merchant.example',
    );
  });

  it('fails closed when the resolver throws', async () => {
    const session = new StanddownSession(new MemoryStateStore(), {
      sessionKey: () => {
        throw new Error('resolver exploded');
      },
    });

    const decision = await session.ingest(
      { url: 'https://www.merchant.example/p?alfa_click=1', now: 0 },
      [netPolicy],
    );

    expect(decision).toMatchObject({
      standDown: true,
      reason: 'session-key-error: resolver exploded',
    });
    expect(decision.behaviors).toEqual(behaviors);

    const audit = await session.exportAuditLog();
    expect(audit[0]).toMatchObject({
      action: 'ingest',
      advertiserHost: 'www.merchant.example',
    });
  });

  it('fails closed when a URL-parsing resolver meets a malformed URL', async () => {
    // merchantKey calls new URL(), which throws here — ingest must still settle
    // on a decision rather than reject.
    const session = new StanddownSession(new MemoryStateStore(), {
      sessionKey: merchantKey,
    });

    await expect(
      session.ingest({ url: 'not a url', now: 0 }, [netPolicy]),
    ).resolves.toMatchObject({ standDown: true });
  });

  it('falls back to the landing hostname when the resolver returns an empty string', async () => {
    const store = new MemoryStateStore();
    const session = new StanddownSession(store, { sessionKey: () => '' });

    await expect(
      session.ingest(
        { url: 'https://www.merchant.example/p?alfa_click=1', now: 0 },
        [netPolicy],
      ),
    ).resolves.toMatchObject({ standDown: true, policyId: 'alfa' });

    // An empty key is no key: filing state under '' would make it unreadable,
    // since every read path treats '' as "no key at all".
    const state = await store.load();
    expect(Object.keys(state?.sessions ?? {})).toEqual(['www.merchant.example']);
    await expect(
      session.shouldStandDown('www.merchant.example', 1_000),
    ).resolves.toMatchObject({ standDown: true, policyId: 'alfa' });
  });

  it('resolveSessionKey returns the key ingest files state under', async () => {
    const session = new StanddownSession(new MemoryStateStore(), {
      sessionKey: messyMerchantKey,
    });
    const signals: Signals = {
      url: 'https://www.merchant.example/p?alfa_click=1',
      now: 0,
    };
    const key = session.resolveSessionKey(signals.url);

    expect(key).toBe('merchant.example');

    await expect(session.ingest(signals, [netPolicy])).resolves.toMatchObject({
      standDown: true,
      policyId: 'alfa',
    });

    // Feeding it straight back to shouldStandDown is the documented read path.
    await expect(
      session.shouldStandDown(key ?? '', 1_000),
    ).resolves.toMatchObject({ standDown: true, policyId: 'alfa' });
  });

  it('resolveSessionKey falls back to the landing host and reports unresolvable keys', async () => {
    const plain = new StanddownSession(new MemoryStateStore());

    expect(plain.resolveSessionKey('https://WWW.Merchant.Example./p')).toBe(
      'www.merchant.example',
    );
    expect(plain.resolveSessionKey('not a url')).toBeUndefined();

    const emptyKey = new StanddownSession(new MemoryStateStore(), {
      sessionKey: () => '',
    });

    expect(emptyKey.resolveSessionKey('https://www.merchant.example/p')).toBe(
      'www.merchant.example',
    );

    // A resolver that throws leaves no key to read by. ingest fails closed on
    // the same navigation, so undefined means "stand down", not "nothing filed".
    const throwing = new StanddownSession(new MemoryStateStore(), {
      sessionKey: () => {
        throw new Error('resolver exploded');
      },
    });

    expect(
      throwing.resolveSessionKey('https://www.merchant.example/p'),
    ).toBeUndefined();
  });

  it('falls back to the landing hostname when the resolver returns undefined', async () => {
    const session = new StanddownSession(new MemoryStateStore(), {
      sessionKey: () => undefined,
    });

    await expect(
      session.ingest(
        { url: 'https://www.merchant.example/p?alfa_click=1', now: 0 },
        [netPolicy],
      ),
    ).resolves.toMatchObject({ standDown: true, policyId: 'alfa' });

    await expect(
      session.shouldStandDown('www.merchant.example', 1_000),
    ).resolves.toMatchObject({ standDown: true, policyId: 'alfa' });
  });

  it('shouldStandDown reads by the resolved key, not the landing host', async () => {
    const session = new StanddownSession(new MemoryStateStore(), {
      sessionKey: merchantKey,
    });

    await expect(
      session.ingest(
        { url: 'https://www.merchant.example/p?alfa_click=1', now: 0 },
        [netPolicy],
      ),
    ).resolves.toMatchObject({ standDown: true, policyId: 'alfa' });

    // ingest filed state under the resolved key, so a lookup by that key finds it.
    await expect(
      session.shouldStandDown('merchant.example', 1_000),
    ).resolves.toMatchObject({ standDown: true, policyId: 'alfa' });

    // shouldStandDown does not run the resolver, so the raw landing host it was
    // actually detected on misses the bucket entirely — this is the documented
    // contract: callers that configure sessionKey pass it
    // resolveSessionKey(url), not the landing hostname.
    await expect(
      session.shouldStandDown('www.merchant.example', 1_000),
    ).resolves.toMatchObject({ standDown: false, reason: 'no-active-standdown' });
  });

  it('files state under the resolved key while SessionRecord.advertiserHost keeps the real landing host', async () => {
    const store = new MemoryStateStore();
    const session = new StanddownSession(store, {
      sessionKey: merchantKey,
    });

    await session.ingest(
      { url: 'https://www.merchant.example/p?alfa_click=1', now: 0 },
      [netPolicy],
    );

    const state = await store.load();
    expect(Object.keys(state?.sessions ?? {})).toEqual(['merchant.example']);
    expect(state?.sessions['merchant.example']?.advertiserHost).toBe(
      'www.merchant.example',
    );

    const audit = await session.exportAuditLog();
    expect(audit[0]?.advertiserHost).toBe('www.merchant.example');
  });
});
