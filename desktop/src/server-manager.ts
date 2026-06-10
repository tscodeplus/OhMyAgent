import { app } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ServerManagerOptions {
  port: number;
  bindAddress: string;
  configPath: string;
  dataDir: string;
  dbPath: string;
}

export type ServerStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';

type EventHandler = (...args: any[]) => void;

// Minimal interface for what bootstrap() returns
interface BootstrapResult {
  services: unknown;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// ServerManager
// ---------------------------------------------------------------------------

export class ServerManager {
  private status: ServerStatus = 'stopped';
  private services: unknown = null;
  private startFn: (() => Promise<void>) | null = null;
  private stopFn: (() => Promise<void>) | null = null;
  private listeners: Map<string, EventHandler[]> = new Map();

  constructor(private options: ServerManagerOptions) {}

  // ---- Public API ----

  async start(): Promise<void> {
    if (this.status === 'running' || this.status === 'starting') {
      throw new Error(`Cannot start: server is already ${this.status}`);
    }

    this.status = 'starting';
    try {
      await this.doStart();
      this.status = 'running';
      this.emit('started');
    } catch (err) {
      this.status = 'error';
      this.emit('error', err);
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (this.status === 'stopped' || this.status === 'stopping') {
      return;
    }

    this.status = 'stopping';
    try {
      if (this.stopFn) {
        await this.stopFn();
        this.stopFn = null;
        this.startFn = null;
        this.services = null;
      }
      this.status = 'stopped';
      this.emit('stopped');
    } catch (err) {
      // During app quit, worker threads (e.g. pino file transport) may exit
      // before stop() completes, causing "the worker has exited" errors.
      // Log and swallow — the process is shutting down anyway.
      console.error('[ServerManager] Error during stop (non-fatal):', err);
      this.status = 'stopped';
      this.emit('error', err);
    }
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  getStatus(): ServerStatus {
    return this.status;
  }

  on(event: 'started' | 'stopped' | 'error', handler: EventHandler): void {
    const handlers = this.listeners.get(event) ?? [];
    handlers.push(handler);
    this.listeners.set(event, handlers);
  }

  // ---- Internal ----

  private emit(event: string, ...args: any[]): void {
    const handlers = this.listeners.get(event) ?? [];
    for (const handler of handlers) {
      handler(...args);
    }
  }

  private async doStart(): Promise<void> {
    const isPackaged = app.isPackaged;

    // ------------------------------------------------------------------
    // Path resolution: dev mode vs production (asar) mode
    //
    // Dev:  tsx runs from desktop/src/, relative paths point to repo root
    // Prod: asar in resources/app.asar, extraResources in resources/
    // ------------------------------------------------------------------
    const resourcesPath = isPackaged
      ? process.resourcesPath
      : path.resolve(app.getAppPath(), '../../');  // desktop/ -> repo root

    // 1. Set environment variables BEFORE importing bootstrap
    process.env.OHMYAGENT_HOME = app.getPath('userData');
    process.env.OHMYAGENT_PORT = String(this.options.port);
    process.env.OHMYAGENT_BIND_ADDRESS = this.options.bindAddress;
    process.env.DATABASE_PATH = this.options.dbPath;
    process.env.CONFIG_FILE = this.options.configPath;
    process.env.ELECTRON_RUN = '1';

    // 2. WebUI static root — where index.html and assets live
    const webuiRoot = path.join(
      resourcesPath,
      isPackaged ? 'webui-dist' : 'ui/dist'
    );
    process.env.WEBUI_STATIC_ROOT = webuiRoot;

    // 3. Ensure data directories exist
    const fs = await import('node:fs');
    fs.mkdirSync(path.join(app.getPath('userData'), 'data'), { recursive: true });
    const logDir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    process.env.OHMYAGENT_LOG_DIR = logDir;

    // 4. Resolve server root (where extensions/, skills/, etc. live)
    const serverRoot = isPackaged
      ? path.join(resourcesPath, 'server-dist')
      : path.resolve(app.getAppPath(), '../../');

    // Set CWD to server root so that relative paths used by bootstrap
    // (extensions/, skills/, config.yaml) resolve correctly.
    // In packaged mode, extensions are compiled into server-dist/extensions/;
    // without this chdir, the ExtensionLoader looks for extensions/ in the
    // app root where they don't exist, causing plugin tools like web_search
    // to silently fail to register.
    process.chdir(serverRoot);
    console.log('[ServerManager] CWD set to:', serverRoot);

    // 5. Import bootstrap — different paths for dev vs prod
    const bootstrapPath = path.join(
      serverRoot,
      isPackaged ? 'src/app/bootstrap.js' : 'src/app/bootstrap.js'
    );

    console.log('[ServerManager] Importing bootstrap from:', bootstrapPath);
    let bootstrapModule: { bootstrap: () => Promise<BootstrapResult> };
    try {
      bootstrapModule = await import(pathToFileURL(bootstrapPath).href) as typeof bootstrapModule;
    } catch (importErr) {
      const msg = importErr instanceof Error ? importErr.message : String(importErr);
      const stack = importErr instanceof Error ? importErr.stack : '';
      console.error('[ServerManager] Failed to import bootstrap:', msg);
      console.error('[ServerManager] Import stack:', stack);
      throw new Error(`Failed to load server: ${msg}`, { cause: importErr });
    }

    // 5. Call bootstrap
    const result: BootstrapResult = await bootstrapModule.bootstrap();
    this.services = result.services;
    this.startFn = result.start;
    this.stopFn = result.stop;

    // 6. Start the server
    await this.startFn();
    console.log('[ServerManager] Server started on', this.options.bindAddress + ':' + this.options.port);
  }
}
