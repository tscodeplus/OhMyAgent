// src/tools/shell-command-policy/file-paths.ts
//
// File path extraction, resolution, and root-bounds checking.
// Also contains the READ_ONLY_PROGRAMS set used by read-only shell mode.

import path from 'path';
import os from 'os';
import { isWithinRoot } from '../../shared/path-utils.js';
import type { NormalizedShellCommand } from './types.js';

// ─── Read-only programs (for minimal profile) ───

export const READ_ONLY_PROGRAMS = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'find',
  'df', 'du', 'ps', 'uptime', 'uname', 'whoami',
  'date', 'echo', 'env', 'printenv', 'which', 'pwd',
  'sort', 'uniq', 'cut', 'tr',
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

/**
 * Resolve a file path from a command argument to an absolute path.
 * Expands ~ and resolves relative paths against cwd.
 */
export function resolveFilePath(rawPath: string): string {
  if (rawPath.startsWith('~')) {
    return path.resolve(os.homedir(), rawPath.slice(rawPath.startsWith('~/') ? 2 : 1));
  }
  return path.resolve(rawPath);
}

/**
 * Check which file paths extracted from a command fall outside the allowed roots.
 * Returns the list of arguments that resolve outside allowed roots (empty = all inside).
 * When allowedRoots is empty, uses [process.cwd()] as fallback.
 */
export function checkFilePathsOutsideRoots(
  command: NormalizedShellCommand,
  allowedRoots: string[],
): string[] {
  const roots = [process.cwd()];
  for (const r of allowedRoots) {
    const resolved = path.resolve(r);
    // Case-insensitive dedup on Windows
    const isDup = roots.some(existing =>
      process.platform === 'win32'
        ? existing.toLowerCase() === resolved.toLowerCase()
        : existing === resolved,
    );
    if (!isDup) {
      roots.push(resolved);
    }
  }

  const filePaths = extractFilePaths(command);
  const outside: string[] = [];

  for (const fp of filePaths) {
    // Skip common non-path patterns: env vars, shell variables, substitution
    if (fp.startsWith('$') || fp.startsWith('${') || fp.startsWith('$(') || fp.startsWith('`')) {
      continue;
    }
    const resolved = resolveFilePath(fp);
    // Cross-platform path check: handles mixed separators + case-insensitive on Windows
    const inside = roots.some(root => isWithinRoot(resolved, root));
    if (!inside) {
      outside.push(fp);
    }
  }

  return outside;
}
