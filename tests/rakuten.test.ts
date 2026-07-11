import { describe, expect, it } from 'vitest';
import {
  fromRakutenPolicy,
  type RakutenNetworkPolicyV2,
  toRakutenPolicy,
  validatePolicy,
} from '../src';

const rakutenCjSample = {
  id: 'cj',
  schemaVersion: 2,
  policyVersion: '2026.05.01',
  network: {
    id: 'cj',
    name: 'CJ Affiliate',
    description: 'CJ sample policy from Rakuten PublisherStandown-SDK README',
    sessionDuration: 1_800_000,
  },
  rules: [
    {
      domain: 'dpbolvw.net',
      reason: 'CJ redirect domain',
    },
    {
      domain: 'anrdoezrs.net',
      reason: 'CJ redirect domain',
    },
    {
      domain: 'jdoqocy.com',
      reason: 'CJ redirect domain',
    },
    {
      params: ['cjevent'],
      reason: 'CJ click id parameter',
    },
    {
      params: { utm_source: 'cj' },
      reason: 'CJ UTM parameter',
    },
  ],
} as const satisfies RakutenNetworkPolicyV2;

describe('Rakuten NetworkPolicy v2 converters', () => {
  it('round-trips the Rakuten README CJ sample rule structure', () => {
    const native = fromRakutenPolicy(rakutenCjSample);

    expect(() => validatePolicy(native)).not.toThrow();
    expect(native).toMatchObject({
      id: 'cj',
      schemaVersion: 3,
      standdown: {
        sessionRule: 'session-or-min',
        minDurationMs: 1_800_000,
      },
      activation: { mode: 'user-click' },
    });
    expect(native.metadata.notes).toContain('Lossy mapping');

    const emitted = toRakutenPolicy(native);

    expect(emitted).toMatchObject({
      id: rakutenCjSample.id,
      schemaVersion: 2,
      policyVersion: rakutenCjSample.policyVersion,
      network: {
        id: rakutenCjSample.network.id,
        name: rakutenCjSample.network.name,
        sessionDuration: rakutenCjSample.network.sessionDuration,
      },
    });
    expect(emitted.network.description).toContain('Lossy mapping');
    expect(emitted.rules).toEqual(rakutenCjSample.rules);
  });

  it('rejects converted policies with invalid session durations', () => {
    expect(() =>
      fromRakutenPolicy({
        ...rakutenCjSample,
        network: {
          ...rakutenCjSample.network,
          sessionDuration: -1,
        },
      }),
    ).toThrow(
      'Converted Rakuten policy is invalid: policy.standdown.minDurationMs must be a non-negative finite number',
    );

    expect(() =>
      fromRakutenPolicy({
        ...rakutenCjSample,
        network: {
          ...rakutenCjSample.network,
          sessionDuration: Number.NaN,
        },
      }),
    ).toThrow(
      'Converted Rakuten policy is invalid: policy.standdown.minDurationMs must be a non-negative finite number',
    );
  });

  it('rejects converted policies with invalid regex patterns', () => {
    expect(() =>
      fromRakutenPolicy({
        ...rakutenCjSample,
        rules: [{ pattern: '[' }],
      }),
    ).toThrow(
      'Converted Rakuten policy is invalid: DomainRule.pattern must be a valid regex',
    );
  });

  it('documents lossy param rules when emitting Rakuten policies', () => {
    const native = fromRakutenPolicy(rakutenCjSample);
    native.detection.landingParams = [
      {
        anyOf: [
          { allOf: [{ name: 'first' }] },
          { allOf: [{ name: 'second' }] },
        ],
      },
      {
        anyOf: [
          {
            allOf: [{ name: 'coupon', value: 'sale', match: 'contains' }],
          },
        ],
      },
    ];

    const emitted = toRakutenPolicy(native);

    expect(emitted.rules).toEqual(rakutenCjSample.rules.slice(0, 3));
    expect(emitted.network.description).toContain('multi-group anyOf');
    expect(emitted.network.description).toContain('match:contains');
  });
});
