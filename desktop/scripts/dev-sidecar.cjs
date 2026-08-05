// dev-sidecar.cjs — start the sidecar in dev mode (beforeDevCommand for
// `tauri dev`). Sets the dev environment, then runs `tsx watch` on the sidecar
// entry so server code changes hot-restart. Requires the root build first
// (`pnpm build`) — same as Electron dev, which imports dist/src/app/bootstrap.js.
//
// Dev ports/config (fixed, mirrored by compat.js fallback):
//   OMA_SIDECAR_CONTROL_PORT=9291, OMA_CONTROL_TOKEN=dev

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT_DIR = __dirname;
const DESKTOP_DIR = path.resolve(SCRIPT_DIR, '..');
const ROOT = path.resolve(DESKTOP_DIR, '..');

function dataDir() {
  if (process.env.OHMYAGENT_HOME) return process.env.OHMYAGENT_HOME;
  const base =
    process.platform === 'win32'
      ? process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
      : process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support')
        : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'OhMyAgent');
}

const rootDist = path.join(ROOT, 'dist');
if (!fs.existsSync(path.join(rootDist, 'src', 'app', 'bootstrap.js'))) {
  console.error('[dev-sidecar] root build missing — run `pnpm build` first');
  process.exit(1);
}

const env = {
  ...process.env,
  OMA_DEV: '1',
  OMA_RESOURCES_DIR: ROOT,
  OMA_SIDECAR_CONTROL_PORT: '9291',
  OMA_CONTROL_TOKEN: 'dev',
  OHMYAGENT_PORT: process.env.OHMYAGENT_PORT || '9191',
  OHMYAGENT_BIND_ADDRESS: '127.0.0.1',
  OHMYAGENT_HOME: dataDir(),
  OHMYAGENT_LOG_DIR: path.join(dataDir(), 'logs'),
  DATABASE_PATH: path.join(dataDir(), 'data', 'app.db'),
  CONFIG_FILE: path.join(dataDir(), 'config.yaml'),
  ELECTRON_RUN: '1',
  WEBUI_STATIC_ROOT: path.join(ROOT, 'ui', 'dist'),
  OMA_OS_LOCALE: process.env.LANG || 'en',
  OMA_APP_VERSION: require(path.join(DESKTOP_DIR, 'package.json')).version,
};

const tsxBin = process.platform === 'win32' ? 'tsx.cmd' : 'tsx';
const child = spawn(
  tsxBin,
  ['watch', path.join(DESKTOP_DIR, 'sidecar', 'src', 'index.ts')],
  { cwd: ROOT, env, stdio: 'inherit' }
);
child.on('exit', (code) => process.exit(code ?? 0));
