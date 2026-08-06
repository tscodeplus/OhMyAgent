// fetch-node.cjs — download the official Node runtime used as the sidecar
// (node.exe on Windows, `node` on macOS/Linux). The build machine's Node
// major MUST match the bundled runtime (see desktop/.node-version).
//
// Usage: node scripts/fetch-node.cjs [--platform win32-x64|darwin-x64|darwin-arm64]
//   default platform: win32-x64 (Windows desktop build)
//   env NODE_MIRROR overrides the download base (default npmmirror, falls
//   back to nodejs.org).

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DESKTOP = path.resolve(__dirname, '..');
const OUT_DIR = path.join(DESKTOP, '.sidecar-deps', 'runtime');

function nodeVersion() {
  const v = fs.readFileSync(path.join(DESKTOP, '.node-version'), 'utf8').trim();
  return v;
}

function platformKey() {
  const arg = process.argv.find((a) => a.startsWith('--platform='));
  if (arg) return arg.split('=')[1];
  if (process.env.OMA_TARGET_PLATFORM) return process.env.OMA_TARGET_PLATFORM;
  return 'win32-x64';
}

const PKG = {
  'win32-x64': {
    file: (v) => `node-v${v}-win-x64.zip`,
    out: (v) => 'node.exe',
    extract: (zip, dest) => unzip(zip, dest),
  },
  'darwin-x64': {
    file: (v) => `node-v${v}-darwin-x64.tar.gz`,
    out: (v) => 'node',
    extract: (tgz, dest) => untar(tgz, dest),
  },
  'darwin-arm64': {
    file: (v) => `node-v${v}-darwin-arm64.tar.gz`,
    out: (v) => 'node',
    extract: (tgz, dest) => untar(tgz, dest),
  },
  'linux-x64': {
    file: (v) => `node-v${v}-linux-x64.tar.gz`,
    out: (v) => 'node',
    extract: (tgz, dest) => untar(tgz, dest),
  },
};

function unzip(zip, dest) {
  // Node ≥ 20.18 can extract zip via zlib? No — use system unzip or PowerShell on Windows.
  if (process.platform === 'win32') {
    const ps = `Expand-Archive -Path '${zip}' -DestinationPath '${dest}' -Force`;
    const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('powershell Expand-Archive failed');
  } else {
    const r = spawnSync('unzip', ['-o', zip, '-d', dest], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('unzip failed');
  }
}

function untar(tgz, dest) {
  const r = spawnSync('tar', ['-xzf', tgz, '-C', dest], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('tar failed');
}

function main() {
  const version = nodeVersion();
  const key = platformKey();
  const pkg = PKG[key];
  if (!pkg) {
    console.error(`[fetch-node] unsupported platform: ${key}`);
    process.exit(1);
  }

  const destName = key === 'win32-x64' ? 'node.exe' : 'node';
  const dest = path.join(OUT_DIR, destName);
  // Cache: the bundled runtime only changes when .node-version changes —
  // skip the download+extract when the target binary already exists (each
  // build was re-downloading the ~27MB archive, the single biggest waste).
  if (fs.existsSync(dest)) {
    console.log(`[fetch-node] ✓ cached ${dest} (${(fs.statSync(dest).size / 1048576).toFixed(1)} MB)`);
    return;
  }

  const mirror = process.env.NODE_MIRROR || 'https://npmmirror.com/mirrors/node';
  const url = `${mirror}/v${version}/${pkg.file(version)}`;
  const archive = path.join(os.tmpdir(), pkg.file(version));
  const extractDir = path.join(os.tmpdir(), `oma-node-${key}-${version}`);
  fs.mkdirSync(extractDir, { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log(`[fetch-node] downloading ${url}`);
  const dl = spawnSync(
    process.platform === 'win32' ? 'curl.exe' : 'curl',
    ['-fL', '--retry', '3', '-o', archive, url],
    { stdio: 'inherit' },
  );
  if (dl.status !== 0) {
    console.error('[fetch-node] download failed — retry with NODE_MIRROR=https://nodejs.org/dist');
    process.exit(1);
  }

  pkg.extract(archive, extractDir);
  // Archive layout: win zip → node-v<v>-win-x64/node.exe; tarballs →
  // node-v<v>-<platform>/bin/node
  const platform = key.split('-')[0];
  const arch = key.split('-')[1];
  const candidates = key.startsWith('win')
    ? [
        path.join(extractDir, `node-v${version}-win-x64`, 'node.exe'),
        path.join(extractDir, 'node.exe'),
      ]
    : [
        path.join(extractDir, `node-v${version}-${platform}-${arch}`, 'bin', pkg.out(version)),
        path.join(extractDir, `node-v${version}`, 'bin', pkg.out(version)),
      ];
  const bin = candidates.find((c) => fs.existsSync(c));
  if (!bin) {
    console.error(`[fetch-node] binary not found under ${extractDir}`);
    process.exit(1);
  }
  fs.copyFileSync(bin, dest);
  if (process.platform !== 'win32') {
    fs.chmodSync(dest, 0o755);
  }
  console.log(`[fetch-node] ✓ ${dest} (${(fs.statSync(dest).size / 1048576).toFixed(1)} MB)`);
}

main();
