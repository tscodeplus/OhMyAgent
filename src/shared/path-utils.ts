import path from 'node:path';
import os from 'node:os';

/**
 * Check whether filePath is within the given root directory.
 * Uses path.relative() which is case-insensitive on Windows
 * and correctly handles mixed path separators on all platforms.
 */
export function isWithinRoot(filePath: string, root: string): boolean {
  const relative = path.relative(root, filePath);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Resolve a user-supplied path to an absolute path, expanding ~ and
 * normalizing separators. Similar to how path.resolve works but also
 * handles ~ expansion.
 */
export function resolvePath(rawPath: string): string {
  if (rawPath.startsWith('~')) {
    return path.resolve(os.homedir(), rawPath.slice(rawPath.startsWith('~/') ? 2 : 1));
  }
  return path.resolve(rawPath);
}

/**
 * Normalize an array of root paths: resolve each to absolute, then
 * deduplicate. On Windows, path.resolve normalizes separators to \.
 */
export function normalizeRoots(roots: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const r of roots) {
    // path.resolve handles empty strings → cwd, skip those
    const resolved = path.resolve(r);
    // Use lowercase key on Windows for case-insensitive dedup
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(resolved);
    }
  }
  return result;
}
