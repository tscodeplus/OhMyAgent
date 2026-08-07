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
const STAGING = path.join(DESKTOP, '.sidecar-deps');
const STAGING_NM = path.join(STAGING, 'node_modules');

// Native .node addons that must be present (and Node-ABI) in the staging tree.
// Under the Tauri sidecar layout the gateway runs on the bundled Node runtime,
// so plain Node prebuilds (from pnpm install on the build machine) are correct
// — no electron-rebuild / install-app-deps step anymore.
const NATIVE_ADDONS = [
  'better-sqlite3',
  'sqlite-vec',
  'sharp',
  '@nut-tree-fork/nut-js',
];

/** Recursively find native binaries (.node / .so / .dll / .dylib) under a directory. */
function findNativeFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/(\.node|\.so|\.dll|\.dylib)$/.test(entry.name)) out.push(full);
    }
  };
  walk(dir);
  return out;
}

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
  // Browser-only builds: Node's exports/main resolution never activates the
  // "browser" condition, and the packages below were verified to not use a
  // browser file as main. See PACKAGE_SUBPATH_SKIPS for package-scoped cuts.
  /^browser\.js$/,
  /^browser\.mjs$/,
  /^browser\.cjs$/,
  /^browser\//,
  // NOTE: Do NOT add a blanket /^deps\// rule here.
  // Some packages (e.g. @fastify/busboy) vendor runtime JS inside deps/
  // (like deps/dicer/). Skipping deps/ would break those at runtime.
  // C/C++ sources inside deps/ are already caught by the extension rules below.
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
  // WASM fallback runtimes — only needed when native .node binaries are
  // unavailable. On Windows x64 (our target), all native addons compile
  // and work fine, making these dead weight.
  '@emnapi/core',
  '@emnapi/runtime',
  '@napi-rs/wasm-runtime',
  '@tybys/wasm-util',
  // Build-time C++ headers — required for node-gyp compilation only.
  // Not needed at runtime once native modules are compiled.
  'node-addon-api',
]);

// Package-scoped subpath cuts — subdirectories/files inside a package that
// are never reachable at runtime. Verified against each package's
// exports/main resolution: the kept entry point is what Node resolves.
const PACKAGE_SUBPATH_SKIPS = {
  // main=./lib/index.js (CJS) — the es/ ESM build is never resolved.
  '@larksuiteoapi/node-sdk': ['es'],
  // "." resolves to dist/node/index.mjs under Node's "node" condition;
  // dist/web/ and the top-level bundles serve bundlers/browsers only.
  '@google/genai': ['dist/web', 'dist/index.cjs', 'dist/index.mjs'],
  // main=dist/index.js — browser/ is the bundler build.
  'jimp': ['browser'],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg) {
  process.stdout.write(`  ${msg}\n`);
}

/**
 * Check if a package is a platform-specific native binary for the WRONG platform.
 * Many packages (e.g. sharp via @img/sharp-*) ship optional dependencies for
 * every OS+arch combination. We only need the current target platform's binaries
 * — the rest are dead weight that can easily add 200+ MB to the installer.
 */
// Target platform for native binary pruning. Default: win32-x64 (desktop main
// release); CI (macOS runners, Linux) overrides via OMA_TARGET_PLATFORM
// (e.g. darwin-arm64, darwin-x64, linux-x64).
const TARGET_PLATFORM = process.env.OMA_TARGET_PLATFORM || 'win32-x64';
const [TARGET_OS, TARGET_ARCH] = TARGET_PLATFORM.split('-');

function isWrongPlatformBinary(pkgName) {
  // @img/sharp-* packages: keep only colour (shared) + the target platform variant
  if (pkgName.startsWith('@img/sharp-') || pkgName.startsWith('@img/sharp-libvips-')) {
    if (pkgName === '@img/colour') return false;
    const keepPrefix = `@img/sharp-${TARGET_OS}-${TARGET_ARCH}`;
    if (!pkgName.startsWith(keepPrefix)) return true;
  }

  // @node-rs/jieba-*: Chinese text segmentation with per-platform native binaries.
  // Keep only the target platform variant.
  if (pkgName.startsWith('@node-rs/jieba-')) {
    const keepPrefix = `@node-rs/jieba-${TARGET_OS}-${TARGET_ARCH}-`;
    if (!pkgName.startsWith(keepPrefix)) return true;
  }

  // sqlite-vec-*: platform packages (note: "windows" not "win32" in the name).
  if (pkgName.startsWith('sqlite-vec-')) {
    const sqliteOs = TARGET_OS === 'win32' ? 'windows' : TARGET_OS;
    const keep = `sqlite-vec-${sqliteOs}-${TARGET_ARCH}`;
    if (pkgName !== keep) return true;
  }

  return false;
}

function shouldSkip(relativePath) {
  // Always keep .node files (native addon binaries)
  if (relativePath.endsWith('.node')) return false;
  // Normalize to forward slashes — on Windows, path.join produces backslashes
  // but our SKIP_PATTERNS use forward slashes (cross-platform compatibility).
  const normalized = relativePath.replace(/\\/g, '/');
  for (const pattern of SKIP_PATTERNS) {
    if (pattern.test(normalized)) return true;
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

  // Note: the old trick of temporarily renaming pnpm-workspace.yaml to force
  // non-workspace `pnpm list` no longer works — pnpm v10 in non-workspace mode
  // resolves no deps at all for a pnpm-structured node_modules. Workspace-mode
  // listing is correct and also covers subdirectory members (desktop has no
  // prod deps anymore, so the root listing is what matters).
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

  // Skip platform-specific native binaries for the wrong platform
  if (isWrongPlatformBinary(pkgName)) {
    log(`  SKIP ${pkgName}@${pkgJson.version || '?'} (wrong-platform native binary)`);
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
  // Drop package-scoped unreachable subpaths (see PACKAGE_SUBPATH_SKIPS).
  const subpathSkips = PACKAGE_SUBPATH_SKIPS[pkgName];
  if (subpathSkips) {
    for (const sub of subpathSkips) {
      const victim = path.join(destPath, sub);
      if (fs.existsSync(victim)) {
        fs.rmSync(victim, { recursive: true, force: true });
        log(`  ✂ ${pkgName}/${sub} (unreachable at runtime)`);
      }
    }
  }
  log(`  ${pkgName}@${pkgJson.version || '?'}`);
}

/**
 * Copy the compiled server dist to the staging dir, dropping dev-only
 * artifacts. ONLY *.map and *.d.ts are removed — .ts sources are KEPT
 * because the Bedrock lazy loader (bedrock-converse-stream.lazy.js) and the
 * extension loader import .ts paths at runtime; .md files (built-in skill
 * prompts) are read by the skills system.
 */
function copyPrunedServerDist(src, dest) {
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(d, { recursive: true });
      copyPrunedServerDist(s, d);
    } else if (/\.(map|d\.ts)$/.test(entry.name)) {
      continue; // dev-only artifacts
    } else {
      fs.copyFileSync(s, d);
    }
  }
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
  // Clear staging subdirs but keep `.sidecar-deps/runtime` (bundled Node
  // runtime, fetched separately — wiping it would force a re-download).
  fs.rmSync(path.join(STAGING, 'node_modules'), { recursive: true, force: true });
  fs.rmSync(path.join(STAGING, 'root'), { recursive: true, force: true });
  fs.mkdirSync(STAGING_NM, { recursive: true });

  // 2. Collect pnpm dependencies from root project
  const rootDeps = collectPnpmDeps(ROOT);
  log(`Found ${rootDeps.size} unique packages in root dependency tree`);
  log('');

  // 3. Collect pnpm dependencies from desktop project (electron-store, electron-updater, etc.)
  const desktopDeps = collectPnpmDeps(DESKTOP);
  log(`Found ${desktopDeps.size} unique packages in desktop dependency tree`);
  log('');

  // 3b. Backfill desktop deps that were hoisted to root node_modules by workspace.
  // When workspace mode is disabled during pnpm list, packages that pnpm hoisted
  // to the root (e.g. ws) are invisible to the desktop collectPnpmDeps call.
  // Walk desktop's package.json dependencies and check root node_modules for any
  // that are missing from the collected set.
  log('Backfilling workspace-hoisted desktop deps from root node_modules...');
  const rootNm = path.join(ROOT, 'node_modules');
  const desktopPkgJsonPath = path.join(DESKTOP, 'package.json');
  if (fs.existsSync(desktopPkgJsonPath) && fs.existsSync(rootNm)) {
    let desktopPkg;
    try { desktopPkg = JSON.parse(fs.readFileSync(desktopPkgJsonPath, 'utf8')); } catch { desktopPkg = {}; }
    const desktopProdDeps = { ...desktopPkg.dependencies };
    let backfilled = 0;
    for (const depName of Object.keys(desktopProdDeps)) {
      // Check if already collected
      const alreadyCollected = [...desktopDeps.values()].some(d => d.name === depName)
        || [...rootDeps.values()].some(d => d.name === depName);
      if (alreadyCollected) continue;
      // Look in root node_modules (workspace-hoisted location)
      const rootDepPath = path.join(rootNm, depName);
      if (fs.existsSync(path.join(rootDepPath, 'package.json'))) {
        desktopDeps.set(rootDepPath, { name: depName, version: desktopProdDeps[depName] });
        backfilled++;
        log(`  ✓ ${depName} (from root node_modules)`);
      }
    }
    if (backfilled > 0) log(`Backfilled ${backfilled} hoisted desktop dep(s)`);
  }

  // Merge both (desktop wins on conflict)
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

  // 5. Verify native addons are present (Node ABI — pnpm prebuilds on the
  // build machine, matching the bundled Node runtime major version).
  // Note: sqlite-vec ships vec0.so/.dll/.dylib in a platform package;
  // sharp ships .node in @img/sharp-<os>-<arch>; better-sqlite3 and nut-js
  // keep .node in their main package.
  log('');
  log('Verifying native addons (Node ABI)...');
  for (const addonName of NATIVE_ADDONS) {
    let searchDirs;
    if (addonName === 'sqlite-vec') {
      const sqliteOs = TARGET_OS === 'win32' ? 'windows' : TARGET_OS;
      searchDirs = [path.join(STAGING_NM, `sqlite-vec-${sqliteOs}-${TARGET_ARCH}`)];
    } else if (addonName === 'sharp') {
      searchDirs = [path.join(STAGING_NM, '@img', `sharp-${TARGET_OS}-${TARGET_ARCH}`)];
    } else if (addonName === '@nut-tree-fork/nut-js') {
      searchDirs = [path.join(STAGING_NM, '@nut-tree-fork', `libnut-${TARGET_OS}`)];
    } else {
      searchDirs = [path.join(STAGING_NM, addonName)];
    }
    const nativeFiles = searchDirs.flatMap(findNativeFiles);
    if (nativeFiles.length === 0) {
      log(`  ✗ ${addonName}: no native files found in staging!`);
      log('    (build machine Node major must match the bundled node runtime — see .node-version)');
      process.exit(1);
    }
    log(`  ✓ ${addonName} (${nativeFiles.length} native file(s))`);
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

  // 6c. Pruned server-dist for the sidecar. tauri.conf.json maps
  // sidecar/server-dist from here (not from root dist/), so source maps and
  // .d.ts never reach the installer. .ts sources and .md skill prompts are
  // intentionally kept (runtime-imported, see copyPrunedServerDist).
  log('');
  log('Pruning server-dist (dropping *.map / *.d.ts)...');
  const SERVER_DIST = path.join(STAGING, 'server-dist');
  fs.rmSync(SERVER_DIST, { recursive: true, force: true });
  fs.mkdirSync(SERVER_DIST, { recursive: true });
  copyPrunedServerDist(path.join(ROOT, 'dist'), SERVER_DIST);
  const serverDistBytes = fs.readdirSync(SERVER_DIST, { recursive: true })
    .filter((f) => fs.statSync(path.join(SERVER_DIST, f)).isFile())
    .reduce((sum, f) => sum + fs.statSync(path.join(SERVER_DIST, f)).size, 0);
  log(`  server-dist staged: ${(serverDistBytes / 1048576).toFixed(1)} MB (source maps + .d.ts removed)`);

  // 7. Report stats
  const count = fs.readdirSync(STAGING_NM).length;
  log('');
  log(`✅ Staging complete: ${count} packages in ${STAGING_NM}`);
  log('');
}

main();
