/**
 * electron-rebuild helper script.
 * Called from desktop/package.json postinstall hook.
 * Recompiles native Node.js addons against Electron's Node ABI.
 */
const { execSync } = require('node:child_process');
const path = require('node:path');

const desktopDir = path.resolve(__dirname, '..', 'desktop');

const nativeModules = [
  'better-sqlite3',
  'sqlite-vec',
  'sharp',
  '@nut-tree-fork/nut-js',
].join(',');

console.log('[electron-rebuild] Rebuilding native modules for Electron ABI...');
console.log('[electron-rebuild] Modules:', nativeModules);

try {
  execSync(
    `npx electron-rebuild -f -w ${nativeModules}`,
    { cwd: desktopDir, stdio: 'inherit' }
  );
  console.log('[electron-rebuild] Done — all native modules rebuilt successfully.');
} catch (err) {
  console.warn(
    '[electron-rebuild] WARNING: Some native modules failed to rebuild.',
    'This may be non-fatal if prebuilt binaries match the Electron ABI.',
    'Error:', err.message
  );
}
