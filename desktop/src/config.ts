import Store from 'electron-store';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GatewayDesktopConfig {
  /** 'local' = embedded server, 'remote' = connect to external instance */
  mode: 'local' | 'remote';
  /** Remote gateway URL (e.g. http://192.168.1.100:9191) */
  remoteUrl: string;
  /** Auth token for the remote gateway */
  remoteToken: string;
}

export interface DesktopConfig {
  window: {
    width: number;
    height: number;
    x?: number;
    y?: number;
    isMaximized: boolean;
  };
  minimizeToTray: boolean;
  closeToTray: boolean;
  autoStart: boolean;
  autoStartMinimized: boolean;
  serverPort: number;
  theme: 'system' | 'light' | 'dark';
  firstRunDone: boolean;
  lastVersion?: string;
  /** Gateway connection config */
  gateway: GatewayDesktopConfig;
}

// ---------------------------------------------------------------------------
// Schema (for electron-store validation)
// ---------------------------------------------------------------------------

const schema = {
  window: {
    type: 'object',
    properties: {
      width: { type: 'number', default: 1200 },
      height: { type: 'number', default: 800 },
      x: { type: 'number' },
      y: { type: 'number' },
      isMaximized: { type: 'boolean', default: false },
    },
    default: { width: 1200, height: 800, isMaximized: false },
  },
  minimizeToTray: { type: 'boolean', default: true },
  closeToTray: { type: 'boolean', default: true },
  autoStart: { type: 'boolean', default: false },
  autoStartMinimized: { type: 'boolean', default: false },
  serverPort: { type: 'number', default: 9191 },
  theme: { type: 'string', enum: ['system', 'light', 'dark'], default: 'system' },
  firstRunDone: { type: 'boolean', default: false },
  lastVersion: { type: 'string' },
  gateway: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['local', 'remote'], default: 'local' },
      remoteUrl: { type: 'string', default: '' },
      remoteToken: { type: 'string', default: '' },
    },
    default: { mode: 'local', remoteUrl: '', remoteToken: '' },
  },
};

// ---------------------------------------------------------------------------
// DesktopConfigStore
// ---------------------------------------------------------------------------

export class DesktopConfigStore {
  private store: Store<DesktopConfig>;

  constructor() {
    this.store = new Store<DesktopConfig>({
      name: 'desktop-config',
      schema,
      // migrations for future config format changes would go here
    });
  }

  get<K extends keyof DesktopConfig>(key: K): DesktopConfig[K] {
    return this.store.get(key);
  }

  set<K extends keyof DesktopConfig>(key: K, value: DesktopConfig[K]): void {
    this.store.set(key, value);
  }

  getAll(): DesktopConfig {
    return this.store.store;
  }

  reset(): void {
    this.store.clear();
  }

  /** Called once after first-run wizard completes */
  markFirstRunDone(): void {
    this.store.set('firstRunDone', true);
    this.store.set('lastVersion', this.store.get('lastVersion'));
  }

  /** Update lastVersion to current (called after app update) */
  setLastVersion(version: string): void {
    this.store.set('lastVersion', version);
  }

  /** Get gateway connection config. */
  getGatewayConfig(): GatewayDesktopConfig {
    return this.store.get('gateway');
  }

  /** Set gateway connection config. */
  setGatewayConfig(config: Partial<GatewayDesktopConfig>): void {
    const current = this.store.get('gateway');
    this.store.set('gateway', { ...current, ...config });
  }

  /** Get the underlying electron-store instance (for direct access if needed) */
  getStore(): Store<DesktopConfig> {
    return this.store;
  }
}

// Singleton
let instance: DesktopConfigStore | null = null;

export function getDesktopConfig(): DesktopConfigStore {
  if (!instance) {
    instance = new DesktopConfigStore();
  }
  return instance;
}
