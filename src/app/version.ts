/**
 * Cached application version.
 *
 * Read once at first call and cache — prevents the reported version from
 * changing mid-process when an in-flight update rewrites package.json before
 * the service is rebuilt/restarted.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let cachedVersion: string | undefined;

function findProjectRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export function getAppVersion(): string | undefined {
  if (cachedVersion !== undefined) return cachedVersion;
  try {
    const pkgPath = path.join(findProjectRoot(), 'package.json');
    cachedVersion = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version as string;
  } catch {
    cachedVersion = ''; // don't retry on failure
  }
  return cachedVersion || undefined;
}

/** Only for testing — reset the cached version. */
export function resetAppVersion(): void {
  cachedVersion = undefined;
}

// ── Semantic version comparison ──────────────────────────────────────────
// Beta-aware: v2.0.0 > v2.0.0-beta, v2.0.0-beta < v2.0.0-beta2,
// v2.0.0-beta > v1.2.3 (compare core versions first).

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  isBeta: boolean;
  betaNum: number; // 0 = not beta; 1 = beta/beta1; 2 = beta2; ...
}

function parseVersion(version: string): ParsedVersion {
  // Strip leading 'v' or 'V'
  let v = version.replace(/^[vV]/, '');

  // Split into core + prerelease at the first non-numeric, non-dot char
  const prereleaseIdx = v.search(/[^0-9.]/);
  let core = v;
  let prerelease = '';
  if (prereleaseIdx !== -1) {
    core = v.slice(0, prereleaseIdx);
    prerelease = v.slice(prereleaseIdx).replace(/^[.-]/, '');
  }

  const parts = core.split('.');
  const major = parseInt(parts[0] || '0', 10);
  const minor = parseInt(parts[1] || '0', 10);
  const patch = parseInt(parts[2] || '0', 10);

  // Detect beta: "beta" without number = beta1, "beta2" = beta2, etc.
  const betaMatch = prerelease.match(/beta(\d*)/i);
  const isBeta = betaMatch !== null;
  const betaNum = isBeta ? (betaMatch![1] ? parseInt(betaMatch![1], 10) : 1) : 0;

  return { major, minor, patch, isBeta, betaNum };
}

/**
 * Compare two version strings semantically.
 * Returns negative if a < b, 0 if equal, positive if a > b.
 *
 * Rules:
 *   1. Compare major.minor.patch numerically.
 *   2. If core versions differ, the higher core wins (regardless of beta).
 *   3. If core versions are equal: stable > beta, beta1 < beta2, etc.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);

  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;

  // Core versions equal — compare beta status
  if (!pa.isBeta && pb.isBeta) return 1;  // a is stable, b is beta → a > b
  if (pa.isBeta && !pb.isBeta) return -1; // a is beta, b is stable → a < b
  if (pa.isBeta && pb.isBeta) return pa.betaNum - pb.betaNum; // higher beta number wins

  return 0;
}

/**
 * Returns true when `latest` is a newer version than `current`.
 */
export function isNewerVersion(current: string, latest: string): boolean {
  return compareVersions(current, latest) < 0;
}
