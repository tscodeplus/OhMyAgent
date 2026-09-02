/**
 * Tests for the shared glob engine.
 *
 * Nine per-file copies of a glob matcher used to disagree on what `*`, `**`,
 * `?` and `[abc]` mean; these tables pin the two named semantics down and,
 * equally important, assert that no pattern shape can throw — a matcher used
 * by deny checks must reject or accept, never crash the request that asked.
 */

import { describe, it, expect } from 'vitest';
import {
  globToRegExp,
  isDeniedByPattern,
  isDeniedByPatterns,
  matchGlobGreedy,
  matchGlobStrict,
} from '../../src/shared/glob.js';

describe('matchGlobStrict', () => {
  it.each([
    // [subject, pattern, expected]
    ['a.ts', '*.ts', true],
    ['dir/a.ts', '*.ts', false], // a single * never crosses a separator
    ['dir/a.ts', '**/*.ts', true],
    ['a.ts', '**/*.ts', true], // **/ also matches zero leading segments
    ['dir/sub/a.ts', '**/*.ts', true],
    ['src/a.ts', 'src/**', true],
    ['src', 'src/**', true], // trailing /** matches the root itself
    ['other/a.ts', 'src/**', false],
    ['a/b.ts', '**/b.ts', true],
    ['secrets/.ssh/id_rsa', '**/.ssh/**', true],
    ['a.ts', '?.ts', true],
    ['ab.ts', '?.ts', false],
    ['a/b', 'a?b', false], // ? does not cross a separator either
    ['file.test.ts', 'file.test.ts', true],
    ['fileXtestXts', 'file.test.ts', false], // . is literal
    ['(foo)', '(foo)', true], // regex groups stay literal text
    ['a.txt', '[abc].txt', true],
    ['b.txt', '[abc].txt', true],
    ['z.txt', '[abc].txt', false],
    ['ab.txt', '[abc].txt', false], // a class is exactly one character
    ['a.txt', '[!abc].txt', false],
    ['z.txt', '[!abc].txt', true],
    ['a[.txt', 'a[.txt', true], // an unbalanced [ matches literally
    ['a[b', 'a[b', true],
  ])('%s vs %s ⇒ %s', (subject, pattern, expected) => {
    expect(matchGlobStrict(subject, pattern)).toBe(expected);
  });
});

describe('matchGlobGreedy', () => {
  it.each([
    ['dir/a.ts', '*.ts', true], // legacy: one * crosses separators
    ['a/b', 'a?b', false], // legacy: ? is a literal, not a quantifier
    ['secrets/.ssh/id_rsa', '*/.ssh/*', true],
    ['a.ts', 'a.ts', true],
    ['file.test.ts', 'file.test.ts', true],
    ['fileXtestXts', 'file.test.ts', false],
  ])('%s vs %s ⇒ %s', (subject, pattern, expected) => {
    expect(matchGlobGreedy(subject, pattern)).toBe(expected);
  });
});

describe('isDeniedByPattern', () => {
  it.each([
    // [path, basename, pattern, expected]
    ['/proj/server.pem', 'server.pem', '*.pem', true],
    ['/proj/.env', '.env', '.env', true], // bare-name pattern hits the basename
    ['/proj/config/.env', '.env', '.env', true],
    ['/proj/src/app.ts', 'app.ts', '*.ts', true],
    ['/etc/passwd', 'passwd', '*.pem', false],
    ['/var/log/app.log', 'app.log', 'secrets/*.key', false],
    ['/home/u/.ssh/id_rsa', 'id_rsa', '**/.ssh/**', true],
    ['/home/u/.ssh/id_rsa', 'id_rsa', '*/.ssh/*', true], // legacy deny config keeps its teeth
  ])('%s / %s ⇒ %s', (filePath, base, pattern, expected) => {
    expect(isDeniedByPattern(filePath, base, pattern)).toBe(expected);
  });

  it('allows everything when there is no pattern', () => {
    expect(isDeniedByPatterns('/a/b', 'b', [])).toBe(false);
    expect(isDeniedByPatterns('/a/b', 'b', undefined)).toBe(false);
  });

  it('denies when any pattern covers the path', () => {
    expect(isDeniedByPatterns('/a/b/secret.txt', 'secret.txt', ['*.md', '*/secret.*'])).toBe(true);
  });
});

describe('malformed patterns never throw', () => {
  it.each(['[', '[]', '[a-', '**', '(', ')', '\\', 'a{b', 'a^b', '$1', '[[]]', '+', '?*['])(
    '%s',
    (pattern) => {
      expect(() => matchGlobStrict('/some/path/file.ts', pattern)).not.toThrow();
      expect(() => matchGlobGreedy('/some/path/file.ts', pattern)).not.toThrow();
    },
  );
});

describe('globToRegExp', () => {
  it('is anchored on both ends', () => {
    const re = globToRegExp('*.ts');
    expect(re.test('a.ts')).toBe(true);
    expect(re.test('a.tsx')).toBe(false);
    expect(re.test('dir/a.ts')).toBe(false); // anchored left as well as right
  });

  it('compiles once and can be reused across a directory walk', () => {
    const re = globToRegExp('**/*.json');
    expect(re.test('package.json')).toBe(true);
    expect(re.test('a/b/c.json')).toBe(true);
    expect(re.test('a/b/c.ts')).toBe(false);
  });

  it('produces a greedy matcher on request', () => {
    const re = globToRegExp('*.ts', true);
    expect(re.test('a/b/c.ts')).toBe(true);
  });
});
