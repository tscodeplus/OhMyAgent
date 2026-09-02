// ---------------------------------------------------------------------------
// v4 Policy — path access policy
// ---------------------------------------------------------------------------

import path from 'node:path';
import { existsSync } from 'node:fs';
import { i18n } from '../i18n/index.js';
import type { PathPolicyInput, PathPolicyDecision, PathPolicyConfig } from './types.js';
import { resolveSymlinks } from '../tools/shell-command-policy/file-paths.js';
import { expandHomePath, isWithinRoot } from '../shared/path-utils.js';
import { isDeniedByPattern } from '../shared/glob.js';

export interface PathAccessPolicy {
  check(input: PathPolicyInput): PathPolicyDecision;
  getEffectiveRoots(scope: { readRoots: string[]; writeRoots: string[] }): {
    readRoots: string[];
    writeRoots: string[];
  };
}

export interface PathAccessPolicyConfig extends PathPolicyConfig {
  /**
   * Add `process.cwd()` to the READ roots. Default false.
   *
   * cwd is deliberately never a write root: the launch directory depends on how
   * the process was started (repo root under `pnpm dev`, `$HOME` under Termux,
   * the install directory for the desktop sidecar), so treating it as writable
   * would make the sandbox scope vary silently between deployments. Declared
   * write access belongs in `writeRoots` / `agentHome`.
   */
  autoInjectCwd?: boolean;
  /**
   * Explicit data root (see src/shared/agent-home.ts). Readable and writable —
   * unlike cwd this is operator-declared rather than inferred from the launch dir.
   */
  agentHome?: string;
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
        return {
          allowed: false,
          reason: i18n.t('tools-builtins:pathPolicy.deniedPattern', { pattern: denied }),
          resolvedPath: resolved,
        };
      }
    }

    // 3. Check read/write roots
    const roots = this.getRootsForInput(input);

    if (roots.length === 0) {
      return {
        allowed: false,
        reason: i18n.t('tools-builtins:pathPolicy.noRootsConfigured', {
          operation: input.operation,
        }),
        resolvedPath: resolved,
      };
    }

    for (const root of roots) {
      if (isWithinRoot(resolved, root)) {
        return { allowed: true, resolvedPath: resolved };
      }
    }

    return {
      allowed: false,
      reason: i18n.t('tools-builtins:pathPolicy.outsideRoots', {
        resolved,
        operation: input.operation,
      }),
      resolvedPath: resolved,
    };
  }

  getEffectiveRoots(scope: { readRoots: string[]; writeRoots: string[] }): {
    readRoots: string[];
    writeRoots: string[];
  } {
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
    const normalizedScope = unique(scopedRoots.map((r) => normalizePath(r)));
    if (normalizedScope.length === 0) {
      return configuredRoots;
    }

    return normalizedScope.filter((scopeRoot) =>
      configuredRoots.some((configuredRoot) => isWithinRoot(scopeRoot, configuredRoot)),
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
  const resolvedReadRoots = (config.readRoots ?? []).map((r) => normalizePath(r));
  const resolvedWriteRoots = (config.writeRoots ?? []).map((w) => normalizePath(w));

  if (config.autoInjectCwd) {
    // Read only — see PathAccessPolicyConfig.autoInjectCwd.
    const cwd = normalizePath(process.cwd());
    if (!resolvedReadRoots.includes(cwd)) resolvedReadRoots.push(cwd);
  }

  if (config.agentHome) {
    const home = normalizePath(config.agentHome);
    if (!resolvedReadRoots.includes(home)) resolvedReadRoots.push(home);
    if (!resolvedWriteRoots.includes(home)) resolvedWriteRoots.push(home);
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
  // Shared implementation (also used by the file tools) — handles bare `~`,
  // `~/...` and leaves `~name` untouched.
  return expandHomePath(input);
}

function normalizePath(input: string, operation?: 'read' | 'write'): string {
  const resolved = path.resolve(expandHome(input));
  if (operation !== 'write') {
    return normalizeExistingPath(resolved);
  }
  return normalizeWritePath(resolved);
}

function normalizeExistingPath(input: string): string {
  // Kernel-style symlink resolution (same semantics as the shell policy):
  // fs.realpathSync collapses `..` string-wise after following a symlink,
  // which mis-evaluates escape attempts like <root>/link/../target where
  // link points elsewhere. resolveSymlinks handles non-existent components
  // by appending them verbatim after the deepest existing prefix.
  try {
    return resolveSymlinks(input);
  } catch {
    return input;
  }
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
  return missingParts.length === 0 ? realExisting : path.join(realExisting, ...missingParts);
}

function matchesDeniedPattern(resolvedPath: string, pattern: string): boolean {
  const expanded = expandHome(pattern);
  const normalizedPattern =
    path.isAbsolute(expanded) && !expanded.includes('*') ? normalizePath(expanded) : expanded;

  if (path.isAbsolute(normalizedPattern) && !normalizedPattern.includes('*')) {
    return isWithinRoot(resolvedPath, normalizedPattern);
  }

  // Deny matching fails safe by widening — see src/shared/glob.ts.
  return isDeniedByPattern(resolvedPath, path.basename(resolvedPath), normalizedPattern);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
