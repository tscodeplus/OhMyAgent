// OhMyAgent sidecar entry — runs the gateway server inside its own Node
// process, spawned by the Tauri shell. Replicates the former in-process
// bootstrap semantics of desktop/src/server-manager.ts:
//   · env already injected by the shell (OHMYAGENT_*, OMA_*)
//   · chdir to the server root so bootstrap's relative paths (extensions/,
//     skills/, config.yaml) resolve — same as server-manager.ts:155
//   · import dist bootstrap, call bootstrap().start()
//   · serve the control API + heartbeat until shutdown
//
// Dev mode (OMA_DEV=1, started by `pnpm dev:sidecar`): chdir to the repo root,
// import the root dist build — identical to Electron dev behavior.

import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

import {
  createControlServer,
  ensureDataDirs,
  startHeartbeat,
} from './control-server.js';

const isDev = process.env.OMA_DEV === '1';
const resourcesDir = process.env.OMA_RESOURCES_DIR ?? process.cwd();
const serverRoot = isDev ? resourcesDir : join(resourcesDir, 'server-dist');

// 1. CWD — bootstrap resolves extensions/, skills/, locales/, config.yaml
//    relative to process.cwd() (see server-manager.ts:155 comment).
process.chdir(serverRoot);
console.log(`[sidecar] cwd -> ${serverRoot} (dev=${isDev})`);

// 2. Data dirs (idempotent; prod shell also pre-creates them).
ensureDataDirs();

// 3. Import + start the gateway.
// Same path semantics as server-manager.ts:159-162: the .js path resolves to
// the dist build under Node (prod) and — via the tsx loader's .js→.ts
// extension fallback — to the TypeScript source under `tsx` (dev). No dev/prod
// branch needed.
const bootstrapPath = join(serverRoot, 'src/app/bootstrap.js');
let bootstrap: { bootstrap: () => Promise<BootstrapResult> };
try {
  bootstrap = (await import(pathToFileURL(bootstrapPath).href)) as {
    bootstrap: () => Promise<BootstrapResult>;
  };
} catch (err) {
  console.error('[sidecar] failed to import bootstrap:', err);
  process.exit(1);
}

interface BootstrapResult {
  services: unknown;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

const { services, start, stop } = await bootstrap.bootstrap();

// 4. Control API (before start() so shutdown is always reachable).
const controlPort = Number(process.env.OMA_SIDECAR_CONTROL_PORT ?? 9291);
const controlToken = process.env.OMA_CONTROL_TOKEN ?? 'dev';
const controlServer = createControlServer({ port: controlPort, token: controlToken, stop });

// 5. Start the gateway.
try {
  await start();
  const port = process.env.OHMYAGENT_PORT ?? '9191';
  console.log(`[sidecar] gateway started on 127.0.0.1:${port} (control api :${controlPort})`);
} catch (err) {
  console.error('[sidecar] gateway start failed:', err);
  process.exit(1);
}

// 5b. Bridge follows the gateway config (remote mode → connect, local → idle).
const bridge = await import('./bridge.js');
bridge.syncBridgeFromConfig();

// 6. Heartbeat to the shell's control service (anti-orphan).
const ctlPort = Number(process.env.OMA_DESKTOP_CONTROL_PORT ?? 0);
if (ctlPort > 0) {
  startHeartbeat(ctlPort, controlToken);
}

// 7. Signal handling — mirror src/index.ts (SIGINT/SIGTERM → stop → exit 0).
let shuttingDown = false;
async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[sidecar] shutdown (${reason})`);
  try {
    controlServer.close();
    await stop();
  } catch (e) {
    console.error('[sidecar] stop() error:', e);
  }
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('uncaughtException', (e) => {
  // pino worker exit races are expected during shutdown — ignore.
  if (shuttingDown && String(e?.message ?? '').includes('worker has exited')) return;
  console.error('[sidecar] uncaught exception:', e);
});

// Kept referenced so the compiler keeps the import side-effect-free.
void services;
