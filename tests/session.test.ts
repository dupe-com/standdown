import { describe, expect, it } from 'vitest';
import {
  type Behavior,
  MemoryStateStore,
  type StanddownPolicy,
  StanddownSession,
  type StanddownState,
  type StateStore,
  validatePolicy,
} from '../src';
import { cjPolicy } from '../src/policies';

const behaviors = [
  'suppress-prompts',
  'no-cookie-write',
  'no-redirect',
  'no-background-tracking',
] as const satisfies readonly Behavior[];

describe('StanddownSession', () => {
  it('keeps session-or-min stand-downs active while the session store retains them', async () => {
    const session = new StanddownSession(new MemoryStateStore());

    const decision = await session.ingest(
      {
        url: 'https://merchant.example/?cjevent=abc',
        now: 0,
      },
      [cjPolicy],
    );

    expect(decision).toMatchObject({
      standDown: true,
      policyId: 'cj',
    });
    expect(decision.expiresAt).toBeUndefined();

    await expect(
      session.shouldStandDown('merchant.example', 1_799_999),
    ).resolves.toMatchObject({ standDown: true, policyId: 'cj' });

    await expect(
      session.shouldStandDown('merchant.example', 31 * 60 * 1_000),
    ).resolves.toMatchObject({ standDown: true, policyId: 'cj' });
  });

  it('does not extend session-or-min records when activity is recorded', async () => {
    const store = new MemoryStateStore();
    const session = new StanddownSession(store);

    await session.ingest(
      {
        url: 'https://merchant.example/?cjevent=abc',
        now: 0,
      },
      [cjPolicy],
    );
    await session.recordActivity(10_000);

    const state = await store.load();
    const record = state?.sessions['merchant.example'];

    expect(record).toMatchObject({
      sessionRule: 'session-or-min',
      startedAt: 0,
      lastActivityAt: 0,
    });
    expect(record?.expiresAt).toBeUndefined();
  });

  it('extends inactivity-window stand-downs when activity is recorded', async () => {
    const policy = testPolicy({
      sessionRule: 'inactivity-window',
      minDurationMs: 1_000,
      inactivityMs: 500,
    });
    const session = new StanddownSession(new MemoryStateStore());

    await session.ingest(
      {
        url: 'https://merchant.example/?test=1',
        now: 0,
      },
      [policy],
    );
    await session.recordActivity(800);

    await expect(
      session.shouldStandDown('merchant.example', 1_299),
    ).resolves.toMatchObject({ standDown: true, expiresAt: 1_300 });

    await expect(
      session.shouldStandDown('merchant.example', 1_300),
    ).resolves.toMatchObject({ standDown: false });
  });

  it('preserves startedAt and keeps longer inactivity expiry on re-detection', async () => {
    const policy = testPolicy({
      sessionRule: 'inactivity-window',
      minDurationMs: 1_000,
      inactivityMs: 500,
    });
    const session = new StanddownSession(new MemoryStateStore());

    await session.ingest(
      {
        url: 'https://merchant.example/?test=1',
        now: 0,
      },
      [policy],
    );
    await session.recordActivity(900);

    const decision = await session.ingest(
      {
        url: 'https://merchant.example/?test=1',
        now: 950,
      },
      [policy],
    );

    expect(decision).toMatchObject({
      standDown: true,
      expiresAt: 1_450,
    });
  });

  it('unions behaviors across matching policies so added overlaps cannot downgrade', async () => {
    const weakOverlap = clonePolicy(cjPolicy);
    weakOverlap.id = 'new-cj-overlap';
    weakOverlap.network = { id: 'new-cj-overlap', name: 'New CJ Overlap' };
    weakOverlap.standdown = {
      ...weakOverlap.standdown,
      behaviors: ['suppress-prompts'],
    };
    const session = new StanddownSession(new MemoryStateStore());

    const decision = await session.ingest(
      {
        url: 'https://merchant.example/?cjevent=abc',
        now: 0,
      },
      [weakOverlap, cjPolicy],
    );

    expect(decision).toMatchObject({
      standDown: true,
      policyId: 'new-cj-overlap',
    });
    expect(decision.behaviors).toEqual(behaviors);
  });

  it('fails closed when the store cannot load', async () => {
    const session = new StanddownSession(new FailingLoadStore());

    await expect(
      session.shouldStandDown('merchant.example', 0),
    ).resolves.toMatchObject({
      standDown: true,
      reason: 'store-error',
    });
  });

  it('fails closed when the store cannot save', async () => {
    const session = new StanddownSession(new FailingSaveStore());

    await expect(
      session.ingest(
        {
          url: 'https://merchant.example/?cjevent=abc',
          now: 0,
        },
        [cjPolicy],
      ),
    ).resolves.toMatchObject({
      standDown: true,
      reason: 'store-error',
    });
  });

  it('fails closed on malformed policies', async () => {
    const malformed = { ...cjPolicy, schemaVersion: 99 };
    const session = new StanddownSession(new MemoryStateStore());

    await expect(
      session.ingest(
        {
          url: 'https://merchant.example/?cjevent=abc',
          now: 0,
        },
        [malformed as unknown as StanddownPolicy],
      ),
    ).resolves.toMatchObject({
      standDown: true,
    });
  });

  it('audits both stand-down and no-stand-down decisions by default', async () => {
    const session = new StanddownSession(new MemoryStateStore());

    await session.ingest(
      {
        url: 'https://merchant.example/?cjevent=abc',
        now: 0,
      },
      [cjPolicy],
    );
    await session.shouldStandDown('other.example', 10);

    const auditLog = await session.exportAuditLog();

    expect(auditLog).toHaveLength(2);
    expect(auditLog[0]?.decision?.standDown).toBe(true);
    expect(auditLog[1]?.decision?.standDown).toBe(false);
  });

  it('does not persist read-only shouldStandDown queries', async () => {
    const store = new CountingStore({
      sessions: {
        'merchant.example': {
          advertiserHost: 'merchant.example',
          policyId: 'cj',
          startedAt: 0,
          lastActivityAt: 0,
          sessionRule: 'session-or-min',
          minDurationMs: 1_800_000,
          behaviors: [...behaviors],
        },
      },
      auditLog: [],
    });
    const session = new StanddownSession(store);

    await expect(
      session.shouldStandDown('merchant.example', 1_000),
    ).resolves.toMatchObject({
      standDown: true,
      policyId: 'cj',
    });

    expect(store.saveCount).toBe(0);
  });

  it('caps persisted audit logs with a configurable ring buffer', async () => {
    const session = new StanddownSession(new MemoryStateStore(), {
      maxAuditEntries: 2,
    });

    await session.ingest(
      {
        url: 'https://merchant.example/?cjevent=one',
        now: 1,
      },
      [cjPolicy],
    );
    await session.ingest(
      {
        url: 'https://merchant.example/?cjevent=two',
        now: 2,
      },
      [cjPolicy],
    );
    await session.ingest(
      {
        url: 'https://merchant.example/?cjevent=three',
        now: 3,
      },
      [cjPolicy],
    );

    const auditLog = await session.exportAuditLog();

    expect(auditLog).toHaveLength(2);
    expect(auditLog.map((entry) => entry.time)).toEqual([2, 3]);
  });

  it('can opt out of audit logging', async () => {
    const session = new StanddownSession(new MemoryStateStore(), {
      auditLog: false,
    });

    await session.ingest(
      {
        url: 'https://merchant.example/?cjevent=abc',
        now: 0,
      },
      [cjPolicy],
    );

    await expect(session.exportAuditLog()).resolves.toHaveLength(0);
  });

  it('audits fail-closed decisions when possible', async () => {
    const session = new StanddownSession(new MemoryStateStore());

    await expect(
      session.ingest(
        {
          url: 'not a url',
          now: 0,
        },
        [cjPolicy],
      ),
    ).resolves.toMatchObject({
      standDown: true,
      reason: 'invalid-url',
    });

    const auditLog = await session.exportAuditLog();

    expect(auditLog).toHaveLength(1);
    expect(auditLog[0]?.decision).toMatchObject({
      standDown: true,
      reason: 'invalid-url',
    });
  });

  it('reports self-exemption when no active session remains', async () => {
    const session = new StanddownSession(new MemoryStateStore());

    await expect(
      session.ingest(
        {
          url: 'https://merchant.example/?cjevent=own',
          now: 0,
          selfPatterns: [{ name: 'cjevent', policyId: 'cj' }],
        },
        [cjPolicy],
      ),
    ).resolves.toMatchObject({
      standDown: false,
      reason: 'self-exempted-no-active-standdown',
    });
  });

  it('bounds a session self-exemption by the default TTL', async () => {
    const selfPatterns = [
      { name: 'cjevent', value: 'own', match: 'equals' as const, policyId: 'cj' },
    ];
    const session = new StanddownSession(new MemoryStateStore(), {
      selfExemptionScope: 'session',
    });

    // Our own click: self-exempted, and it records the host exemption.
    await expect(
      session.ingest(
        { url: 'https://merchant.example/?cjevent=own', now: 0, selfPatterns },
        [cjPolicy],
      ),
    ).resolves.toMatchObject({ standDown: false });

    // The lingering CJ cookie (an ambient signal, re-attributed to us) inside the
    // 30-minute window: the live exemption still suppresses it.
    await expect(
      session.ingest(
        {
          url: 'https://merchant.example/checkout',
          now: 60_000,
          cookieNames: ['cjevent_dc'],
        },
        [cjPolicy],
      ),
    ).resolves.toMatchObject({ standDown: false });

    // Past the TTL the exemption has lapsed, so the same lingering cookie now
    // drives a stand-down.
    await expect(
      session.ingest(
        {
          url: 'https://merchant.example/checkout',
          now: 1_800_001,
          cookieNames: ['cjevent_dc'],
        },
        [cjPolicy],
      ),
    ).resolves.toMatchObject({ standDown: true, policyId: 'cj' });
  });

  it('holds a session self-exemption for the state lifetime when TTL is disabled', async () => {
    const selfPatterns = [
      { name: 'cjevent', value: 'own', match: 'equals' as const, policyId: 'cj' },
    ];
    const session = new StanddownSession(new MemoryStateStore(), {
      selfExemptionScope: 'session',
      sessionExemptionTtlMs: 0,
    });

    await session.ingest(
      { url: 'https://merchant.example/?cjevent=own', now: 0, selfPatterns },
      [cjPolicy],
    );

    // Well past any default window, the exemption still re-attributes the
    // lingering cookie to us.
    await expect(
      session.ingest(
        {
          url: 'https://merchant.example/checkout',
          now: 10 * 60 * 60 * 1_000,
          cookieNames: ['cjevent_dc'],
        },
        [cjPolicy],
      ),
    ).resolves.toMatchObject({ standDown: false });
  });

  it('validates the test policy fixture', () => {
    expect(() =>
      validatePolicy(
        testPolicy({
          sessionRule: 'session-or-min',
          minDurationMs: 1_000,
        }),
      ),
    ).not.toThrow();
  });

  it('stands down through ingest on a disabled host with no attribution params', async () => {
    const disableHostPolicy = {
      id: 'test-disable',
      schemaVersion: 3,
      policyVersion: '0.0.0',
      network: { id: 'test-net', name: 'Test Network' },
      detection: {
        disableHosts: [{ pattern: 'ebay.com', kind: 'suffix' }],
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

    const session = new StanddownSession(new MemoryStateStore());
    const decision = await session.ingest(
      { url: 'https://www.ebay.com/itm/123', now: 0 },
      [disableHostPolicy],
    );

    expect(decision).toMatchObject({ standDown: true, policyId: 'test-disable' });
  });

  it('marks a partial-coverage non-stand-down as degraded', async () => {
    const session = new StanddownSession(new MemoryStateStore());
    const decision = await session.ingest(
      {
        url: 'https://merchant.example/products/1',
        now: 0,
        signalCoverage: 'partial',
      },
      [cjPolicy],
    );

    expect(decision.standDown).toBe(false);
    expect(decision.degraded).toBe(true);
  });

  it('does not mark degraded when coverage is full', async () => {
    const session = new StanddownSession(new MemoryStateStore());
    const decision = await session.ingest(
      { url: 'https://merchant.example/products/1', now: 0 },
      [cjPolicy],
    );

    expect(decision.standDown).toBe(false);
    expect(decision.degraded).toBeUndefined();
  });

  it('does not mark degraded on a stand-down even under partial coverage', async () => {
    const session = new StanddownSession(new MemoryStateStore());
    const decision = await session.ingest(
      {
        url: 'https://merchant.example/?cjevent=abc',
        now: 0,
        signalCoverage: 'partial',
      },
      [cjPolicy],
    );

    expect(decision.standDown).toBe(true);
    expect(decision.degraded).toBeUndefined();
  });

  it('serializes concurrent ingests so neither loses the other write', async () => {
    // A store that yields on every load/save, forcing two overlapping
    // evaluations to interleave. Without the session's serialization both would
    // load the same pre-write snapshot and the second save would clobber the
    // first, dropping one host's stand-down record.
    const store = new DelayingStore();
    const session = new StanddownSession(store);

    const [a, b] = await Promise.all([
      session.ingest(
        { url: 'https://merchant-a.example/?cjevent=aaa', now: 0 },
        [cjPolicy],
      ),
      session.ingest(
        { url: 'https://merchant-b.example/?cjevent=bbb', now: 0 },
        [cjPolicy],
      ),
    ]);

    expect(a).toMatchObject({ standDown: true, policyId: 'cj' });
    expect(b).toMatchObject({ standDown: true, policyId: 'cj' });

    const state = await store.load();
    expect(state?.sessions['merchant-a.example']).toBeDefined();
    expect(state?.sessions['merchant-b.example']).toBeDefined();
  });
});

class FailingLoadStore implements StateStore {
  async load(): Promise<StanddownState | undefined> {
    throw new Error('load failed');
  }

  async save(_state: StanddownState): Promise<void> {
    throw new Error('save should not be called');
  }
}

class FailingSaveStore implements StateStore {
  async load(): Promise<StanddownState | undefined> {
    return undefined;
  }

  async save(_state: StanddownState): Promise<void> {
    throw new Error('save failed');
  }
}

class DelayingStore implements StateStore {
  readonly #inner: MemoryStateStore;

  constructor(initialState?: StanddownState) {
    this.#inner = new MemoryStateStore(initialState);
  }

  async load(): Promise<StanddownState | undefined> {
    await Promise.resolve();
    return this.#inner.load();
  }

  async save(state: StanddownState): Promise<void> {
    await Promise.resolve();
    return this.#inner.save(state);
  }
}

class CountingStore implements StateStore {
  readonly #inner: MemoryStateStore;
  saveCount = 0;

  constructor(initialState: StanddownState) {
    this.#inner = new MemoryStateStore(initialState);
  }

  async load(): Promise<StanddownState | undefined> {
    return this.#inner.load();
  }

  async save(state: StanddownState): Promise<void> {
    this.saveCount += 1;
    await this.#inner.save(state);
  }
}

function testPolicy(standdown: {
  sessionRule: StanddownPolicy['standdown']['sessionRule'];
  minDurationMs: number;
  inactivityMs?: number;
}): StanddownPolicy {
  const policy: StanddownPolicy = {
    id: 'test',
    schemaVersion: 3,
    policyVersion: '0.0.0-test',
    network: { id: 'test', name: 'Test Network' },
    detection: {
      landingParams: [{ anyOf: [{ allOf: [{ name: 'test' }] }] }],
    },
    standdown: {
      scope: 'advertiser',
      sessionRule: standdown.sessionRule,
      minDurationMs: standdown.minDurationMs,
      behaviors,
    },
    activation: { mode: 'user-click' },
    metadata: {
      sourceUrl: 'https://example.com/policy',
      lastVerified: '2026-07-10',
    },
  };

  if (standdown.inactivityMs !== undefined) {
    policy.standdown.inactivityMs = standdown.inactivityMs;
  }

  return policy;
}

function clonePolicy(policy: StanddownPolicy): StanddownPolicy {
  return JSON.parse(JSON.stringify(policy)) as StanddownPolicy;
}
