import path from 'node:path';
import os from 'node:os';
import { homedir } from 'node:os';

/**
 * Minimal `node:path` surface a containment check needs. Injectable so tests
 * can exercise Windows semantics (`path.win32`) from a POSIX runner.
 */
export interface PathImpl {
  relative(from: string, to: string): string;
  isAbsolute(p: string): boolean;
  sep: string;
}

/**
 * Check whether filePath is within the given root directory.
 *
 * Deliberately uses relative() instead of `resolved.startsWith(root + sep)`:
 * a string prefix treats `C:\repo\files-root` as containing
 * `C:\repo\files-root2`, while relative() compares whole components.
 * relative() also normalizes both inputs, handles Windows drive roots
 * (relative('D:\\', 'D:\\x') is 'x', not '\\x') and is case-insensitive on
 * Windows.
 */
export function isWithinRoot(filePath: string, root: string, p: PathImpl = path): boolean {
  const relative = p.relative(root, filePath);
  if (relative === '') return true;
  if (!relative || p.isAbsolute(relative)) return false;
  // Only '..' and '../..' style parents escape; '..bak' is an ordinary name.
  return relative !== '..' && !relative.startsWith(`..${p.sep}`);
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

/**
 * A configured `allowedRoots` option → absolute, de-duplicated roots.
 *
 * The launch directory joins the set ONLY when nothing was configured, which is
 * the documented default of every `allowedRoots` option. Seeding cwd
 * unconditionally would let whichever directory the process happened to start in
 * silently widen the sandbox — repo root under `pnpm dev`, `$HOME` under Termux,
 * the install directory for the desktop sidecar — so the same config would grant
 * different permissions on each deployment.
 */
export function allowedRootsWithFallback(
  roots: readonly string[] | undefined,
  fallback: string = process.cwd(),
): string[] {
  const normalized = normalizeRoots([...(roots ?? [])]);
  return normalized.length > 0 ? normalized : [path.resolve(fallback)];
}

/**
 * Key order for extracting a file-path argument from tool args. Both the
 * approval-card rendering (before-tool-call) and the PolicyCenter reuse
 * subject (policy-center) MUST use the same order — a divergent order makes
 * the displayed path differ from the recorded approval subject when args
 * contain both `path` and `filePath`.
 */
export const PATH_ARG_KEYS = [
  'filePath',
  'path',
  'directory',
  'imagePath',
  'audioPath',
  'cwd',
  'outputPath',
  'outputDir',
] as const;

/**
 * Extract the first string-valued path argument from tool args using the
 * canonical key order. Returns undefined when no path-like arg is present.
 */
export function extractPathArg(args: unknown): string | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const record = args as Record<string, unknown>;
  for (const key of PATH_ARG_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

/**
 * Expand a leading `~` or `~/` to the user's home directory.
 * Bare `~` maps to the home dir itself; `~name` (another user's home) and
 * all other inputs are returned UNCHANGED — callers decide whether/how to
 * resolve relative paths (glob deny patterns must stay relative!).
 */
export function expandHomePath(rawPath: string): string {
  if (rawPath === '~') return path.resolve(homedir());
  if (rawPath.startsWith('~/')) return path.resolve(homedir(), rawPath.slice(2));
  return rawPath;
}
