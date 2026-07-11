import type {
  AuditEntry,
  Behavior,
  Decision,
  Detection,
  SessionRecord,
  StanddownState,
  StateStore,
} from './types';

const DEFAULT_STATE_KEY = 'standdown:state:v1';
const DEFAULT_SESSION_ID_KEY = 'standdown:session-id:v1';

export interface ChromeRuntimeLike {
  lastError?: { message?: string };
}

export interface ChromeStorageAreaLike {
  get(
    keys?: string | string[] | Record<string, unknown> | null,
    callback?: (items: Record<string, unknown>) => void,
  ): undefined | Promise<Record<string, unknown>>;
  set(
    items: Record<string, unknown>,
    callback?: () => void,
  ): undefined | Promise<void>;
  remove?(
    keys: string | string[],
    callback?: () => void,
  ): undefined | Promise<void>;
}

export interface WebStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface ChromeLocalStateStoreOptions {
  key?: string;
  identityKey?: string;
  runtime?: ChromeRuntimeLike;
  sessionStorage?: ChromeStorageAreaLike;
  sessionId?: string;
  now?: () => number;
  createSessionId?: () => string;
}

export class ChromeLocalStateStore implements StateStore {
  readonly #localStorage: ChromeStorageAreaLike;
  readonly #sessionStorage: ChromeStorageAreaLike | undefined;
  readonly #runtime: ChromeRuntimeLike | undefined;
  readonly #key: string;
  readonly #identityKey: string;
  readonly #fixedSessionId: string | undefined;
  readonly #now: () => number;
  readonly #createSessionId: () => string;
  #cachedSessionId: string | undefined;

  constructor(
    localStorage: ChromeStorageAreaLike,
    opts: ChromeLocalStateStoreOptions = {},
  ) {
    this.#localStorage = localStorage;
    this.#sessionStorage = opts.sessionStorage;
    this.#runtime = opts.runtime;
    this.#key = opts.key ?? DEFAULT_STATE_KEY;
    this.#identityKey = opts.identityKey ?? DEFAULT_SESSION_ID_KEY;
    this.#fixedSessionId = opts.sessionId;
    this.#now = opts.now ?? Date.now;
    this.#createSessionId = opts.createSessionId ?? createSessionId;
  }

  async load(): Promise<StanddownState | undefined> {
    const sessionId = await this.#currentSessionId();
    const items = await chromeGet(this.#localStorage, this.#key, this.#runtime);
    const envelope = items[this.#key];

    if (envelope === undefined) {
      return undefined;
    }

    const persisted = parsePersistedState(envelope);
    const state = cloneState(persisted.state);

    if (sessionIdentityMismatch(persisted.sessionId, sessionId)) {
      return dropSessionBoundRecords(state, this.#now());
    }

    return state;
  }

  async save(state: StanddownState): Promise<void> {
    const sessionId = await this.#currentSessionId();
    const envelope: {
      schemaVersion: 1;
      sessionId?: string;
      state: StanddownState;
    } = {
      schemaVersion: 1,
      state: cloneState(state),
    };

    if (sessionId !== undefined) {
      envelope.sessionId = sessionId;
    }

    await chromeSet(
      this.#localStorage,
      {
        [this.#key]: envelope,
      },
      this.#runtime,
    );
  }

  async #currentSessionId(): Promise<string | undefined> {
    if (this.#fixedSessionId !== undefined) {
      return this.#fixedSessionId;
    }

    if (this.#cachedSessionId !== undefined) {
      return this.#cachedSessionId;
    }

    if (this.#sessionStorage === undefined) {
      return undefined;
    }

    const items = await chromeGet(
      this.#sessionStorage,
      this.#identityKey,
      this.#runtime,
    );
    const existing = items[this.#identityKey];

    if (typeof existing === 'string' && existing.length > 0) {
      this.#cachedSessionId = existing;
      return existing;
    }

    const next = this.#createSessionId();
    await chromeSet(
      this.#sessionStorage,
      { [this.#identityKey]: next },
      this.#runtime,
    );
    this.#cachedSessionId = next;
    return next;
  }
}

export interface SessionStorageStateStoreOptions {
  key?: string;
}

export class SessionStorageStateStore implements StateStore {
  readonly #storage: WebStorageLike;
  readonly #key: string;

  constructor(storage: WebStorageLike, opts: SessionStorageStateStoreOptions = {}) {
    this.#storage = storage;
    this.#key = opts.key ?? DEFAULT_STATE_KEY;
  }

  async load(): Promise<StanddownState | undefined> {
    const raw = this.#storage.getItem(this.#key);

    if (raw === null) {
      return undefined;
    }

    return cloneState(parseState(JSON.parse(raw)));
  }

  async save(state: StanddownState): Promise<void> {
    this.#storage.setItem(this.#key, JSON.stringify(cloneState(state)));
  }
}

export interface LocalStorageTtlStateStoreOptions {
  key?: string;
  identityKey?: string;
  /**
   * Sliding envelope TTL for persisted session records. Every save refreshes
   * `savedAt`; expiry removes session state only. Audit entries remain
   * available so per-policy decisions can still be inspected. Policy-specific
   * stand-down durations remain enforced by the core state machine.
   */
  ttlMs: number;
  /**
   * Optional shared identity storage. Defaults to `localStorage` so multiple
   * tabs in the same browser session do not invalidate each other's records.
   */
  identityStorage?: WebStorageLike;
  /** @deprecated Local-TTL identity is browser-session scoped, not tab scoped. */
  sessionStorage?: WebStorageLike;
  sessionId?: string;
  now?: () => number;
  createSessionId?: () => string;
}

export class LocalStorageTtlStateStore implements StateStore {
  readonly #localStorage: WebStorageLike;
  readonly #identityStorage: WebStorageLike;
  readonly #key: string;
  readonly #identityKey: string;
  readonly #ttlMs: number;
  readonly #fixedSessionId: string | undefined;
  readonly #now: () => number;
  readonly #createSessionId: () => string;
  #cachedSessionId: string | undefined;

  constructor(
    localStorage: WebStorageLike,
    opts: LocalStorageTtlStateStoreOptions,
  ) {
    this.#localStorage = localStorage;
    this.#identityStorage = opts.identityStorage ?? localStorage;
    this.#key = opts.key ?? DEFAULT_STATE_KEY;
    this.#identityKey = opts.identityKey ?? DEFAULT_SESSION_ID_KEY;
    this.#ttlMs = opts.ttlMs;
    this.#fixedSessionId = opts.sessionId;
    this.#now = opts.now ?? Date.now;
    this.#createSessionId = opts.createSessionId ?? createSessionId;
  }

  async load(): Promise<StanddownState | undefined> {
    const sessionId = this.#currentSessionId();
    const raw = this.#localStorage.getItem(this.#key);

    if (raw === null) {
      return undefined;
    }

    const persisted = parsePersistedState(JSON.parse(raw));
    const state = cloneState(persisted.state);

    if (this.#now() - persisted.savedAt >= this.#ttlMs) {
      return {
        sessions: {},
        auditLog: state.auditLog,
      };
    }

    if (sessionIdentityMismatch(persisted.sessionId, sessionId)) {
      return dropSessionBoundRecords(state, this.#now());
    }

    return state;
  }

  async save(state: StanddownState): Promise<void> {
    const sessionId = this.#currentSessionId();
    this.#localStorage.setItem(
      this.#key,
      JSON.stringify({
        schemaVersion: 1,
        sessionId,
        savedAt: this.#now(),
        state: cloneState(state),
      }),
    );
  }

  #currentSessionId(): string {
    if (this.#fixedSessionId !== undefined) {
      return this.#fixedSessionId;
    }

    if (this.#cachedSessionId !== undefined) {
      return this.#cachedSessionId;
    }

    const existing = this.#identityStorage.getItem(this.#identityKey);

    if (existing !== null && existing.length > 0) {
      this.#cachedSessionId = existing;
      return existing;
    }

    const next = this.#createSessionId();
    this.#identityStorage.setItem(this.#identityKey, next);
    this.#cachedSessionId = next;
    return next;
  }
}

export function dropSessionBoundRecords(
  state: StanddownState,
  now: number,
): StanddownState {
  const next = cloneState(state);

  for (const [host, record] of Object.entries(next.sessions)) {
    if (
      record.sessionRule === 'session-or-min' &&
      now >= record.startedAt + record.minDurationMs
    ) {
      delete next.sessions[host];
    }
  }

  return next;
}

export function createSessionId(): string {
  const cryptoApi = globalThis.crypto as Crypto | undefined;

  if (typeof cryptoApi?.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }

  return `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function parsePersistedState(value: unknown): {
  sessionId: string | undefined;
  savedAt: number;
  state: StanddownState;
} {
  if (!isRecord(value)) {
    throw new Error('invalid persisted state');
  }

  const sessionId = value.sessionId;
  const savedAt = value.savedAt ?? 0;
  const state = value.state;

  if (
    (sessionId !== undefined && typeof sessionId !== 'string') ||
    typeof savedAt !== 'number'
  ) {
    throw new Error('invalid persisted state envelope');
  }

  return {
    sessionId,
    savedAt,
    state: parseState(state),
  };
}

function parseState(value: unknown): StanddownState {
  if (!isRecord(value) || !isRecord(value.sessions) || !Array.isArray(value.auditLog)) {
    throw new Error('invalid standdown state');
  }

  const sessions: Record<string, SessionRecord> = {};

  for (const [host, record] of Object.entries(value.sessions)) {
    sessions[host] = parseSessionRecord(record);
  }

  return {
    sessions,
    auditLog: value.auditLog.map(parseAuditEntry),
  };
}

function parseSessionRecord(value: unknown): SessionRecord {
  if (!isRecord(value)) {
    throw new Error('invalid session record');
  }

  const {
    advertiserHost,
    policyId,
    startedAt,
    lastActivityAt,
    expiresAt,
    sessionRule,
    minDurationMs,
    inactivityMs,
    behaviors,
  } = value;

  if (
    typeof advertiserHost !== 'string' ||
    typeof policyId !== 'string' ||
    typeof startedAt !== 'number' ||
    typeof lastActivityAt !== 'number' ||
    (expiresAt !== undefined && typeof expiresAt !== 'number') ||
    (sessionRule !== 'session-or-min' && sessionRule !== 'inactivity-window') ||
    typeof minDurationMs !== 'number' ||
    (inactivityMs !== undefined && typeof inactivityMs !== 'number') ||
    !Array.isArray(behaviors) ||
    !behaviors.every(isBehavior)
  ) {
    throw new Error('invalid session record');
  }

  const record: SessionRecord = {
    advertiserHost,
    policyId,
    startedAt,
    lastActivityAt,
    sessionRule,
    minDurationMs,
    behaviors,
  };

  if (expiresAt !== undefined) {
    record.expiresAt = expiresAt;
  }

  if (inactivityMs !== undefined) {
    record.inactivityMs = inactivityMs;
  }

  return record;
}

function parseAuditEntry(value: unknown): AuditEntry {
  if (!isRecord(value)) {
    throw new Error('invalid audit entry');
  }

  const { time, action, advertiserHost, detection, decision } = value;

  if (
    typeof time !== 'number' ||
    (action !== 'ingest' &&
      action !== 'shouldStandDown' &&
      action !== 'recordActivity' &&
      action !== 'refresh') ||
    (advertiserHost !== undefined && typeof advertiserHost !== 'string')
  ) {
    throw new Error('invalid audit entry');
  }

  const entry: AuditEntry = { time, action };

  if (advertiserHost !== undefined) {
    entry.advertiserHost = advertiserHost;
  }

  if (detection !== undefined) {
    entry.detection = detection as Detection;
  }

  if (decision !== undefined) {
    entry.decision = decision as Decision;
  }

  return entry;
}

function cloneState(state: StanddownState): StanddownState {
  return {
    sessions: Object.fromEntries(
      Object.entries(state.sessions).map(([host, record]) => [
        host,
        cloneSessionRecord(record),
      ]),
    ),
    auditLog: state.auditLog.map(cloneAuditEntry),
  };
}

function cloneSessionRecord(record: SessionRecord): SessionRecord {
  const next: SessionRecord = {
    advertiserHost: record.advertiserHost,
    policyId: record.policyId,
    startedAt: record.startedAt,
    lastActivityAt: record.lastActivityAt,
    sessionRule: record.sessionRule,
    minDurationMs: record.minDurationMs,
    behaviors: [...record.behaviors],
  };

  if (record.expiresAt !== undefined) {
    next.expiresAt = record.expiresAt;
  }

  if (record.inactivityMs !== undefined) {
    next.inactivityMs = record.inactivityMs;
  }

  return next;
}

function cloneAuditEntry(entry: AuditEntry): AuditEntry {
  const next: AuditEntry = {
    time: entry.time,
    action: entry.action,
  };

  if (entry.advertiserHost !== undefined) {
    next.advertiserHost = entry.advertiserHost;
  }

  if (entry.detection !== undefined) {
    next.detection = {
      matched: entry.detection.matched.map((match) => ({ ...match })),
      selfMatch: entry.detection.selfMatch,
    };

    if (entry.detection.strongest !== undefined) {
      next.detection.strongest = { ...entry.detection.strongest };
    }

    if (entry.detection.failClosedReason !== undefined) {
      next.detection.failClosedReason = entry.detection.failClosedReason;
    }
  }

  if (entry.decision !== undefined) {
    next.decision = {
      ...entry.decision,
      behaviors: [...entry.decision.behaviors],
    };
  }

  return next;
}

function chromeGet(
  storage: ChromeStorageAreaLike,
  key: string,
  runtime: ChromeRuntimeLike | undefined,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    try {
      const result = storage.get(key, (items) => {
        const error = runtime?.lastError;

        if (error !== undefined) {
          reject(new Error(error.message ?? 'chrome storage error'));
          return;
        }

        resolve(items ?? {});
      });

      if (isPromiseLike(result)) {
        result.then(resolve, reject);
      }
    } catch (error) {
      reject(error);
    }
  });
}

function chromeSet(
  storage: ChromeStorageAreaLike,
  items: Record<string, unknown>,
  runtime: ChromeRuntimeLike | undefined,
): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const result = storage.set(items, () => {
        const error = runtime?.lastError;

        if (error !== undefined) {
          reject(new Error(error.message ?? 'chrome storage error'));
          return;
        }

        resolve();
      });

      if (isPromiseLike(result)) {
        result.then(resolve, reject);
      }
    } catch (error) {
      reject(error);
    }
  });
}

function isPromiseLike<T>(value: unknown): value is Promise<T> {
  return (
    isRecord(value) &&
    typeof value.then === 'function' &&
    typeof value.catch === 'function'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function sessionIdentityMismatch(
  persistedSessionId: string | undefined,
  currentSessionId: string | undefined,
): boolean {
  return (
    persistedSessionId !== undefined &&
    currentSessionId !== undefined &&
    persistedSessionId !== currentSessionId
  );
}

function isBehavior(value: unknown): value is Behavior {
  return (
    value === 'suppress-prompts' ||
    value === 'no-cookie-write' ||
    value === 'no-redirect' ||
    value === 'no-background-tracking'
  );
}
