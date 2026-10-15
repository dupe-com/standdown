/**
 * Regular-expression value matching for `ParamMatcher` `match: 'pattern'`.
 *
 * Policies can arrive remotely (signed refresh bundles), so a pattern must be
 * cheap and predictable: validation rejects anything that does not compile, is
 * longer than {@link MAX_PATTERN_LENGTH}, or is not anchored with both `^` and
 * `$`. No flags are accepted. Each source compiles once; matching stays pure
 * and synchronous, and an invalid source simply never matches (for a
 * self-exemption that errs toward standing down).
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

  const risky = riskyShape(source);

  if (risky !== undefined) {
    return risky;
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

/**
 * Rejects the regex shapes behind catastrophic backtracking (ReDoS): a repeated
 * group that itself contains a repeat or an alternation at any depth
 * (`(a+)+`, `((a+))+`, `(a|aa)+`, `(\\d+){2,}`), and backreferences. A small
 * scanner, not a full parser: it skips escapes and character classes and tracks
 * groups, which is enough to be strict about the risky shapes. `undefined` = ok.
 */
export function riskyShape(source: string): string | undefined {
  const groups: boolean[] = [false]; // per open group: contains a repeat or `|`
  let afterGroup = false; // the previous atom was a group that closed
  let lastGroupRisky = false;
  let i = 0;

  while (i < source.length) {
    const c = source[i];

    if (c === '\\') {
      const next = source[i + 1] ?? '';
      if (/[1-9]/.test(next) || (next === 'k' && source[i + 2] === '<')) {
        return 'uses a backreference';
      }
      i += 2;
      afterGroup = false;
      continue;
    }

    if (c === '[') {
      i += 1;
      if (source[i] === '^') i += 1;
      if (source[i] === ']') i += 1;
      while (i < source.length && source[i] !== ']') i += source[i] === '\\' ? 2 : 1;
      i += 1;
      afterGroup = false;
      continue;
    }

    if (c === '(') {
      groups.push(false);
      i += 1;
      if (source[i] === '?') {
        i += 1;
        if (source[i] === '<' && source[i + 1] !== '=' && source[i + 1] !== '!') {
          while (i < source.length && source[i] !== '>') i += 1;
        }
        i += 1;
      }
      afterGroup = false;
      continue;
    }

    if (c === ')') {
      lastGroupRisky = groups.pop() ?? false;
      if (groups.length === 0) groups.push(false);
      groups[groups.length - 1] ||= lastGroupRisky;
      afterGroup = true;
      i += 1;
      continue;
    }

    if (c === '|') {
      groups[groups.length - 1] = true;
      afterGroup = false;
      i += 1;
      continue;
    }

    const repeat = repeatLength(source, i);

    if (repeat > 0) {
      if (afterGroup && lastGroupRisky) {
        return 'repeats a group that contains a repeat or alternation (catastrophic backtracking)';
      }
      groups[groups.length - 1] = true;
      afterGroup = false;
      i += repeat;
      continue;
    }

    afterGroup = false;
    i += 1;
  }

  return undefined;
}

// Length of a repeating quantifier at `i` (`+`, `*`, `{n,}`, `{n,m}` / `{n}` with
// a max above 1), or 0. `?` and `{0,1}` can't repeat, so they don't count.
function repeatLength(source: string, i: number): number {
  const c = source[i];

  if (c === '+' || c === '*') {
    return 1;
  }

  if (c === '{') {
    const m = /^\{(\d+)(,(\d*))?\}/.exec(source.slice(i));
    if (m) {
      const min = Number(m[1]);
      const max = m[2] === undefined ? min : m[3] === '' ? Infinity : Number(m[3]);
      return max > 1 ? m[0].length : 0;
    }
  }

  return 0;
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
