// src/computer-use/settings.ts
//
// Computer Use configuration — reads from config.yaml (via AppConfig.computerUse).
// The calling code in bootstrap.ts passes the parsed config section.

import type { ComputerUseConfig } from '../app/types.js';

export interface ComputerUseSSHSettings {
  host: string;
  user: string;
  keyPath: string;
  port: number;
  jumpHost: string;
  display: string;
  hostKeyChecking: 'accept-new' | 'strict';
  knownHostsPath: string;
}

export interface ComputerUseNodeSettings {
  /** mimic REST 服务地址(手机端,如 http://127.0.0.1:8473)。 */
  url: string;
  /** mimic 认证 token(经 x-mimic-token 头发送)。可选,默认无。 */
  token?: string;
  /** adb 电源/锁屏管理(唤醒/常亮/恢复)。可选,默认不启用。 */
  adb?: {
    /** adb 命令或绝对路径,默认 'adb' */
    path: string;
    /** 多设备时的序列号 */
    serial?: string;
    /** 操作前唤醒/常亮,完成后恢复。默认 false。 */
    manageScreen: boolean;
  };
}

export type ComputerUseProviderMode = 'auto' | 'ssh' | 'local' | 'node';

export interface ComputerUseSettings {
  enabled: boolean;
  provider: ComputerUseProviderMode;
  ssh: ComputerUseSSHSettings;
  node: ComputerUseNodeSettings;
  allowedApps: string[];
  allowedAgents: string[];
  approvalWhitelist: string[];
  perPlatformProvider: Record<string, string>;
}

/**
 * Convert a parsed config.yaml computer_use section into ComputerUseSettings.
 * All fields have defaults; missing config simply disables Computer Use.
 */
export function normalizeComputerUseSettings(cfg?: ComputerUseConfig): ComputerUseSettings {
  if (!cfg || cfg.enabled !== true) {
    return {
      enabled: false,
      provider: 'auto',
      ssh: { host: '', user: '', keyPath: '', port: 22, jumpHost: '', display: ':0',
             hostKeyChecking: 'accept-new', knownHostsPath: '' },
      node: normalizeNodeSettings(),
      allowedApps: [],
      allowedAgents: [],
      approvalWhitelist: [],
      perPlatformProvider: {},
    };
  }

  return {
    enabled: true,
    provider: (cfg.provider as ComputerUseProviderMode) || 'auto',
    ssh: cfg.ssh ? {
      host: cfg.ssh.host || '',
      user: cfg.ssh.user || '',
      keyPath: cfg.ssh.keyPath || '',
      port: cfg.ssh.port || 22,
      jumpHost: cfg.ssh.jumpHost || '',
      display: cfg.ssh.display || ':0',
      hostKeyChecking: cfg.ssh.hostKeyChecking || 'accept-new',
      knownHostsPath: cfg.ssh.knownHostsPath || '',
    } : { host: '', user: '', keyPath: '', port: 22, jumpHost: '', display: ':0',
          hostKeyChecking: 'accept-new', knownHostsPath: '' },
    node: normalizeNodeSettings(cfg.node),
    allowedApps: cfg.allowedApps,
    allowedAgents: cfg.allowedAgents ?? [],
    approvalWhitelist: cfg.approvalWhitelist || [],
    perPlatformProvider: cfg.perPlatformProvider || {},
  };
}

/** Normalize the node (mimic) section; all fields default to safe values. */
function normalizeNodeSettings(cfg?: ComputerUseConfig['node']): ComputerUseNodeSettings {
  return {
    url: cfg?.url || '',
    token: cfg?.token || undefined,
    adb: {
      path: cfg?.adb?.path || 'adb',
      serial: cfg?.adb?.serial || undefined,
      manageScreen: cfg?.adb?.manageScreen === true,
    },
  };
}
