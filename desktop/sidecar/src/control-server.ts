// Sidecar control API — a small HTTP server on 127.0.0.1 that both the Rust
// shell (health lifecycle) and the injected compat layer (config / updater /
// bridge / language) talk to. Token-gated (Authorization: Bearer or ?token=
// for EventSource) with CORS for the WebUI origin and the remote-gateway origin.
//
// Endpoints:
//   GET    /_desktop/ping                     → "pong" (compat-layer probe)
//   GET    /_desktop/config?key=theme         → { key, value }
//   PUT    /_desktop/config   {key, value}
//   GET    /_desktop/gateway-config           → gateway object
//   PUT    /_desktop/gateway-config           → partial merge
//   PUT    /_desktop/language  {lang}
//   GET    /_desktop/user-data-path           → { path }
//   GET    /_desktop/events                   → SSE (updater events)
//   POST   /_desktop/updater/check|download|cancel|install
//   POST   /_desktop/bridge/session/:id       → register
//   DELETE /_desktop/bridge/session/:id       → unregister
//   GET    /_desktop/bridge/status
//   GET    /_desktop/gateway-chooser          → HTML (first-run wizard)
//   POST   /_desktop/shutdown                 → graceful stop + exit
//
// M3 fills in updater routes; M2 fills in bridge + gateway-chooser.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { URL } from 'node:url';
import { EventEmitter } from 'node:events';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  getGatewayConfig,
  loadConfig,
  resetGatewayConfig,
  saveConfig,
  setGatewayConfig,
  type DesktopConfig,
} from './config.js';

export interface ControlServerOptions {
  port: number;
  token: string;
  /** Shutdown hook wired to bootstrap().stop() */
  stop: () => Promise<void>;
}

/** Updater event emitter consumed by control-server SSE + updater module. */
export const updaterEvents = new EventEmitter();

const sseClients = new Set<ServerResponse>();

export function broadcastEvent(type: string, payload: unknown): void {
  const frame = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(frame);
    } catch {
      sseClients.delete(res);
    }
  }
}

export function createControlServer(opts: ControlServerOptions): Server {
  const server = createServer((req, res) => {
    void handle(req, res, opts);
  });
  server.listen(opts.port, '127.0.0.1');
  return server;
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  };
}

function authorize(req: IncomingMessage, opts: ControlServerOptions): boolean {
  const header = req.headers.authorization ?? '';
  if (header === `Bearer ${opts.token}`) return true;
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  return url.searchParams.get('token') === opts.token;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(text),
    ...corsHeaders(),
  });
  res.end(text);
}

function text(res: ServerResponse, status: number, body: string, contentType = 'text/plain'): void {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    ...corsHeaders(),
  });
  res.end(body);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
    if (chunks.reduce((n, c) => n + c.length, 0) > 1 << 20) throw new Error('payload too large');
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function handle(req: IncomingMessage, res: ServerResponse, opts: ControlServerOptions): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  if (!authorize(req, opts)) {
    json(res, 401, { error: 'unauthorized' });
    return;
  }

  try {
    if (path === '/_desktop/ping' && method === 'GET') {
      text(res, 200, 'pong');
      return;
    }

    if (path === '/_desktop/config' && method === 'GET') {
      const key = url.searchParams.get('key');
      const cfg = loadConfig() as unknown as Record<string, unknown>;
      if (key) {
        json(res, 200, { key, value: cfg[key] });
      } else {
        json(res, 200, cfg);
      }
      return;
    }

    if (path === '/_desktop/config' && method === 'PUT') {
      const body = (await readJson(req)) as { key?: string; value?: unknown };
      if (typeof body.key !== 'string') {
        json(res, 400, { error: 'key required' });
        return;
      }
      const cfg = loadConfig() as unknown as Record<string, unknown>;
      cfg[body.key] = body.value;
      saveConfig(cfg as unknown as DesktopConfig);
      json(res, 200, { ok: true });
      return;
    }

    if (path === '/_desktop/gateway-config' && method === 'GET') {
      json(res, 200, getGatewayConfig());
      return;
    }

    if (path === '/_desktop/gateway-config' && method === 'PUT') {
      const body = (await readJson(req)) as Partial<GatewayConfigBody>;
      const updated = setGatewayConfig(body ?? {});
      // Bridge follows the gateway config: connect for remote, drop for local.
      const bridge = await import('./bridge.js');
      bridge.syncBridgeFromConfig();
      json(res, 200, updated);
      return;
    }

    if (path === '/_desktop/language' && method === 'PUT') {
      const body = (await readJson(req)) as { lang?: string };
      const lang = body?.lang;
      if (lang !== 'en' && lang !== 'zh-CN') {
        json(res, 400, { error: 'lang must be en or zh-CN' });
        return;
      }
      const cfg = loadConfig();
      cfg.language = lang;
      saveConfig(cfg);
      json(res, 200, { ok: true });
      return;
    }

    if (path === '/_desktop/user-data-path' && method === 'GET') {
      json(res, 200, { path: process.env.OHMYAGENT_HOME ?? '' });
      return;
    }

    if (path === '/_desktop/events' && method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        ...corsHeaders(),
      });
      res.write(': connected\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    if (path.startsWith('/_desktop/updater/')) {
      await handleUpdater(path, method, req, res);
      return;
    }

    if (path.startsWith('/_desktop/bridge/')) {
      await handleBridge(path, method, req, res);
      return;
    }

    if (path === '/_desktop/gateway-chooser' && method === 'GET') {
      const html = await import('./gateway-chooser.js').then((m) => m.renderChooser(loadConfig()));
      text(res, 200, html, 'text/html; charset=utf-8');
      return;
    }

    if (path === '/_desktop/shutdown' && method === 'POST') {
      // Graceful stop: bootstrap().stop() closes channels/cron/WS/HTTP/db.
      text(res, 200, 'shutting down');
      setTimeout(() => {
        void opts
          .stop()
          .catch((e) => console.error('[sidecar] stop() failed:', e))
          .finally(() => process.exit(0));
      }, 100);
      return;
    }

    json(res, 404, { error: `not found: ${method} ${path}` });
  } catch (e) {
    json(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
}

interface GatewayConfigBody {
  mode?: 'local' | 'remote';
  remoteUrl?: string;
  remoteToken?: string;
}

// -- updater routes (M3): wired when updater.ts is ported --------------------

async function handleUpdater(
  path: string,
  _method: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const action = path.slice('/_desktop/updater/'.length);
  try {
    const updater = await import('./updater.js');
    switch (action) {
      case 'check': {
        const body = (await readJson(req)) as { includeBeta?: boolean; fromTray?: boolean };
        if (body?.fromTray) {
          // Tray flow: spinner window + result dialogs.
          void updater.getAppUpdater().checkForUpdatesFromTray();
        } else {
          // WebUI flow: SSE events back to the compat layer.
          void updater.getAppUpdater().checkForUpdates(body?.includeBeta ?? false);
        }
        json(res, 200, { ok: true });
        return;
      }
      case 'download': {
        void updater.getAppUpdater().downloadUpdate();
        json(res, 200, { ok: true });
        return;
      }
      case 'cancel': {
        updater.getAppUpdater().cancelDownload();
        json(res, 200, { ok: true });
        return;
      }
      case 'install': {
        void updater.getAppUpdater().installUpdate();
        json(res, 200, { ok: true });
        return;
      }
      default:
        json(res, 404, { error: `unknown updater action: ${action}` });
    }
  } catch (e) {
    json(res, 501, { error: `updater not available: ${e instanceof Error ? e.message : e}` });
  }
}

// -- bridge routes (M2): desktop-bridge session registry ---------------------

async function handleBridge(
  path: string,
  method: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const sessionRe = /^\/_desktop\/bridge\/session\/([^/]+)$/;
  const m = path.match(sessionRe);
  try {
    if (m) {
      const sessionId = decodeURIComponent(m[1]);
      if (method === 'POST') {
        const bridge = await import('./bridge.js');
        bridge.registerSession(sessionId);
        json(res, 200, { ok: true });
        return;
      }
      if (method === 'DELETE') {
        const bridge = await import('./bridge.js');
        bridge.unregisterSession(sessionId);
        json(res, 200, { ok: true });
        return;
      }
    }
    if (path === '/_desktop/bridge/status' && method === 'GET') {
      const bridge = await import('./bridge.js');
      json(res, 200, bridge.getBridgeStatus());
      return;
    }
    json(res, 404, { error: `not found: ${method} ${path}` });
  } catch (e) {
    json(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
}

// ---------------------------------------------------------------------------
// Heartbeat — anti-orphan: the shell's control service must stay reachable or
// the sidecar exits itself (Rust dying cannot leave the server running).
// ---------------------------------------------------------------------------

const HEARTBEAT_INTERVAL_MS = 3000;
const MISSED_HEARTBEAT_LIMIT = 3;

let heartbeatTimer: NodeJS.Timeout | null = null;

export function startHeartbeat(ctlPort: number, token: string): void {
  const url = `http://127.0.0.1:${ctlPort}/ping`;
  let missed = 0;

  const tick = async (): Promise<void> => {
    try {
      const r = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(2000),
      });
      if (r.ok) {
        missed = 0;
      } else {
        missed += 1;
      }
    } catch {
      missed += 1;
    }
    if (missed >= MISSED_HEARTBEAT_LIMIT) {
      console.error(`[sidecar] heartbeat failed ${missed} times — shell unreachable, exiting`);
      process.exit(0);
    }
  };

  void tick();
  heartbeatTimer = setInterval(tick, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();
}

/** Data dir setup shared with index.ts */
export function ensureDataDirs(): string {
  const home = process.env.OHMYAGENT_HOME ?? join(process.cwd(), 'data');
  mkdirSync(join(home, 'data'), { recursive: true });
  mkdirSync(join(home, 'logs'), { recursive: true });
  process.env.OHMYAGENT_LOG_DIR ??= join(home, 'logs');
  return home;
}
