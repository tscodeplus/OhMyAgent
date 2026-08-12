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
import { LocalDarwinProvider } from '../../computer-use/providers/local-darwin.js';
import { LocalLinuxProvider } from '../../computer-use/providers/local-linux.js';
import { NodeComputerUseProvider } from '../../computer-use/providers/node-provider.js';
import { createMockComputerProvider } from '../../computer-use/providers/mock-provider.js';
import { SSHPool } from '../../computer-use/transports/ssh-pool.js';
import type { AgentManager } from '../../agent/agent-manager.js';
import type { AppConfig } from '../types.js';
import type { Logger } from 'pino';

export interface ComputerUseServices {
  computerUseHost?: ComputerUseHost;
  /** Mutable ref populated later by createChannelServices (agentManager). */
  agentManagerRef: { current?: AgentManager };
  /** Mutable settings ref — update it on hot-reload; ComputerUseHost reads via getSettings(). */
  cuaSettingsRef: { current: ReturnType<typeof normalizeComputerUseSettings> };
}

export async function createComputerUseServices(
  config: AppConfig,
  logger: Logger,
): Promise<ComputerUseServices> {
  const agentManagerRef: { current?: AgentManager } = {};
  const cuaSettingsRef = { current: normalizeComputerUseSettings(config.computerUse) };
  const cuaSettings = cuaSettingsRef.current;

  // Detect WSL: Linux kernel but can call powershell.exe to control Windows host
  const isWSL = process.platform === 'linux' && existsSync('/proc/sys/fs/binfmt_misc/WSLInterop');
  const isTermux = existsSync('/data/data/com.termux') || !!process.env.PREFIX?.includes('/com.termux/');

  if (!cuaSettings.enabled) {
    logger.debug('Computer Use disabled');
    return { computerUseHost: undefined, agentManagerRef, cuaSettingsRef };
  }

  const providerRegistry = new ComputerProviderRegistry();

  // Always register mock provider for testing
  providerRegistry.register(createMockComputerProvider());

  // Windows host control via the resident UIA helper — registered both when
  // running in WSL (platform is linux, control the Windows host via interop)
  // and natively on Windows (platform is win32). No SSH needed either way.
  if (isWSL || process.platform === 'win32') {
    providerRegistry.register(new LocalWindowsProvider({ logger }));
    logger.info(
      'Computer Use: registered Windows local provider (windows:local, UIA)%s',
      isWSL ? ' (WSL → Windows host)' : '',
    );
  }

  // Native accessibility-first providers (no SSH, no input injection):
  // macOS → JXA AX (darwin:local); Linux → AT-SPI (linux:local). Both reuse
  // the SSH action layer over a local child_process runner.
  if (process.platform === 'darwin' && !isTermux) {
    providerRegistry.register(new LocalDarwinProvider({ logger }));
    logger.info('Computer Use: registered macOS local provider (darwin:local, JXA AX)');
  } else if (process.platform === 'linux' && !isWSL && !isTermux) {
    providerRegistry.register(new LocalLinuxProvider({ logger }));
    logger.info('Computer Use: registered Linux local provider (linux:local, AT-SPI)');
  } else if (isTermux) {
    logger.info('Computer Use: Termux detected, skipping native local providers');
  }

  // Note: NutJSProvider (local-nutjs.ts) is no longer registered on any
  // platform — macOS/Linux native use the accessibility local providers and
  // Windows native uses the resident UIA provider. The file stays exported
  // for backward compatibility.

  // Node provider (Android via an accessibility-service APK, e.g. mimic):
  // registered when computer_use.node.url is configured. This is the primary
  // computer-use path on Termux (the phone itself) or for remote devices.
  if (cuaSettings.node.url) {
    providerRegistry.register(new NodeComputerUseProvider({ settings: cuaSettings, logger }));
    logger.info('Computer Use: node provider registered (url=%s)', cuaSettings.node.url);
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
  if (isWSL || process.platform === 'win32') {
    defaultProviderId = 'windows:local';
  } else if (process.platform === 'darwin' && providerRegistry.has('darwin:local')) {
    defaultProviderId = 'darwin:local';
  } else if (process.platform === 'linux' && providerRegistry.has('linux:local')) {
    defaultProviderId = 'linux:local';
  } else if (providerRegistry.has('node')) {
    // Termux or headless: prefer the Android/remote node provider when
    // configured; mock remains the last-resort fallback.
    defaultProviderId = 'node';
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
    getSettings: () => cuaSettingsRef.current,
    getAccessMode: () => 'operate',
    getPrimaryAgentId: () => agentManagerRef.current?.list()[0]?.id ?? null,
    logger,
  });

  logger.info({ defaultProviderId, providerCount: providerRegistry.list().length }, 'Computer Use initialized');

  return { computerUseHost, agentManagerRef, cuaSettingsRef };
}
