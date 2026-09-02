/**
 * Tests for the shared isWithinRoot — the single containment predicate behind
 * file serve, download, preview, the tool roots and the path policy.
 *
 * Regression focus 1: on Windows the desktop file_root is a drive root (e.g.
 * "D:\"). A `startsWith(resolvedRoot + sep)` check turned that into "D:\\"
 * (double backslash), which never matches a real path, so every file in the
 * root was rejected as "Path traversal denied".
 *
 * Regression focus 2: a string prefix on the root is only safe if the
 * separator is part of it, and never compares whole components the way
 * relative() does — sibling directories like `files-root2` and differently
 * cased Windows paths must be judged by path semantics, not by characters.
 *
 * path.win32 / path.posix are injected to exercise both platforms' semantics
 * from a single runner.
 */

import { describe, it, expect } from 'vitest';
import { win32, posix, resolve } from 'node:path';
import { isWithinRoot, allowedRootsWithFallback } from '../../src/shared/path-utils.js';

describe('isWithinRoot (Windows semantics via path.win32)', () => {
  it('drive root: files inside D:\\ are within it (the regression)', () => {
    expect(isWithinRoot('D:\\Users\\ThinkPad\\notes.txt', 'D:\\', win32)).toBe(true);
    expect(isWithinRoot('D:\\Users', 'D:\\', win32)).toBe(true);
  });

  it('drive root: itself is within itself', () => {
    expect(isWithinRoot('D:\\', 'D:\\', win32)).toBe(true);
  });

  it('drive root: other drives are rejected', () => {
    expect(isWithinRoot('C:\\Users\\ThinkPad\\secret.txt', 'D:\\', win32)).toBe(false);
    expect(isWithinRoot('E:\\data\\x', 'D:\\', win32)).toBe(false);
  });

  it('directory root: contained paths pass, sibling-prefixed paths fail', () => {
    const root = 'C:\\repo\\files-root';
    expect(isWithinRoot('C:\\repo\\files-root\\a.txt', root, win32)).toBe(true);
    // "files-root2" shares the prefix but is NOT inside the root
    expect(isWithinRoot('C:\\repo\\files-root2\\a.txt', root, win32)).toBe(false);
    expect(isWithinRoot('C:\\repo\\files-root\\..\\..\\etc\\x', root, win32)).toBe(false);
  });

  it('directory root: parent traversal is rejected', () => {
    const root = 'C:\\repo\\files-root';
    expect(isWithinRoot('C:\\repo\\x', root, win32)).toBe(false);
    expect(isWithinRoot('C:\\repo\\', root, win32)).toBe(false);
  });

  it('directory root: a name merely starting with ".." is not traversal', () => {
    const root = 'C:\\repo\\files-root';
    expect(isWithinRoot('C:\\repo\\files-root\\..backup', root, win32)).toBe(true);
    expect(isWithinRoot('C:\\repo\\files-root\\sub\\..env', root, win32)).toBe(true);
  });

  it('Windows path comparison is case-insensitive', () => {
    expect(isWithinRoot('C:\\REPO\\Files-Root\\A.TXT', 'c:\\repo\\files-root', win32)).toBe(true);
  });
});

describe('isWithinRoot (POSIX semantics via path.posix)', () => {
  it('contained paths pass, prefix-siblings and parents fail', () => {
    const root = '/home/iwapu/files';
    expect(isWithinRoot('/home/iwapu/files/a.txt', root, posix)).toBe(true);
    expect(isWithinRoot('/home/iwapu/files', root, posix)).toBe(true);
    expect(isWithinRoot('/home/iwapu/files2/a.txt', root, posix)).toBe(false);
    expect(isWithinRoot('/home/iwapu', root, posix)).toBe(false);
    expect(isWithinRoot('/home/iwapu/files/../../etc/passwd', root, posix)).toBe(false);
  });

  it('filesystem root: everything is within it', () => {
    expect(isWithinRoot('/etc/passwd', '/', posix)).toBe(true);
    expect(isWithinRoot('/', '/', posix)).toBe(true);
  });

  it('a name merely starting with ".." is not traversal', () => {
    expect(isWithinRoot('/home/iwapu/files/..backup', '/home/iwapu/files', posix)).toBe(true);
    expect(isWithinRoot('/home/iwapu/filesx/..backup', '/home/iwapu/files', posix)).toBe(false);
  });
});

describe('isWithinRoot (platform default)', () => {
  it('accepts an unresolved filePath and an unresolved root', () => {
    const root = process.cwd();
    expect(isWithinRoot(joinCwd('src', 'index.ts'), root)).toBe(true);
    expect(isWithinRoot(joinCwd('..', 'etc', 'passwd'), root)).toBe(false);
  });
});

describe('allowedRootsWithFallback', () => {
  const cwd = resolve('.');

  it('falls back to the launch directory when nothing is configured', () => {
    expect(allowedRootsWithFallback(undefined)).toEqual([cwd]);
    expect(allowedRootsWithFallback([])).toEqual([cwd]);
  });

  it('does not silently widen a configured root list with cwd', () => {
    const roots = allowedRootsWithFallback(['/opt/oma/data', '/opt/oma/data']);
    expect(roots).toEqual([resolve('/opt/oma/data')]);
    expect(roots).not.toContain(cwd);
  });
});

function joinCwd(...segments: string[]): string {
  return [process.cwd(), ...segments].join('/');
}
