/**
 * electron-rebuild helper script.
 * Called from desktop/package.json postinstall hook.
 * Recompiles native Node.js addons against Electron's Node ABI.
 *
 * On macOS (darwin), also creates universal (arm64+x64) binaries
 * for compatibility with both Apple Silicon and Intel Macs.
 */
const { execSync } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');

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

// On macOS, also make native addons universal (arm64 + x64)
// so the DMG works on both Apple Silicon and Intel Macs.
if (os.platform() === 'darwin') {
  console.log('[electron-rebuild] macOS detected — creating universal addons...');
  try {
    execSync(
      'node scripts/make-universal-addons.cjs',
      { cwd: desktopDir, stdio: 'inherit' }
    );
  } catch (err) {
    console.warn(
      '[electron-rebuild] WARNING: make-universal-addons failed.',
      'The DMG will work on arm64 but NOT on Intel Macs.',
      'Error:', err.message
    );
  }
}
