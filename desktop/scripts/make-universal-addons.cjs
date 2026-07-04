/**
 * make-universal-addons.cjs — Create universal (fat) native addon binaries for macOS.
 *
 * Problem: On Apple Silicon, electron-rebuild only compiles native addons for the
 * host architecture (arm64). When electron-builder packages a universal DMG
 * (arch: [x64, arm64]), the Electron binary is universal but the native .node
 * files are arm64-only — causing "incompatible architecture" errors on Intel Macs.
 *
 * Solution:
 *   1. Save the arm64 .node files (built by electron-builder install-app-deps)
 *   2. Cross-compile the same addons for x64
 *   3. Use lipo -create to squash both slices into a single fat binary
 *
 * Only runs on macOS (darwin). On other platforms, exits immediately.
 *
 * Usage: node scripts/make-universal-addons.cjs
 * Run from: desktop/ directory
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DESKTOP = path.resolve(__dirname, '..');
const DESKTOP_NM = path.join(DESKTOP, 'node_modules');

// Packages whose native .node files must be made universal
const NATIVE_ADDONS = [
  'better-sqlite3',
  'sqlite-vec',
  'sharp',
  '@nut-tree-fork/nut-js',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg) {
  process.stdout.write(`  ${msg}\n`);
}

/**
 * Recursively find all .node files under a directory.
 */
function findNodeFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        try {
          const stat = entry.isSymbolicLink() ? fs.statSync(fullPath) : null;
          if (stat && stat.isDirectory()) {
            results.push(...findNodeFiles(fullPath));
          } else if (entry.isDirectory()) {
            results.push(...findNodeFiles(fullPath));
          }
        } catch {
          // Broken symlink — skip
        }
      } else if (entry.name.endsWith('.node')) {
        results.push(fullPath);
      }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return results;
}

/**
 * Quick check: does this .node file already contain both slices?
 */
function isAlreadyUniversal(filePath) {
  try {
    const output = execSync(`lipo -info "${filePath}"`, { encoding: 'utf8' });
    return output.includes('x86_64') && output.includes('arm64');
  } catch {
    return false;
  }
}

/**
 * Get the architecture of a file via `lipo -info`.
 */
function fileArch(filePath) {
  try {
    return execSync(`lipo -info "${filePath}"`, { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  // Only relevant on macOS
  if (os.platform() !== 'darwin') {
    log('Not on macOS — skipping universal addon creation.');
    return;
  }

  // Verify lipo is available
  try {
    execSync('which lipo', { stdio: 'pipe' });
  } catch {
    log('WARNING: lipo not found — cannot create universal addons.');
    log('Install Xcode Command Line Tools: xcode-select --install');
    process.exit(1);
  }

  const tmpDir = path.join(DESKTOP, '.addon-arm64-backup');
  let madeUniversal = 0;
  let alreadyUniversal = 0;
  let failed = [];

  for (const addonName of NATIVE_ADDONS) {
    const addonPath = path.join(DESKTOP_NM, addonName);
    if (!fs.existsSync(addonPath)) {
      log(`SKIP ${addonName}: not found in desktop/node_modules/`);
      continue;
    }

    const arm64NodeFiles = findNodeFiles(addonPath);
    if (arm64NodeFiles.length === 0) {
      log(`SKIP ${addonName}: no .node files found`);
      continue;
    }

    // Check if already universal
    let allUniversal = true;
    for (const f of arm64NodeFiles) {
      if (!isAlreadyUniversal(f)) {
        allUniversal = false;
        break;
      }
    }
    if (allUniversal) {
      log(`OK ${addonName}: already universal (${arm64NodeFiles.length} .node file(s))`);
      alreadyUniversal++;
      continue;
    }

    // Show current architectures
    for (const f of arm64NodeFiles) {
      log(`  ${path.relative(DESKTOP, f)}: ${fileArch(f)}`);
    }

    // Step 1: Save arm64 binaries
    log(`  Saving arm64 .node files to ${path.relative(DESKTOP, tmpDir)}/`);
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    for (const f of arm64NodeFiles) {
      const rel = path.relative(addonPath, f);
      const dest = path.join(tmpDir, addonName, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(f, dest);
    }

    // Step 2: Cross-compile for x64
    log(`  Rebuilding ${addonName} for x64...`);
    try {
      execSync(`npx electron-rebuild -f -w ${addonName} --arch x64`, {
        cwd: DESKTOP,
        stdio: 'pipe',
        encoding: 'utf8',
        timeout: 300_000, // 5 minutes
        env: {
          ...process.env,
          npm_config_arch: 'x64',
          npm_config_target_arch: 'x64',
        },
      });
    } catch (err) {
      log(`  WARNING: x64 rebuild failed for ${addonName}: ${err.message.split('\n').slice(-3).join(' ')}`);
      log(`  The DMG will still work on arm64, but not on Intel Macs.`);
      failed.push({ addon: addonName, reason: 'x64 rebuild failed' });

      // Restore arm64 from backup
      for (const f of arm64NodeFiles) {
        const rel = path.relative(addonPath, f);
        const backup = path.join(tmpDir, addonName, rel);
        if (fs.existsSync(backup)) {
          // The x64 rebuild might have deleted/replaced the file — restore arm64
          try { fs.copyFileSync(backup, f); } catch {}
        }
      }
      continue;
    }

    // Step 3: Collect x64 .node files and lipo
    const x64NodeFiles = findNodeFiles(addonPath);
    let combined = 0;

    for (const f of x64NodeFiles) {
      const rel = path.relative(addonPath, f);
      const arm64Backup = path.join(tmpDir, addonName, rel);

      if (!fs.existsSync(arm64Backup)) {
        log(`  SKIP ${rel}: no arm64 backup (new file from x64 rebuild?)`);
        continue;
      }

      // Verify this is actually x64
      const fArch = fileArch(f);
      if (!fArch.includes('x86_64')) {
        log(`  SKIP ${rel}: not x64 after rebuild (${fArch})`);
        continue;
      }

      // Combine via lipo
      try {
        execSync(`lipo -create "${arm64Backup}" "${f}" -output "${f}.fat"`, { stdio: 'pipe' });
        const fatArch = fileArch(`${f}.fat`);
        if (fatArch.includes('arm64') && fatArch.includes('x86_64')) {
          // Replace the x64-only file with the fat binary
          fs.renameSync(`${f}.fat`, f);
          combined++;
        } else {
          log(`  WARNING: lipo output is not universal (${fatArch}), keeping arm64`);
          fs.unlinkSync(`${f}.fat`);
          // Restore arm64
          fs.copyFileSync(arm64Backup, f);
        }
      } catch (err) {
        log(`  WARNING: lipo failed for ${rel}: ${err.message}`);
        // Restore arm64
        try { fs.copyFileSync(arm64Backup, f); } catch {}
      }
    }

    if (combined > 0) {
      log(`  ✓ ${addonName}: ${combined} .node file(s) made universal`);
      madeUniversal++;
    } else {
      log(`  ⚠ ${addonName}: no .node files could be combined`);
      failed.push({ addon: addonName, reason: 'lipo combine produced no universal files' });
    }
  }

  // Cleanup
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // Report
  log('');
  log('========================================');
  log(` Universal addon summary:`);
  log(`   Already universal: ${alreadyUniversal}`);
  log(`   Made universal:    ${madeUniversal}`);
  log(`   Failed:            ${failed.length}`);
  if (failed.length > 0) {
    for (const f of failed) {
      log(`     ✗ ${f.addon}: ${f.reason}`);
    }
    log('');
    log('WARNING: Some native addons could not be made universal.');
    log('The DMG will work on Apple Silicon but NOT on Intel Macs.');
  }
  log('========================================');
  log('');
}

main();
