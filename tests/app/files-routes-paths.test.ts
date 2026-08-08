/**
 * Tests for isWithinRoot — the path containment check behind file serve /
 * download / preview.
 *
 * Regression focus: on Windows the desktop file_root is a drive root (e.g.
 * "D:\"). resolve("D:\\") ends with sep, so the naive
 * `startsWith(resolvedRoot + sep)` produced "D:\\" (double backslash) which
 * never matches a real path — every file in the root was rejected as
 * "Path traversal denied". path.win32 is injected to exercise real Windows
 * semantics from the Linux runner.
 */

import { describe, it, expect } from 'vitest';
import { win32, posix } from 'node:path';
import { isWithinRoot } from '../../src/app/webui/files-routes.js';

describe('isWithinRoot (Windows semantics via path.win32)', () => {
  it('drive root: files inside D:\ are within it (the regression)', () => {
    expect(isWithinRoot('D:\\', 'D:\\Users\\ThinkPad\\notes.txt', win32)).toBe(true);
    expect(isWithinRoot('D:\\', 'D:\\Users', win32)).toBe(true);
  });

  it('drive root: itself is within itself', () => {
    expect(isWithinRoot('D:\\', 'D:\\', win32)).toBe(true);
  });

  it('drive root: other drives are rejected', () => {
    expect(isWithinRoot('D:\\', 'C:\\Users\\ThinkPad\\secret.txt', win32)).toBe(false);
    expect(isWithinRoot('D:\\', 'E:\\data\\x', win32)).toBe(false);
  });

  it('directory root: contained paths pass, sibling-prefixed paths fail', () => {
    const root = 'C:\\repo\\files-root';
    expect(isWithinRoot(root, 'C:\\repo\\files-root\\a.txt', win32)).toBe(true);
    // "files-root2" shares the prefix but is NOT inside the root
    expect(isWithinRoot(root, 'C:\\repo\\files-root2\\a.txt', win32)).toBe(false);
    expect(isWithinRoot(root, 'C:\\repo\\files-root\\..\\..\\etc\\x', win32)).toBe(false);
  });

  it('directory root: parent traversal is rejected', () => {
    const root = 'C:\\repo\\files-root';
    expect(isWithinRoot(root, 'C:\\repo\\x', win32)).toBe(false);
    expect(isWithinRoot(root, 'C:\\repo\\', win32)).toBe(false);
  });
});

describe('isWithinRoot (POSIX semantics via path.posix)', () => {
  it('contained paths pass, prefix-siblings and parents fail', () => {
    const root = '/home/iwapu/files';
    expect(isWithinRoot(root, '/home/iwapu/files/a.txt', posix)).toBe(true);
    expect(isWithinRoot(root, '/home/iwapu/files', posix)).toBe(true);
    expect(isWithinRoot(root, '/home/iwapu/files2/a.txt', posix)).toBe(false);
    expect(isWithinRoot(root, '/home/iwapu', posix)).toBe(false);
    expect(isWithinRoot(root, '/home/iwapu/files/../../etc/passwd', posix)).toBe(false);
  });

  it('filesystem root: everything is within it', () => {
    expect(isWithinRoot('/', '/etc/passwd', posix)).toBe(true);
    expect(isWithinRoot('/', '/', posix)).toBe(true);
  });
});
