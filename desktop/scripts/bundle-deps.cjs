/**
 * bundle-deps.cjs — Prepare flat node_modules for Electron packaging.
 *
 * Problem: pnpm's node_modules uses symlinks to a content-addressable store
 * (.pnpm/<name>@<ver>/node_modules/<name>/). electron-builder follows these
 * symlinks when copying extraResources, resulting in .pnpm/* paths that
 * Node.js module resolution cannot find at runtime.
 *
 * Solution:
 *   1. Walk pnpm's dependency tree to get every package's actual path
 *   2. Copy each package into a flat staging node_modules/
 *   3. Override native addons with Electron-ABI-rebuilt versions from
 *      desktop/node_modules/ (prepared by electron-builder install-app-deps)
 *
 * Usage: node scripts/bundle-deps.cjs
 * Run from: desktop/ directory
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, '../..');
const DESKTOP = path.resolve(__dirname, '..');
const STAGING = path.join(DESKTOP, '.electron-deps');
const STAGING_NM = path.join(STAGING, 'node_modules');

// These packages contain native .node addons that MUST be the Electron-ABI
// versions from desktop/node_modules/ (rebuilt by electron-builder install-app-deps)
const NATIVE_ADDONS = [
  'better-sqlite3',
  'sqlite-vec',
  'sharp',
  '@nut-tree-fork/nut-js',
];

// Patterns to skip — dev-only files that bloat the package
const SKIP_PATTERNS = [
  /\.d\.ts$/,           // TypeScript declarations
  /\.map$/,             // source maps
  /\.ts$/,              // TypeScript sources (except .d.ts above)
  /^docs?\//,           // documentation dirs
  /^examples?\//,       // example dirs
  /^tests?\//,          // test dirs
  /^__tests__\//,       // jest test dirs
  /^\.git/,             // git metadata
  /^\.github\//,        // github configs
  /^\.npmignore/,       // npm metadata
  /^\.eslintrc/,        // lint configs
  /^benchmarks?\//,     // benchmark dirs
  /^Makefile/,          // build files
  /^CMakeLists\.txt/,   // cmake files
  /^binding\.gyp/,      // node-gyp files
  /\.mdx?$/,            // markdown files
  /^LICEN[S]E/,         // license files
  /^CHANGELOG/i,        // changelog files
  /^CODE_OF_CONDUCT/i,  // code of conduct
  /^SECURITY\.md/i,     // security policy
  /^CONTRIBUTING/i,     // contributing guides
  /^\.prettierrc/,      // prettier config
  /^\.circleci\//,      // CI config
  /^\.github\//,        // github templates
  /\.cc?$/,             // C/C++ source (only needed for node-gyp)
  /\.cpp$/,             // C++ source
  /\.c$/,               // C source
  /\.h(pp)?$/,          // C/C++ headers
  /^deps\//,            // SQLite amalgamation / native library sources
];

// Well-known dev-only packages that should NEVER appear in production bundles.
// These can get pulled in via peer dependencies (e.g. i18next → typescript)
// even when using pnpm list --prod.
const SKIP_PACKAGES = new Set([
  'typescript',
  'tsx',
  'tsc-alias',
  'vite',
  'vitest',
  'tailwindcss',
  '@tailwindcss/vite',
  '@vitejs/plugin-react',
  'eslint',
  'prettier',
  '@types/node',
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg) {
  process.stdout.write(`  ${msg}\n`);
}

function shouldSkip(relativePath) {
  // Always keep .node files (native addon binaries)
  if (relativePath.endsWith('.node')) return false;
  for (const pattern of SKIP_PATTERNS) {
    if (pattern.test(relativePath)) return true;
  }
  return false;
}

function copyDir(src, dest, basePath) {
  // Handle broken symlinks (e.g. optional platform deps not installed)
  let stat;
  try {
    stat = fs.lstatSync(src);
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  if (stat.isSymbolicLink()) {
    try {
      const realPath = fs.realpathSync(src);
      if (fs.statSync(realPath).isDirectory()) {
        return copyDir(realPath, dest, basePath);
      }
    } catch {
      // Broken symlink — skip silently
      return;
    }
  }

  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  let entries;
  try {
    entries = fs.readdirSync(src, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const relativePath = basePath ? path.join(basePath, entry.name) : entry.name;

    if (shouldSkip(relativePath)) continue;

    if (entry.isSymbolicLink()) {
      // Follow symlinks: copy the actual content (pnpm style)
      try {
        const realPath = fs.realpathSync(srcPath);
        const stat = fs.statSync(realPath);
        if (stat.isDirectory()) {
          copyDir(realPath, path.join(dest, entry.name), relativePath);
        } else {
          fs.copyFileSync(realPath, path.join(dest, entry.name));
        }
      } catch (err) {
        // Broken symlink or permission error — skip
        log(`WARN: skipping symlink ${relativePath}: ${err.message}`);
      }
    } else if (entry.isDirectory()) {
      copyDir(srcPath, path.join(dest, entry.name), relativePath);
    } else {
      fs.copyFileSync(srcPath, path.join(dest, entry.name));
    }
  }
}

/**
 * Collect all unique packages from pnpm's dependency tree.
 * Returns Map<packageName, { name, version, path, isNative }>
 */
function collectPnpmDeps(projectDir) {
  log(`Scanning pnpm dependency tree in ${projectDir}...`);

  let output;
  try {
    // depth=20 is sufficient for any realistic dependency tree.
    // depth=100 produces enormous JSON (100+ MB) that can exceed maxBuffer
    // and cause JSON.parse to fail on truncated output (pnpm v10+).
    output = execSync('pnpm list --prod --json --depth=20', {
      cwd: projectDir,
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
    });
  } catch (err) {
    // pnpm list may exit non-zero but still output valid JSON
    output = err.stdout || '';
    if (!output.trim()) {
      throw new Error(`pnpm list failed: ${err.message}`);
    }
  }

  let tree;
  try {
    tree = JSON.parse(output);
  } catch {
    // pnpm sometimes outputs to stderr instead
    if (!output.trim()) {
      throw new Error('pnpm list produced no output — is pnpm install run?');
    }
    throw new Error(`Failed to parse pnpm list output: ${output.slice(0, 500)}`);
  }

  const seen = new Map(); // path -> { name, version }
  const walk = (deps) => {
    if (!deps) return;
    for (const [name, info] of Object.entries(deps)) {
      if (!info || typeof info !== 'object') continue;
      if (info.path && !seen.has(info.path)) {
        seen.set(info.path, {
          name: name,
          version: info.version || 'unknown',
        });
      }
      if (info.dependencies) {
        walk(info.dependencies);
      }
    }
  };

  // tree is an array — walk each root item
  if (Array.isArray(tree)) {
    for (const item of tree) {
      if (item.dependencies) walk(item.dependencies);
    }
  }

  return seen;
}

/**
 * Copy a single package from its pnpm path to the staging directory.
 * If the staging already has a package with the same name, prefer the
 * newer version (or the one with native files from desktop/node_modules).
 */
function copyPnpmPkg(pkgPath, destBase, isNativeOverride = false) {
  const pkgJsonPath = path.join(pkgPath, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) {
    // Not a proper package — copy anyway as-is
    const name = path.basename(pkgPath);
    copyDir(pkgPath, path.join(destBase, name), '');
    return;
  }

  let pkgJson;
  try {
    pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
  } catch {
    pkgJson = {};
  }

  const pkgName = pkgJson.name || path.basename(pkgPath);

  // Skip well-known dev-only packages
  if (SKIP_PACKAGES.has(pkgName)) {
    log(`  SKIP ${pkgName}@${pkgJson.version || '?'} (dev-only)`);
    return;
  }

  const destPath = path.join(destBase, pkgName);

  // If staging already has this package, check versions
  const existingPkgJsonPath = path.join(destPath, 'package.json');
  if (fs.existsSync(existingPkgJsonPath) && !isNativeOverride) {
    try {
      const existing = JSON.parse(fs.readFileSync(existingPkgJsonPath, 'utf8'));
      // Keep the newer version
      if (existing.version && pkgJson.version) {
        const cmp = existing.version.localeCompare(pkgJson.version, undefined, { numeric: true });
        if (cmp >= 0) return; // existing is same or newer, skip
      }
    } catch { /* ignore, overwrite */ }
  }

  // Copy
  copyDir(pkgPath, destPath, '');
  log(`  ${pkgName}@${pkgJson.version || '?'}`);
}

/**
 * For packages whose dependencies require a different major version than what
 * ended up in the flat node_modules, copy the correct version into a nested
 * node_modules directory under that package.
 *
 * Example: lazystream depends on readable-stream@^2 but the flat directory
 * has readable-stream@4. We create lazystream/node_modules/readable-stream/
 * with the v2 content so Node.js resolves it correctly.
 */
function fixNestedDeps(allDeps) {
  // Index: packageName → [{version, pkgPath}]
  const byName = new Map();
  for (const [pkgPath, info] of allDeps) {
    const list = byName.get(info.name) || [];
    list.push({ version: info.version, pkgPath, name: info.name });
    byName.set(info.name, list);
  }

  // Sort each list by version descending
  for (const list of byName.values()) {
    list.sort((a, b) =>
      b.version.localeCompare(a.version, undefined, { numeric: true })
    );
  }

  // Iterate over packages in the staging directory
  const entries = fs.readdirSync(STAGING_NM, { withFileTypes: true });
  let fixedCount = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pkgDir = path.join(STAGING_NM, entry.name);
    const pkgJsonPath = path.join(pkgDir, 'package.json');
    if (!fs.existsSync(pkgJsonPath)) continue;

    let pkgJson;
    try {
      pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    } catch {
      continue;
    }

    const deps = { ...pkgJson.dependencies, ...pkgJson.peerDependencies };
    if (!deps || Object.keys(deps).length === 0) continue;

    for (const [depName, depRange] of Object.entries(deps)) {
      // Skip optional/peer deps that start with @types
      if (depName.startsWith('@types/')) continue;

      const flatDepDir = path.join(STAGING_NM, depName);
      const flatPkgJsonPath = path.join(flatDepDir, 'package.json');
      if (!fs.existsSync(flatPkgJsonPath)) continue;

      let flatVersion;
      try {
        flatVersion = JSON.parse(fs.readFileSync(flatPkgJsonPath, 'utf8')).version;
      } catch {
        continue;
      }

      // Simple semver check: if major versions differ, the dep needs its own copy
      if (!needsNestedDep(flatVersion, depRange)) continue;

      // Find the correct version from the pnpm tree
      const candidates = byName.get(depName) || [];
      const match = candidates.find((c) => satisfiesMajor(c.version, depRange));
      if (!match) continue;

      // Skip if already has nested node_modules with this dep
      const nestedDir = path.join(pkgDir, 'node_modules', depName);
      if (fs.existsSync(nestedDir)) continue;

      // Copy the correct version
      fs.mkdirSync(path.dirname(nestedDir), { recursive: true });
      copyDir(match.pkgPath, nestedDir, '');
      fixedCount++;
      log(`  ${entry.name} → ${depName}@${match.version} (flat has ${flatVersion}, needs ${depRange})`);
    }
  }

  if (fixedCount > 0) {
    log(`Fixed ${fixedCount} version conflict(s) with nested node_modules`);
  }
}

/**
 * Check if a version satisfies a semver range (simplified: only checks major version).
 */
function needsNestedDep(version, range) {
  const verMajor = parseInt(version.split('.')[0], 10);
  const clean = range.replace(/^[~^>=<]+/, '');
  const rangeMajor = parseInt(clean.split('.')[0], 10);
  return verMajor !== rangeMajor;
}

/**
 * Check if a version's major matches the range's major.
 */
function satisfiesMajor(version, range) {
  const verMajor = parseInt(version.split('.')[0], 10);
  const clean = range.replace(/^[~^>=<]+/, '');
  const rangeMajor = parseInt(clean.split('.')[0], 10);
  return verMajor === rangeMajor;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  log('');
  log('📦 Preparing flat node_modules for Electron packaging...');
  log('');

  // 1. Clean and recreate staging
  fs.rmSync(STAGING, { recursive: true, force: true });
  fs.mkdirSync(STAGING_NM, { recursive: true });

  // 2. Collect pnpm dependencies from root project
  const rootDeps = collectPnpmDeps(ROOT);
  log(`Found ${rootDeps.size} unique packages in root dependency tree`);
  log('');

  // 3. Collect pnpm dependencies from desktop project (electron-store, electron-updater, etc.)
  const desktopDeps = collectPnpmDeps(DESKTOP);
  log(`Found ${desktopDeps.size} unique packages in desktop dependency tree`);
  log('');

  // Merge both (desktop wins on conflict — has Electron-ABI versions of native addons)
  const allDeps = new Map(rootDeps);
  for (const [pkgPath, info] of desktopDeps) {
    allDeps.set(pkgPath, info);
  }
  log(`Total unique packages (merged): ${allDeps.size}`);
  log('');

  // 4. Copy all packages to staging
  log('Copying packages from pnpm node_modules...');
  for (const [pkgPath, { name }] of allDeps) {
    copyPnpmPkg(pkgPath, STAGING_NM);
  }

  // 5. Override native addons with Electron-ABI versions from desktop/node_modules
  const desktopNm = path.join(DESKTOP, 'node_modules');
  if (fs.existsSync(desktopNm)) {
    log('');
    log('Overriding native addons with Electron ABI versions...');
    for (const addonName of NATIVE_ADDONS) {
      const desktopAddonPath = path.join(desktopNm, addonName);
      if (fs.existsSync(desktopAddonPath)) {
        // Remove existing (pnpm version) and copy desktop version
        const destAddonPath = path.join(STAGING_NM, addonName);
        fs.rmSync(destAddonPath, { recursive: true, force: true });
        copyDir(desktopAddonPath, destAddonPath, '');
        log(`  ✓ ${addonName} (Electron ABI)`);
      } else {
        log(`  ⚠ ${addonName}: not found in desktop/node_modules — using pnpm version`);
      }
    }
  }

  // 6. Fix nested dependencies for version conflicts
  // When pkg A depends on dep@^1 but flat node_modules has dep@2, Node.js
  // resolution fails. Copy the correct version into A/node_modules/dep/.
  log('');
  log('Fixing nested dependencies for version conflicts...');
  fixNestedDeps(allDeps);

  // 6b. Create synthetic @earendil-works packages for pi-mono.
  // pi-mono is embedded as source (not an npm dependency) and mapped via
  // tsconfig paths. Compiled JS still has `import ... from '@earendil-works/pi-ai'`
  // which Node.js can't resolve without a real package. Create minimal packages
  // that re-export from the server-dist copy.
  log('');
  log('Creating pi-mono synthetic packages...');
  const PI_MONO_PACKAGES = [
    { name: 'pi-ai', reexport: '../../../server-dist/src/pi-mono/ai/index.js' },
    { name: 'pi-agent-core', reexport: '../../../server-dist/src/pi-mono/agent/index.js' },
  ];
  for (const pkg of PI_MONO_PACKAGES) {
    const pkgDir = path.join(STAGING_NM, '@earendil-works', pkg.name);
    fs.mkdirSync(pkgDir, { recursive: true });
    // Use a simple re-export wrapper: Node.js resolves the relative path
    // from node_modules/@earendil-works/<name>/ back to server-dist/
    fs.writeFileSync(path.join(pkgDir, 'index.js'),
      `module.exports = require(${JSON.stringify(pkg.reexport)});\n`);
    fs.writeFileSync(path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: `@earendil-works/${pkg.name}`, main: 'index.js' }));
    log(`  ✓ @earendil-works/${pkg.name}`);
  }

  // 7. Report stats
  const count = fs.readdirSync(STAGING_NM).length;
  log('');
  log(`✅ Staging complete: ${count} packages in ${STAGING_NM}`);
  log('');
}

main();
