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
