/**
 * Computer Use services composer.
 *
 * Extracted from bootstrap.ts (Phase 9c). Detects the runtime platform (WSL,
 * Termux, native), registers the appropriate provider chain, and creates the
 * ComputerUseHost.
 */

import { existsSync } from 'node:fs';
import { normalizeComputerUseSettings } from '../../computer-use/settings.js';
import { ComputerProviderRegistry } from '../../computer-use/provider-registry.js';
import { ComputerLeaseRegistry } from '../../computer-use/lease-registry.js';
import { ComputerUseHost } from '../../computer-use/computer-host.js';
import { SSHComputerUseProvider } from '../../computer-use/providers/ssh-provider.js';
import { LocalWindowsProvider } from '../../computer-use/providers/local-windows.js';
import { NutJSProvider } from '../../computer-use/providers/local-nutjs.js';
import { createMockComputerProvider } from '../../computer-use/providers/mock-provider.js';
import { SSHPool } from '../../computer-use/transports/ssh-pool.js';
import type { AgentManager } from '../../agent/agent-manager.js';
import type { AppConfig } from '../types.js';
import type { Logger } from 'pino';

export interface ComputerUseServices {
  computerUseHost?: ComputerUseHost;
  /** Mutable ref populated later by createChannelServices (agentManager). */
  agentManagerRef: { current?: AgentManager };
  /** Normalized settings, exposed for hot-reload updates. */
  cuaSettings: ReturnType<typeof normalizeComputerUseSettings>;
}

export async function createComputerUseServices(
  config: AppConfig,
  logger: Logger,
): Promise<ComputerUseServices> {
  const agentManagerRef: { current?: AgentManager } = {};
  const cuaSettings = normalizeComputerUseSettings(config.computerUse);

  // Detect WSL: Linux kernel but can call powershell.exe to control Windows host
  const isWSL = process.platform === 'linux' && existsSync('/proc/sys/fs/binfmt_misc/WSLInterop');
  const isTermux = existsSync('/data/data/com.termux') || !!process.env.PREFIX?.includes('/com.termux/');

  if (!cuaSettings.enabled) {
    logger.debug('Computer Use disabled');
    return { computerUseHost: undefined, agentManagerRef, cuaSettings };
  }

  const providerRegistry = new ComputerProviderRegistry();

  // Always register mock provider for testing
  providerRegistry.register(createMockComputerProvider());

  // WSL: register direct Windows provider (no SSH needed)
  if (isWSL) {
    providerRegistry.register(new LocalWindowsProvider({ logger }));
    logger.info('Computer Use: WSL detected, registered Windows local provider (powershell.exe)');
  }

  // Native desktop control via nut.js (Linux/macOS/Windows, non-WSL only).
  if (!isWSL && !isTermux) {
    try {
      const nutProvider = new NutJSProvider({ logger });
      providerRegistry.register(nutProvider);
      logger.info(`Computer Use: registered NutJS local provider (${process.platform})`);
    } catch (err) {
      logger.warn({ err }, 'Computer Use: failed to register NutJS provider');
    }
  } else if (isTermux) {
    logger.info('Computer Use: Termux detected, skipping NutJS local provider');
  }

  // Register SSH provider if configured
  if (cuaSettings.ssh.host && cuaSettings.ssh.user && cuaSettings.ssh.keyPath) {
    const sshPool = new SSHPool({
      host: cuaSettings.ssh.host,
      user: cuaSettings.ssh.user,
      keyPath: cuaSettings.ssh.keyPath,
      port: cuaSettings.ssh.port,
      jumpHost: cuaSettings.ssh.jumpHost || undefined,
      display: cuaSettings.ssh.display,
      hostKeyChecking: cuaSettings.ssh.hostKeyChecking,
      knownHostsPath: cuaSettings.ssh.knownHostsPath || undefined,
    });
    providerRegistry.register(new SSHComputerUseProvider({
      sshPool,
      settings: cuaSettings,
      logger,
    }));
    logger.info('Computer Use: SSH provider registered');
  }

  // Resolve default provider with fallback chain
  let defaultProviderId: string;
  if (isWSL) {
    defaultProviderId = 'windows:local';
  } else if (providerRegistry.has('nutjs')) {
    defaultProviderId = 'nutjs';
  } else {
    defaultProviderId = 'mock';
    if (isTermux) {
      logger.info('Computer Use: using mock provider on Termux');
    } else {
      logger.warn('Computer Use: NutJS unavailable, falling back to mock provider');
    }
  }

  // Verify the resolved default provider is actually available at startup
  const resolvedProvider = providerRegistry.get(defaultProviderId);
  if (resolvedProvider) {
    try {
      const status = await resolvedProvider.getStatus({ sessionPath: '', agentId: '' });
      if (!status.available) {
        logger.warn(
          { defaultProviderId, reason: status.message },
          `Computer Use: default provider '${defaultProviderId}' reports unavailable, falling back to mock`,
        );
        if (providerRegistry.has('mock')) {
          defaultProviderId = 'mock';
        }
      }
    } catch {
      logger.warn(
        { defaultProviderId },
        `Computer Use: default provider '${defaultProviderId}' threw during status check, falling back to mock`,
      );
      if (providerRegistry.has('mock')) {
        defaultProviderId = 'mock';
      }
    }
  }

  const leaseRegistry = new ComputerLeaseRegistry();
  const computerUseHost = new ComputerUseHost({
    providers: providerRegistry,
    defaultProviderId,
    leases: leaseRegistry,
    platform: process.platform,
    getSettings: () => cuaSettings,
    getAccessMode: () => 'operate',
    getPrimaryAgentId: () => agentManagerRef.current?.list()[0]?.id ?? null,
    logger,
  });

  logger.info({ defaultProviderId, providerCount: providerRegistry.list().length }, 'Computer Use initialized');

  return { computerUseHost, agentManagerRef, cuaSettings };
}
