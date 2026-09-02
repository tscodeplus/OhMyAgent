// ---------------------------------------------------------------------------
// Glob matching — the shared engine behind deny patterns and include filters
// ---------------------------------------------------------------------------
//
// Nine copies of this matcher existed (four channel media tools, file-read,
// file-search, grep, search, glob, and the path policy), and they disagreed:
// some mapped `*` across path separators, some mapped `**/` differently from
// `**`, one treated `?` as a literal and another as a regex quantifier applied
// to the previous character. Copies of a matcher that guard an allowlist and a
// denylist must not agree by accident, so the two semantics are named here.
//
//   strict   `*` stays inside one segment, `**` crosses segments, `?` is one
//            character. Use for allow-style filtering, where over-matching
//            leaks files into results.
//   greedy   every `*` crosses segments — the legacy behaviour that shipped in
//            deny lists before strict semantics existed.
//
// Deny matching applies both, plus a basename pass: over-matching a deny
// pattern fails safe while under-matching it leaks, so existing configurations
// must not lose their teeth when semantics tighten. `[abc]` / `[!abc]` classes
// are supported by the strict matcher; an unbalanced `[` matches literally so a
// malformed pattern can never throw inside a security check.

/** Escape every regex metacharacter except the glob specials handled below. */
function escapeLiteral(char: string): string {
  return /[.+^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
}

/**
 * A balanced `[...]` / `[!...]` class is emitted verbatim (regex and glob
 * classes agree), with `\` and `]` inside it neutralised. An unbalanced `[` is
 * escaped as a literal instead — a half-written class would compile to a
 * RegExp SyntaxError, and these patterns are evaluated inside security checks.
 * Returns null when there is no usable class at `index`.
 */
function readCharClass(pattern: string, index: number): { source: string; end: number } | null {
  let cursor = index + 1;
  let negated = false;
  if (pattern[cursor] === '!' || pattern[cursor] === '^') {
    negated = true;
    cursor++;
  }
  // `]` directly after the opening bracket is a literal member, as in glob.
  if (pattern[cursor] === ']') cursor++;
  const close = pattern.indexOf(']', cursor);
  if (close === -1) return null;

  const inner = pattern
    .slice(negated ? index + 2 : index + 1, close)
    .replace(/[\]\\]/g, '\\$&');
  if (!inner) return null;
  return { source: `[${negated ? '^' : ''}${inner}]`, end: close };
}

/**
 * Segment-aware glob → RegExp source:
 *   `**/`  zero or more leading segments
 *   `/**`  zero or more trailing segments
 *   `**`   anything, across segments
 *   `*`    one segment, no separators
 *   `?`    exactly one character (not a separator)
 */
export function globToRegexSource(pattern: string): string {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          out += '(.*/)?';
          i += 2;
        } else if (out.endsWith('/')) {
          // `/**` at the end (or before a non-separator) — the whole subtree,
          // including the directory itself.
          out = `${out.slice(0, -1)}(/.*)?`;
          i++;
        } else {
          out += '.*';
          i++;
        }
      } else {
        out += '[^/]*';
      }
    } else if (char === '?') {
      out += '[^/]';
    } else if (char === '[') {
      const klass = readCharClass(pattern, i);
      if (klass) {
        out += klass.source;
        i = klass.end;
      } else {
        out += escapeLiteral(char);
      }
    } else {
      out += escapeLiteral(char);
    }
  }
  return out;
}

/**
 * Legacy greedy glob → RegExp source: every `*` crosses separators, so
 * `.ssh/*` also denies `.ssh/id/sub`. Deny lists only — see the header.
 */
export function greedyGlobToRegexSource(pattern: string): string {
  let out = '';
  for (const char of pattern) {
    out += char === '*' ? '.*' : /[.+^${}()|[\]\\?]/.test(char) ? `\\${char}` : char;
  }
  return out;
}

/**
 * Compile a glob into an anchored RegExp. Callers that filter a directory walk
 * compile once and `.test()` per entry; `matchGlob*` below are the one-shot
 * form used by security checks.
 */
export function globToRegExp(pattern: string, greedy = false): RegExp {
  return new RegExp(`^${greedy ? greedyGlobToRegexSource(pattern) : globToRegexSource(pattern)}$`);
}

/** Strict (segment-aware) glob match against the whole subject. */
export function matchGlobStrict(subject: string, pattern: string): boolean {
  return globToRegExp(pattern).test(subject);
}

/** Greedy glob match against the whole subject. */
export function matchGlobGreedy(subject: string, pattern: string): boolean {
  return globToRegExp(pattern, true).test(subject);
}

/**
 * Deny-list check for one path against one pattern: denied when the pattern
 * matches the path under either star semantics, or matches its basename
 * (patterns configured as bare names such as `.env` or `*.pem`). The basename
 * pass needs only strict semantics — a basename contains no separator, so a
 * single `*` there already spans the whole string.
 */
export function isDeniedByPattern(filePath: string, basename: string, pattern: string): boolean {
  return (
    matchGlobStrict(filePath, pattern) ||
    matchGlobGreedy(filePath, pattern) ||
    matchGlobStrict(basename, pattern)
  );
}

/** True when any deny pattern covers the path. Empty/undefined lists allow. */
export function isDeniedByPatterns(
  filePath: string,
  basename: string,
  patterns: readonly string[] | undefined,
): boolean {
  if (!patterns || patterns.length === 0) return false;
  return patterns.some((pattern) => isDeniedByPattern(filePath, basename, pattern));
}
