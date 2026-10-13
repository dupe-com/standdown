import { describe, expect, it } from 'vitest';
import { pickSessionOptions } from '../src/session';

describe('pickSessionOptions', () => {
  it('passes every adapter-facing session option through, and nothing else', () => {
    const sessionKey = (url: string) => new URL(url).hostname;
    expect(
      pickSessionOptions({
        auditLog: false,
        selfExemptionScope: 'session',
        sessionExemptionTtlMs: 5,
        sessionKey,
        selfClickLift: 'same-network',
        // adapter-only options are not session options:
        ...({ policies: [], storage: 'session' } as object),
      }),
    ).toEqual({
      auditLog: false,
      selfExemptionScope: 'session',
      sessionExemptionTtlMs: 5,
      sessionKey,
      selfClickLift: 'same-network',
    });
  });

  it('returns undefined when no session option is set', () => {
    expect(pickSessionOptions({})).toBeUndefined();
  });
});
