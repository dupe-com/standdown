import { describe, expect, it } from 'vitest';
import { guardActivation, validatePolicy } from '../src';
import { allPolicies, amazonPolicy, cjPolicy, ebayEpnPolicy, policiesFor } from '../src/policies';

const trustedClick = {
  isTrusted: true,
  type: 'click',
  timeStamp: 100,
};

const benefit = {
  kind: 'cashback',
  description: 'Activate cashback for this purchase.',
} as const;

describe('guardActivation', () => {
  it('allows trusted user-click activation with a declared benefit and no stand-down', () => {
    expect(
      guardActivation({
        decision: { standDown: false, reason: 'no-active-standdown', behaviors: [] },
        userGesture: trustedClick,
        benefit,
        policy: cjPolicy,
      }),
    ).toEqual({ allowed: true, reason: 'allowed' });
  });

  it('rejects non-trusted events', () => {
    expect(
      guardActivation({
        decision: { standDown: false, reason: 'no-active-standdown', behaviors: [] },
        userGesture: { ...trustedClick, isTrusted: false },
        benefit,
        policy: cjPolicy,
      }),
    ).toEqual({ allowed: false, reason: 'missing-trusted-user-gesture' });
  });

  it('rejects missing benefit descriptions', () => {
    expect(
      guardActivation({
        decision: { standDown: false, reason: 'no-active-standdown', behaviors: [] },
        userGesture: trustedClick,
        benefit: { kind: 'cashback', description: '   ' },
        policy: cjPolicy,
      }),
    ).toEqual({ allowed: false, reason: 'missing-user-benefit' });
  });

  it('rejects active stand-down decisions', () => {
    expect(
      guardActivation({
        decision: {
          standDown: true,
          policyId: 'cj',
          reason: 'active-standdown:cj',
          behaviors: ['suppress-prompts'],
        },
        userGesture: trustedClick,
        benefit,
        policy: cjPolicy,
      }),
    ).toEqual({ allowed: false, reason: 'active-standdown' });
  });

  it('rejects Amazon because activation mode is never', () => {
    expect(
      guardActivation({
        decision: { standDown: false, reason: 'no-active-standdown', behaviors: [] },
        userGesture: trustedClick,
        benefit,
        policy: amazonPolicy,
      }),
    ).toEqual({ allowed: false, reason: 'policy-never-activates' });
  });

  it('rejects eBay when required referrer class is missing', () => {
    expect(
      guardActivation({
        decision: {
          standDown: false,
          reason: 'no-active-standdown',
          behaviors: [],
        },
        userGesture: trustedClick,
        benefit,
        policy: ebayEpnPolicy,
      }),
    ).toEqual({ allowed: false, reason: 'missing-referrer-class' });
  });

  it('rejects eBay when referrer class is present but disallowed', () => {
    expect(
      guardActivation({
        decision: {
          standDown: false,
          reason: 'no-active-standdown',
          behaviors: [],
          referrerClass: 'advertiser-internal',
        },
        userGesture: trustedClick,
        benefit,
        policy: ebayEpnPolicy,
      }),
    ).toEqual({ allowed: false, reason: 'referrer-class-disallowed' });
  });
});

describe('policy packs', () => {
  it('validates every bundled policy and citation field', () => {
    for (const policy of allPolicies) {
      expect(() => validatePolicy(policy), policy.id).not.toThrow();
      expect(policy.metadata.sourceUrl).toMatch(/^https:\/\//);
      expect(policy.metadata.lastVerified).toBe('2026-07-10');
    }
  });

  it('selects policies by policy id or network id', () => {
    expect(policiesFor(['cj']).map((policy) => policy.id)).toEqual(['cj']);
    expect(policiesFor(['ebay-epn']).map((policy) => policy.id)).toEqual([
      'ebay-epn',
    ]);
  });

  it('rejects malformed policies', () => {
    expect(() => validatePolicy({ ...cjPolicy, schemaVersion: 2 })).toThrow(
      /schemaVersion/,
    );
  });

  it('rejects invalid matcher and domain rule shapes', () => {
    expect(() =>
      validatePolicy({
        ...cjPolicy,
        detection: {
          landingParams: [
            {
              anyOf: [{ allOf: [{ name: 'bad', match: 'contains' }] }],
            },
          ],
        },
      }),
    ).toThrow(/value is required/);

    expect(() =>
      validatePolicy({
        ...cjPolicy,
        detection: {
          redirectDomains: [{ pattern: '[', kind: 'regex' }],
        },
      }),
    ).toThrow(/valid regex/);
  });
});
