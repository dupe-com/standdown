import { describe, expect, it } from 'vitest';
import type { Behavior, StanddownPolicy } from '../src';
import { cjPolicy } from '../src/policies';
import { collectUrlSignals, createUrlStanddown } from '../src/url';

const behaviors = [
  'suppress-prompts',
  'no-cookie-write',
  'no-redirect',
  'no-background-tracking',
] as const satisfies readonly Behavior[];

const MERCHANT = 'https://merchant.example';

/** A network whose own attribution is a landing param. */
function netPolicy(networkId: string, param: string): StanddownPolicy {
  return {
    id: networkId,
    schemaVersion: 3,
    policyVersion: '0.0.0-test',
    network: { id: networkId, name: `${networkId} network` },
    detection: {
      landingParams: [{ anyOf: [{ allOf: [{ name: param }] }] }],
    },
    standdown: {
      scope: 'advertiser',
      sessionRule: 'session-or-min',
      minDurationMs: 10_000,
      behaviors,
    },
    activation: { mode: 'user-click' },
    metadata: {
      sourceUrl: 'https://example.com/policy',
      lastVerified: '2026-07-11',
    },
  } as const satisfies StanddownPolicy;
}

/** A network that never operates on a host (disableHosts). */
function disabledHostPolicy(host: string): StanddownPolicy {
  return {
    id: 'disabled',
    schemaVersion: 3,
    policyVersion: '0.0.0-test',
    network: { id: 'disabled', name: 'disabled network' },
    detection: {
      disableHosts: [{ pattern: host, kind: 'suffix' }],
    },
    standdown: {
      scope: 'advertiser',
      sessionRule: 'session-or-min',
      minDurationMs: 10_000,
      behaviors,
    },
    activation: { mode: 'never' },
    metadata: {
      sourceUrl: 'https://example.com/policy',
      lastVerified: '2026-07-11',
    },
  } as const satisfies StanddownPolicy;
}

describe('collectUrlSignals', () => {
  it('reports partial coverage (no redirect-chain or cookie plane)', () => {
    const signals = collectUrlSignals(`${MERCHANT}/p`, { now: () => 1_000 });
    expect(signals).toMatchObject({
      url: `${MERCHANT}/p`,
      now: 1_000,
      signalCoverage: 'partial',
    });
    expect(signals.cookieNames).toBeUndefined();
    expect(signals.redirectChain).toBeUndefined();
  });

  it('threads referrer and initiator only when non-empty', () => {
    const signals = collectUrlSignals(`${MERCHANT}/p`, {
      referrer: 'https://publisher.example',
      initiator: '',
      now: () => 1_000,
    });
    expect(signals.referrer).toBe('https://publisher.example');
    expect(signals.initiator).toBeUndefined();
  });

  it('throws on a missing or non-string url', () => {
    expect(() => collectUrlSignals('')).toThrow();
    // @ts-expect-error exercising a JS caller passing a non-string
    expect(() => collectUrlSignals(undefined)).toThrow();
  });
});

describe('url adapter', () => {
  it('stands down on a landing-param match from the URL alone', async () => {
    const controller = createUrlStanddown({
      policies: [cjPolicy],
      now: () => 1_000,
    });

    await expect(
      controller.decideForUrl(`${MERCHANT}/p?cjevent=abc`),
    ).resolves.toMatchObject({ standDown: true, policyId: 'cj' });
  });

  it('marks a non-stand-down as degraded (partial coverage)', async () => {
    const controller = createUrlStanddown({
      policies: [cjPolicy],
      now: () => 1_000,
    });

    await expect(controller.decideForUrl(`${MERCHANT}/p`)).resolves.toMatchObject({
      standDown: false,
      degraded: true,
    });
  });

  it('stands down unconditionally on a disableHosts match', async () => {
    const controller = createUrlStanddown({
      policies: [disabledHostPolicy('merchant.example')],
      now: () => 1_000,
    });

    await expect(controller.decideForUrl(`${MERCHANT}/p`)).resolves.toMatchObject({
      standDown: true,
      policyId: 'disabled',
    });
  });

  it('suppresses stand-down when a self-exemption param matches', async () => {
    const alfa = netPolicy('alfa', 'alfa_click');
    const controller = createUrlStanddown({
      policies: [alfa],
      selfPatterns: [{ name: 'alfa_click', networkId: 'alfa' }],
      now: () => 1_000,
    });

    await expect(
      controller.decideForUrl(`${MERCHANT}/p?alfa_click=1`),
    ).resolves.toMatchObject({ standDown: false });
  });

  it('persists an active stand-down across a later param-less decision', async () => {
    let now = 1_000;
    const controller = createUrlStanddown({
      policies: [netPolicy('alfa', 'alfa_click')],
      now: () => now,
    });

    await expect(
      controller.decideForUrl(`${MERCHANT}/p?alfa_click=1`),
    ).resolves.toMatchObject({ standDown: true, policyId: 'alfa' });

    now = 2_000;
    await expect(
      controller.decideForUrl(`${MERCHANT}/checkout`),
    ).resolves.toMatchObject({ standDown: true, policyId: 'alfa' });
  });

  it('classifies a publisher referrer as own-site', async () => {
    const decisions: { referrerClass?: string }[] = [];
    const controller = createUrlStanddown({
      policies: [cjPolicy],
      publisherSites: ['publisher.example'],
      now: () => 1_000,
      onDecision: (decision) => decisions.push(decision),
    });

    await controller.decideForUrl(`${MERCHANT}/p`, {
      referrer: 'https://publisher.example/deals',
    });
    expect(decisions.at(-1)?.referrerClass).toBe('own-site');
  });

  it('fails toward standing down on a missing URL', async () => {
    const controller = createUrlStanddown({
      policies: [cjPolicy],
      now: () => 1_000,
    });

    await expect(controller.decideForUrl('')).resolves.toMatchObject({
      standDown: true,
      reason: 'signal-collection-error',
      behaviors,
    });
  });

  it('fails toward standing down on a malformed URL', async () => {
    const controller = createUrlStanddown({
      policies: [cjPolicy],
      now: () => 1_000,
    });

    await expect(
      controller.decideForUrl('not a url'),
    ).resolves.toMatchObject({ standDown: true });
  });
});
