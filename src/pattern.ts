/**
 * Regular-expression value matching for `ParamMatcher` `match: 'pattern'`.
 *
 * Policies can arrive remotely (signed refresh bundles), so a pattern must be
 * cheap and predictable. Rather than blocking known-slow shapes, validation
 * accepts only a small subset that can't backtrack much: a sequence of single
 * characters (a literal, an escape, `.` or a `[...]` class), each with an
 * optional count, where at most ONE count can vary in length (`+`, `*`, `?`,
 * `{n,}`, `{n,m}`). Fixed counts (`{11}`) are unlimited. No groups and no `|`.
 * With one variable stretch and no alternation, the engine has at most one
 * split to try per position, so matching time grows with the value's length,
 * not exponentially. Sources must also compile, be at most
 * {@link MAX_PATTERN_LENGTH} characters, carry no flags, and be anchored with
 * `^` and `$`. Each source compiles once. Validation rejects an invalid one, so
 * sessions and adapters stand down; at match time it simply never matches (for
 * a self-exemption that errs toward standing down).
 */

export const MAX_PATTERN_LENGTH = 256;

/** Longest param value a pattern is tried against; longer values never match. */
export const MAX_PATTERN_INPUT = 512;

// Bounds memory if a remote bundle or host config ships many distinct patterns.
const MAX_CACHED_PATTERNS = 500;
const cache = new Map<string, RegExp | null>();

/** Why `source` is not an acceptable pattern, or `undefined` if it is. */
export function patternProblem(source: string): string | undefined {
  if (source.length > MAX_PATTERN_LENGTH) {
    return `is longer than ${MAX_PATTERN_LENGTH} characters`;
  }

  if (!source.startsWith('^') || !endsWithAnchor(source)) {
    return 'must be anchored with both ^ and $';
  }

  const unsupported = unsupportedSyntax(source.slice(1, -1));

  if (unsupported !== undefined) {
    return unsupported;
  }

  try {
    new RegExp(source);
  } catch {
    return 'does not compile';
  }

  return undefined;
}

/** The compiled pattern for `source`, or `undefined` if it is not acceptable. */
export function compiledPattern(source: string): RegExp | undefined {
  const cached = cache.get(source);

  if (cached !== undefined) {
    return cached ?? undefined;
  }

  const compiled = patternProblem(source) === undefined ? new RegExp(source) : null;

  if (cache.size >= MAX_CACHED_PATTERNS) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }

  cache.set(source, compiled);
  return compiled ?? undefined;
}

// Characters with a special meaning outside a class. Escape them to match literally.
const SPECIAL = new Set(['^', '$', '\\', '.', '|', '?', '*', '+', '(', ')', '[', ']', '{', '}']);
// Escapes allowed: the shorthand classes, or an escaped non-alphanumeric character.
const isSafeEscape = (c: string | undefined) =>
  c !== undefined && (/[dDwWsS]/.test(c) || !/[A-Za-z0-9_]/.test(c));

/**
 * Why `body` (the source between `^` and `$`) is outside the allowed subset, or
 * `undefined` if it fits. See the module comment for the subset.
 */
export function unsupportedSyntax(body: string): string | undefined {
  let variable = 0;
  let i = 0;

  while (i < body.length) {
    const c = body[i] as string;

    // One atom: a single character.
    if (c === '\\') {
      if (!isSafeEscape(body[i + 1])) {
        return `uses an unsupported escape \\${body[i + 1] ?? ''}`;
      }
      i += 2;
    } else if (c === '[') {
      const end = classEnd(body, i);
      if (end === undefined) {
        return 'has an unsupported character class';
      }
      i = end;
    } else if (c === '(' || c === ')' || c === '|') {
      return 'uses a group or |, which patterns do not support';
    } else if (c === '.' || !SPECIAL.has(c)) {
      i += 1;
    } else {
      return `has an unexpected ${c}`;
    }

    // Its optional count.
    const count = countAt(body, i);
    if (count === undefined) {
      return 'has an unsupported repeat count';
    }
    if (count.variable) {
      variable += 1;
      if (variable > 1) {
        return 'has more than one variable-length repeat (only one of +, *, ?, {n,m} is allowed)';
      }
    }
    i += count.length;
  }

  return undefined;
}

// End index (exclusive) of the class starting at `start`, or undefined if it's
// empty, unclosed or holds an unsafe escape. `[^]` and a leading `]` are rejected
// rather than guessed at.
function classEnd(body: string, start: number): number | undefined {
  let i = start + 1;
  if (body[i] === '^') i += 1;
  if (body[i] === ']') return undefined;

  while (i < body.length && body[i] !== ']') {
    if (body[i] === '\\') {
      if (!isSafeEscape(body[i + 1])) return undefined;
      i += 2;
    } else {
      i += 1;
    }
  }

  return i < body.length ? i + 1 : undefined;
}

// The count at `i`: its length and whether it varies. No count = length 0.
// A trailing lazy `?` is not accepted (it's never needed to match an ID shape).
function countAt(body: string, i: number): { length: number; variable: boolean } | undefined {
  const c = body[i];
  let length = 0;
  let variable = false;

  if (c === '+' || c === '*' || c === '?') {
    length = 1;
    variable = true;
  } else if (c === '{') {
    const m = /^\{(\d{1,3})(,(\d{0,3}))?\}/.exec(body.slice(i));
    if (!m) return undefined;
    const min = Number(m[1]);
    const max = m[2] === undefined ? min : m[3] === '' ? Infinity : Number(m[3]);
    if (max < min) return undefined;
    length = m[0].length;
    variable = max !== min;
  }

  const next = body[i + length];
  if (length > 0 && (next === '+' || next === '*' || next === '?' || next === '{')) {
    return undefined;
  }

  return { length, variable };
}

/** Test-only: how many sources are compiled (or known invalid) and cached. */
export function patternCacheSizeForTests(): number {
  return cache.size;
}

// `$` counts as an anchor only when it is not escaped (an even number of
// backslashes precedes it).
function endsWithAnchor(source: string): boolean {
  if (!source.endsWith('$')) {
    return false;
  }

  let backslashes = 0;

  for (let i = source.length - 2; i >= 0 && source[i] === '\\'; i -= 1) {
    backslashes += 1;
  }

  return backslashes % 2 === 0;
}
