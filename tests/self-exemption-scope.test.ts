import { describe, expect, it } from 'vitest';
import {
  type Behavior,
  MemoryStateStore,
  type StanddownPolicy,
  StanddownSession,
} from '../src';

const behaviors = [
  'suppress-prompts',
  'no-cookie-write',
  'no-redirect',
  'no-background-tracking',
] as const satisfies readonly Behavior[];

/**
 * A minimal network policy whose own attribution is a landing param and whose
 * lingering attribution is a first-party cookie name — enough to exercise the
 * "param seen once, cookie seen later" flow that `selfExemptionScope` governs.
 */
function netPolicy(
  networkId: string,
  param: string,
  cookieName: string,
): StanddownPolicy {
  return {
    id: networkId,
    schemaVersion: 3,
    policyVersion: '0.0.0-test',
    network: { id: networkId, name: `${networkId} network` },
    detection: {
      landingParams: [{ anyOf: [{ allOf: [{ name: param }] }] }],
      cookiePatterns: [{ name: cookieName, match: 'exact' }],
    },
    standdown: {
      scope: 'advertiser',
      sessionRule: 'session-or-min',
      minDurationMs: 0,
      behaviors,
    },
    activation: { mode: 'user-click' },
    metadata: {
      sourceUrl: 'https://example.com/policy',
      lastVerified: '2026-07-11',
    },
  } as const satisfies StanddownPolicy;
}

const MERCHANT = 'https://merchant.example';
const alfa = netPolicy('alfa', 'alfa_click', 'alfa_cookie');
const beta = netPolicy('beta', 'beta_click', 'beta_cookie');

describe('selfExemptionScope', () => {
  it("policy scope (default): a later param-less navigation still stands down on the network's own cookie", async () => {
    const session = new StanddownSession(new MemoryStateStore());
    const selfPatterns = [{ name: 'alfa_click', networkId: 'alfa' }];

    // T1: our own click param present → exempt, no stand-down.
    await expect(
      session.ingest(
        { url: `${MERCHANT}/p?alfa_click=1`, now: 0, selfPatterns },
        [alfa],
      ),
    ).resolves.toMatchObject({ standDown: false });

    // T2: param gone, but the network cookie lingers. Under policy scope the
    // exemption is forgotten, so the cookie now drives a stand-down.
    await expect(
      session.ingest(
        { url: `${MERCHANT}/checkout`, now: 1_000, cookieNames: ['alfa_cookie'] },
        [alfa],
      ),
    ).resolves.toMatchObject({ standDown: true, policyId: 'alfa' });
  });

  it('session scope: the exemption persists so the same-network cookie no longer stands down', async () => {
    const store = new MemoryStateStore();
    const session = new StanddownSession(store, {
      selfExemptionScope: 'session',
    });
    const selfPatterns = [{ name: 'alfa_click', networkId: 'alfa' }];

    await expect(
      session.ingest(
        { url: `${MERCHANT}/p?alfa_click=1`, now: 0, selfPatterns },
        [alfa],
      ),
    ).resolves.toMatchObject({ standDown: false });

    // The exemption is recorded for the host, scoped to the alfa network.
    const state = await store.load();
    expect(state?.exemptions?.['merchant.example']).toMatchObject({
      advertiserHost: 'merchant.example',
      networkIds: ['alfa'],
    });

    // T2: cookie lingers but is re-attributed to us → no stand-down.
    await expect(
      session.ingest(
        { url: `${MERCHANT}/checkout`, now: 1_000, cookieNames: ['alfa_cookie'] },
        [alfa],
      ),
    ).resolves.toMatchObject({
      standDown: false,
      reason: 'self-exempted-session',
    });
  });

  it('session scope: a different network still stands down (network-precise, not host-blanket)', async () => {
    const session = new StanddownSession(new MemoryStateStore(), {
      selfExemptionScope: 'session',
    });
    const selfPatterns = [{ name: 'alfa_click', networkId: 'alfa' }];

    await session.ingest(
      { url: `${MERCHANT}/p?alfa_click=1`, now: 0, selfPatterns },
      [alfa, beta],
    );

    // A competitor network's cookie appears on the same host → still stands down.
    await expect(
      session.ingest(
        { url: `${MERCHANT}/checkout`, now: 1_000, cookieNames: ['beta_cookie'] },
        [alfa, beta],
      ),
    ).resolves.toMatchObject({ standDown: true, policyId: 'beta' });
  });

  it('session scope never lifts an already-active stand-down (monotone)', async () => {
    const store = new MemoryStateStore();
    const session = new StanddownSession(store, {
      selfExemptionScope: 'session',
    });
    const selfPatterns = [{ name: 'alfa_click', networkId: 'alfa' }];

    // A real competitor stand-down forms first.
    await expect(
      session.ingest(
        { url: `${MERCHANT}/checkout`, now: 0, cookieNames: ['alfa_cookie'] },
        [alfa],
      ),
    ).resolves.toMatchObject({ standDown: true, policyId: 'alfa' });

    // Our own param arrives afterward: it must not clear the active stand-down,
    // and no exemption is recorded while a stand-down is active.
    await expect(
      session.ingest(
        { url: `${MERCHANT}/p?alfa_click=1`, now: 1_000, selfPatterns },
        [alfa],
      ),
    ).resolves.toMatchObject({ standDown: true });

    const state = await store.load();
    expect(state?.exemptions?.['merchant.example']).toBeUndefined();
  });

  it('session scope: a disabled host stands down despite a session exemption', async () => {
    const disablePolicy: StanddownPolicy = {
      ...netPolicy('alfa', 'alfa_click', 'alfa_cookie'),
      detection: {
        ...netPolicy('alfa', 'alfa_click', 'alfa_cookie').detection,
        disableHosts: [{ pattern: 'merchant.example', kind: 'suffix' }],
      },
    };
    const session = new StanddownSession(new MemoryStateStore(), {
      selfExemptionScope: 'session',
    });
    const selfPatterns = [{ name: 'alfa_click', networkId: 'alfa' }];

    // Even with our own param, a disabled host stands down unconditionally, so
    // no exemption is recorded (the host was never clean).
    await expect(
      session.ingest(
        { url: `${MERCHANT}/p?alfa_click=1`, now: 0, selfPatterns },
        [disablePolicy],
      ),
    ).resolves.toMatchObject({ standDown: true, policyId: 'alfa' });

    await expect(
      session.ingest(
        { url: `${MERCHANT}/checkout`, now: 1_000, cookieNames: ['alfa_cookie'] },
        [disablePolicy],
      ),
    ).resolves.toMatchObject({ standDown: true, policyId: 'alfa' });
  });

  it('session scope is inert without selfPatterns (unchanged default behavior)', async () => {
    const session = new StanddownSession(new MemoryStateStore(), {
      selfExemptionScope: 'session',
    });

    await expect(
      session.ingest(
        { url: `${MERCHANT}/checkout`, now: 0, cookieNames: ['alfa_cookie'] },
        [alfa],
      ),
    ).resolves.toMatchObject({ standDown: true, policyId: 'alfa' });
  });
});
