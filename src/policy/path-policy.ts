// ---------------------------------------------------------------------------
// v4 Policy — path access policy
// ---------------------------------------------------------------------------

import path from 'node:path';
import { homedir } from 'node:os';
import { realpathSync, existsSync } from 'node:fs';
import { i18n } from '../i18n/index.js';
import type { PathPolicyInput, PathPolicyDecision, PathPolicyConfig } from './types.js';

export interface PathAccessPolicy {
  check(input: PathPolicyInput): PathPolicyDecision;
  getEffectiveRoots(scope: { readRoots: string[]; writeRoots: string[] }): { readRoots: string[]; writeRoots: string[] };
}

export interface PathAccessPolicyConfig extends PathPolicyConfig {
  /** Auto-inject process.cwd() into read + write roots. Default true. */
  autoInjectCwd?: boolean;
  /** Auto-inject this directory into read + write roots. */
  autoInjectMediaCache?: string;
}

export class PathAccessPolicyImpl implements PathAccessPolicy {
  private readRoots: string[];
  private writeRoots: string[];
  private deniedPatterns: string[];

  constructor(config: PathAccessPolicyConfig) {
    const normalized = normalizeConfig(config);
    this.readRoots = normalized.readRoots;
    this.writeRoots = normalized.writeRoots;
    this.deniedPatterns = normalized.deniedPatterns;
  }

  updateConfig(config: PathAccessPolicyConfig): void {
    const normalized = normalizeConfig(config);
    this.readRoots = normalized.readRoots;
    this.writeRoots = normalized.writeRoots;
    this.deniedPatterns = normalized.deniedPatterns;
  }

  check(input: PathPolicyInput): PathPolicyDecision {
    const resolved = normalizePath(input.path, input.operation);

    // 2. Check denied patterns first (they override everything)
    for (const denied of this.getDeniedPatterns(input)) {
      if (matchesDeniedPattern(resolved, denied)) {
        return { allowed: false, reason: i18n.t('tools-builtins:pathPolicy.deniedPattern', { pattern: denied }), resolvedPath: resolved };
      }
    }

    // 3. Check read/write roots
    const roots = this.getRootsForInput(input);

    if (roots.length === 0) {
      return { allowed: false, reason: i18n.t('tools-builtins:pathPolicy.noRootsConfigured', { operation: input.operation }), resolvedPath: resolved };
    }

    for (const root of roots) {
      if (isWithinRoot(resolved, root)) {
        return { allowed: true, resolvedPath: resolved };
      }
    }

    return {
      allowed: false,
      reason: i18n.t('tools-builtins:pathPolicy.outsideRoots', { resolved, operation: input.operation }),
      resolvedPath: resolved,
    };
  }

  getEffectiveRoots(scope: { readRoots: string[]; writeRoots: string[] }): { readRoots: string[]; writeRoots: string[] } {
    return {
      readRoots: this.getScopedRoots(this.readRoots, scope.readRoots),
      writeRoots: this.getScopedRoots(this.writeRoots, scope.writeRoots),
    };
  }

  private getRootsForInput(input: PathPolicyInput): string[] {
    return input.operation === 'write'
      ? this.getScopedRoots(this.writeRoots, input.scope.writeRoots)
      : this.getScopedRoots(this.readRoots, input.scope.readRoots);
  }

  private getScopedRoots(configuredRoots: string[], scopedRoots: string[]): string[] {
    const normalizedScope = unique(scopedRoots.map(r => normalizePath(r)));
    if (normalizedScope.length === 0) {
      return configuredRoots;
    }

    return normalizedScope.filter(scopeRoot =>
      configuredRoots.some(configuredRoot => isWithinRoot(scopeRoot, configuredRoot)),
    );
  }

  private getDeniedPatterns(input: PathPolicyInput): string[] {
    return unique([...this.deniedPatterns, ...(input.scope.deniedPatterns ?? [])]);
  }
}

function normalizeConfig(config: PathAccessPolicyConfig): {
  readRoots: string[];
  writeRoots: string[];
  deniedPatterns: string[];
} {
  const resolvedReadRoots = (config.readRoots ?? []).map(r => normalizePath(r));
  const resolvedWriteRoots = (config.writeRoots ?? []).map(w => normalizePath(w));

  if (config.autoInjectCwd !== false) {
    const cwd = normalizePath(process.cwd());
    if (!resolvedReadRoots.includes(cwd)) resolvedReadRoots.push(cwd);
    if (!resolvedWriteRoots.includes(cwd)) resolvedWriteRoots.push(cwd);
  }

  if (config.autoInjectMediaCache) {
    const cacheDir = normalizePath(config.autoInjectMediaCache);
    if (!resolvedReadRoots.includes(cacheDir)) resolvedReadRoots.push(cacheDir);
    if (!resolvedWriteRoots.includes(cacheDir)) resolvedWriteRoots.push(cacheDir);
  }

  return {
    readRoots: resolvedReadRoots,
    writeRoots: resolvedWriteRoots,
    deniedPatterns: config.deniedPatterns ?? [],
  };
}

function expandHome(input: string): string {
  if (!input.startsWith('~')) return input;
  return path.resolve(homedir(), input.slice(input.startsWith('~/') ? 2 : 1));
}

function normalizePath(input: string, operation?: 'read' | 'write'): string {
  const resolved = path.resolve(expandHome(input));
  if (operation !== 'write') {
    return normalizeExistingPath(resolved);
  }
  return normalizeWritePath(resolved);
}

function normalizeExistingPath(input: string): string {
  try {
    if (existsSync(input)) {
      return realpathSync(input);
    }
  } catch {
    // Non-existent read targets are still checked by their normalized path.
  }
  return input;
}

function normalizeWritePath(input: string): string {
  const missingParts: string[] = [];
  let existing = input;

  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    missingParts.unshift(path.basename(existing));
    existing = parent;
  }

  const realExisting = normalizeExistingPath(existing);
  return missingParts.length === 0
    ? realExisting
    : path.join(realExisting, ...missingParts);
}

function isWithinRoot(filePath: string, root: string): boolean {
  const relative = path.relative(root, filePath);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Convert a glob pattern to a regex source string with conventional segment
 * semantics:
 *   - `**` matches across path separators (any number of segments).
 *   - `*`  matches within a single segment only (never crosses `/`).
 *
 * Previously every `*` became `.*`, so a single `*` silently crossed `/`.
 * That made allow-style patterns over-match. Deny patterns that intentionally
 * span segments should now use the double-star form (e.g. `<star><star>/.ssh/<star><star>`).
 */
function globToRegexSource(pattern: string): string {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*'; // cross-segment
        i++;
      } else {
        out += '[^/]*'; // within-segment
      }
    } else if (/[.+^${}()|[\]\\?]/.test(c)) {
      out += '\\' + c;
    } else {
      out += c;
    }
  }
  return out;
}

function matchGlob(filePath: string, pattern: string): boolean {
  return new RegExp(`^${globToRegexSource(pattern)}$`).test(filePath);
}

/**
 * Legacy greedy glob: every `*` crosses path separators. Retained ONLY as a
 * widening fallback for deny matching so that pre-existing deny configs (such
 * as a star-slash-dot-ssh-slash-star pattern) keep matching nested paths after
 * the semantics change — for a deny list, over-matching fails safe. New configs
 * should prefer the double-star form.
 */
function matchGlobGreedy(filePath: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\?]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(filePath);
}

function matchesDeniedPattern(resolvedPath: string, pattern: string): boolean {
  const expanded = expandHome(pattern);
  const normalizedPattern = path.isAbsolute(expanded) && !expanded.includes('*')
    ? normalizePath(expanded)
    : expanded;

  if (path.isAbsolute(normalizedPattern) && !normalizedPattern.includes('*')) {
    return isWithinRoot(resolvedPath, normalizedPattern);
  }

  // Deny matching fails safe by widening: a path is denied if it matches the
  // strict-glob semantics OR the legacy greedy interpretation OR the pattern
  // against the basename. This keeps existing deny configs effective while
  // making `**`/within-segment `*` semantics available going forward.
  return (
    matchGlob(resolvedPath, normalizedPattern) ||
    matchGlobGreedy(resolvedPath, normalizedPattern) ||
    matchGlob(path.basename(resolvedPath), pattern)
  );
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
