// src/tools/shell-command-policy/file-paths.ts
//
// File path extraction, resolution, and root-bounds checking.
// Also contains the READ_ONLY_PROGRAMS set used by read-only shell mode.

import fs from 'node:fs';
import path from 'path';
import os from 'os';
import { isWithinRoot } from '../../shared/path-utils.js';
import type { NormalizedShellCommand } from './types.js';

// ─── Read-only programs (for minimal profile) ───
// Note: `env` was removed — `env rm -rf ~/x` would execute ANY program.
// Use `printenv` to list environment variables instead.

export const READ_ONLY_PROGRAMS = new Set([
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'grep',
  'find',
  'df',
  'du',
  'ps',
  'uptime',
  'uname',
  'whoami',
  'date',
  'echo',
  'printenv',
  'which',
  'pwd',
  'sort',
  'uniq',
  'cut',
  'tr',
]);

// ─── File Path Extraction & Root Checking ───

/**
 * Extract potential file-system paths from a command's arguments.
 * Filters out flags (starting with -) and shell operators.
 */
export function extractFilePaths(command: NormalizedShellCommand): string[] {
  const OPERATORS = new Set(['&&', '||', '|', ';', '>', '<', '>>', '<<']);
  const paths: string[] = [];
  for (const arg of command.args) {
    if (arg.startsWith('-')) continue;
    if (OPERATORS.has(arg)) continue;
    paths.push(arg);
  }
  return paths;
}

/** Strip a single pair of surrounding quotes (the parser normally does this). */
function stripPathQuotes(raw: string): string {
  let s = raw.trim();
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      s = s.slice(1, -1);
    }
  }
  return s;
}

/**
 * Join without collapsing `..` — path.join/path.resolve normalize `..` away
 * string-wise, but the kernel resolves `..` relative to symlink TARGETS, so
 * `..` must survive until fs.realpathSync processes it.
 */
function joinNoNormalize(base: string, rest: string): string {
  if (rest === '') return base;
  return `${base}${path.sep}${rest.replace(/^[/\\]+/, '')}`;
}

/**
 * Expand ~, $HOME and ${HOME} at the start of a path and make it absolute.
 *
 * Ordering matters for security:
 *  1. quotes are stripped first,
 *  2. `..` components are preserved (see joinNoNormalize) so symlink
 *     resolution can apply kernel semantics (`link/..` follows the symlink
 *     target, not the string prefix),
 *  3. unresolved variables / command substitution yield `null` — callers must
 *     treat `null` as "outside the allowed roots" (conservative).
 */
export function expandPathVariables(rawPath: string): string | null {
  const s = stripPathQuotes(rawPath);

  if (s.startsWith('~-') || s.startsWith('~+')) {
    return null; // ~- (OLDPWD) / ~+ (PWD): not statically resolvable
  }

  if (s.startsWith('~')) {
    return joinNoNormalize(os.homedir(), s.slice(s.startsWith('~/') ? 2 : 1));
  }

  if (s.startsWith('${HOME}')) {
    const rest = s.slice('${HOME}'.length);
    if (rest === '' || rest.startsWith('/') || rest.startsWith('\\')) {
      return joinNoNormalize(os.homedir(), rest);
    }
    return null; // ${HOME}something / ${HOME:-default}: unresolvable
  }

  if (s.startsWith('$HOME')) {
    const rest = s.slice('$HOME'.length);
    if (rest === '' || rest.startsWith('/') || rest.startsWith('\\')) {
      return joinNoNormalize(os.homedir(), rest);
    }
    return null; // $HOMESOMETHING: a different variable — unresolvable
  }

  if (s.includes('$') || s.includes('`')) {
    return null; // variable expansion / command substitution: cannot resolve statically
  }

  return path.isAbsolute(s) ? s : joinNoNormalize(process.cwd(), s);
}

/**
 * Kernel-style canonicalization of an absolute path.
 *
 * Components are resolved left to right with lstat/readlink, which applies
 * kernel semantics to `..` (a `..` after a symlink refers to the symlink
 * TARGET's parent, not the string prefix). This closes escapes like
 * `<root>/link/../etc/passwd` where `link -> /etc`.
 *
 * fs.realpathSync cannot be used here: libuv collapses `..` string-wise
 * after following a symlink (verified: `root/link/..` realpaths to `root`
 * when `link` is a symlink to a directory elsewhere).
 *
 * Components that do not exist yet (e.g. files about to be created) are
 * appended verbatim after the deepest existing prefix; a symlink loop is
 * cut off after MAX_SYMLINK_DEPTH links (remaining components verbatim).
 */
export function resolveSymlinks(p: string): string {
  const MAX_SYMLINK_DEPTH = 40;
  const root = path.parse(p).root;
  const components = p
    .slice(root.length)
    .replace(/\\/g, '/')
    .split('/')
    .filter((c) => c !== '' && c !== '.');

  let current = root; // canonical prefix resolved so far
  let linkBudget = MAX_SYMLINK_DEPTH;
  let i = 0;
  while (i < components.length) {
    const c = components[i];

    if (c === '..') {
      // dirname of a canonical path is kernel-correct ('..' at the root is
      // a no-op: dirname(root) === root).
      current = path.dirname(current);
      i++;
      continue;
    }

    const candidate = path.join(current, c);
    let isLink = false;
    let linkTarget = '';
    try {
      const st = fs.lstatSync(candidate);
      isLink = st.isSymbolicLink();
      if (isLink) {
        linkTarget = fs.readlinkSync(candidate);
      }
    } catch {
      // Path (or an ancestor) does not exist yet — append the rest verbatim.
      // Any remaining `..` is collapsed string-wise here, which is safe: the
      // kernel would fail to open such a path anyway (missing component).
      return path.resolve(path.join(current, ...components.slice(i)));
    }

    if (isLink) {
      if (--linkBudget <= 0) {
        return path.resolve(path.join(current, ...components.slice(i)));
      }
      const targetComponents = linkTarget
        .replace(/\\/g, '/')
        .split('/')
        .filter((x) => x !== '' && x !== '.');
      if (path.isAbsolute(linkTarget)) {
        current = path.parse(linkTarget).root;
      }
      // Relative targets are reprocessed against `current` (the link's
      // canonical parent dir). Splice so the target's own symlinks and `..`
      // are resolved with kernel semantics too.
      components.splice(i, 1, ...targetComponents);
      continue;
    }

    current = candidate;
    i++;
  }
  return current;
}

/**
 * Resolve a file path from a command argument to an absolute path.
 * Expands ~, $HOME / ${HOME}, strips quotes, and resolves relative paths
 * against cwd. Unresolvable variable references fall back to the raw path.
 */
export function resolveFilePath(rawPath: string): string {
  const expanded = expandPathVariables(rawPath);
  return expanded ?? path.resolve(stripPathQuotes(rawPath));
}

/**
 * Check which file paths extracted from a command fall outside the allowed roots.
 * Returns the list of arguments that resolve outside allowed roots (empty = all inside).
 * When allowedRoots is empty, uses [process.cwd()] as fallback.
 *
 * Path arguments are normalized before the boundary check: quotes stripped,
 * ~ / $HOME / ${HOME} expanded, then canonicalized with kernel-style symlink
 * resolution (see resolveSymlinks). Arguments that reference variables or
 * command substitution which cannot be resolved statically are treated as
 * outside the roots (conservative).
 */
export function checkFilePathsOutsideRoots(
  command: NormalizedShellCommand,
  allowedRoots: string[],
): string[] {
  // Fall back to cwd ONLY when nothing was configured. Seeding cwd into a
  // non-empty root list would silently widen the sandbox to whichever
  // directory the process happened to launch from (Termux vs systemd vs the
  // desktop sidecar all differ). Whether cwd belongs in scope at all is the
  // policy layer's call — see autoInjectCwd in src/policy/path-policy.ts.
  const roots: string[] = allowedRoots.length === 0 ? [process.cwd()] : [];
  for (const r of allowedRoots) {
    const resolved = path.resolve(r);
    // Case-insensitive dedup on Windows
    const isDup = roots.some((existing) =>
      process.platform === 'win32'
        ? existing.toLowerCase() === resolved.toLowerCase()
        : existing === resolved,
    );
    if (!isDup) {
      roots.push(resolved);
    }
  }

  // Resolve symlinks in the roots too, so boundary checks compare like-for-like
  // (an allowed root may itself be a symlink).
  const realRoots = roots.map((r) => resolveSymlinks(r));

  const filePaths = extractFilePaths(command);
  const outside: string[] = [];

  for (const fp of filePaths) {
    // `curl file:///etc/passwd` reads a LOCAL file — strip the scheme so the
    // boundary check applies to the local path behind it.
    let pathArg = fp;
    if (pathArg.startsWith('file://')) {
      pathArg = pathArg.slice('file://'.length);
    }
    const expanded = expandPathVariables(pathArg);
    if (expanded === null) {
      // Unresolvable ($VAR, $(), backticks): conservative — treat as outside.
      outside.push(fp);
      continue;
    }
    const resolved = resolveSymlinks(expanded);
    // Cross-platform path check: handles mixed separators + case-insensitive on Windows
    const inside = realRoots.some((root) => isWithinRoot(resolved, root));
    if (!inside) {
      outside.push(fp);
    }
  }

  return outside;
}
