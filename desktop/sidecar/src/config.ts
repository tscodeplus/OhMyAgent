// Desktop config — port of desktop/src/config.ts (electron-store) to a plain
// JSON file at <data_dir>/desktop-config.json. Same path and file name as
// electron-store used, so existing user config carries over unchanged.
// The sidecar is the primary writer; the Rust shell mirrors it by polling
// mtime (see src-tauri/src/config.rs).

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface GatewayDesktopConfig {
  /** 'local' = embedded server, 'remote' = connect to external instance */
  mode: 'local' | 'remote';
  /** Remote gateway URL (e.g. http://192.168.1.100:9191) */
  remoteUrl: string;
  /** Auth token for the remote gateway */
  remoteToken: string;
}

export interface DesktopConfig {
  closeToTray: boolean;
  autoStart: boolean;
  theme: 'system' | 'light' | 'dark';
  /** UI language ('en' or 'zh-CN'), persisted across restarts. */
  language?: 'en' | 'zh-CN';
  firstRunDone: boolean;
  /**
   * WebUI access token for local mode — shell-owned (generated once on first
   * run, injected to the gateway as OMA_WEBUI_TOKEN). The sidecar never
   * writes it; it just round-trips the field so saves don't drop it. Users
   * can read it here to log in from a web browser.
   */
  webuiToken?: string;
  gateway: GatewayDesktopConfig;
}

// electron-store schema defaults (orphan keys like window/minimizeToTray/
// serverPort are intentionally dropped — nothing read them at runtime).
const DEFAULTS: DesktopConfig = {
  closeToTray: true,
  autoStart: false,
  theme: 'system',
  firstRunDone: false,
  gateway: { mode: 'local', remoteUrl: '', remoteToken: '' },
};

function configPath(): string {
  const home = process.env.OHMYAGENT_HOME ?? '.';
  return join(home, 'desktop-config.json');
}

export function loadConfig(): DesktopConfig {
  try {
    const raw = JSON.parse(readFileSync(configPath(), 'utf8')) as Partial<DesktopConfig>;
    return {
      ...DEFAULTS,
      ...raw,
      gateway: { ...DEFAULTS.gateway, ...(raw.gateway ?? {}) },
    };
  } catch {
    // Missing or corrupt — start from defaults.
    return structuredClone(DEFAULTS);
  }
}

export function saveConfig(cfg: DesktopConfig): void {
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
  renameSync(tmp, p); // atomic — the shell's mtime poll never sees a partial file
}

export function getGatewayConfig(): GatewayDesktopConfig {
  return loadConfig().gateway;
}

export function setGatewayConfig(config: Partial<GatewayDesktopConfig>): GatewayDesktopConfig {
  const cfg = loadConfig();
  cfg.gateway = { ...cfg.gateway, ...config };
  saveConfig(cfg);
  return cfg.gateway;
}

export function resetGatewayConfig(): GatewayDesktopConfig {
  const cfg = loadConfig();
  cfg.gateway = structuredClone(DEFAULTS.gateway);
  saveConfig(cfg);
  return cfg.gateway;
}
