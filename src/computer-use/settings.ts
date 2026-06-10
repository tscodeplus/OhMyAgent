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
  url: string;
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
      node: { url: '' },
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
    node: cfg.node ? {
      url: cfg.node.url || '',
    } : { url: '' },
    allowedApps: cfg.allowedApps,
    allowedAgents: cfg.allowedAgents ?? [],
    approvalWhitelist: cfg.approvalWhitelist || [],
    perPlatformProvider: cfg.perPlatformProvider || {},
  };
}
