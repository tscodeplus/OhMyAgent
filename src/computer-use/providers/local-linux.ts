// src/computer-use/providers/local-linux.ts
//
// Local Linux ComputerUseProvider (accessibility-first). Drives the exact
// same AT-SPI action layer as the SSH provider (ssh-actions-linux.ts) but
// executes the commands through child_process on this machine — no SSH, no
// nut.js input injection. Replaces NutJSProvider on native Linux (non-WSL,
// non-Termux), which only had window-level elements and injected global
// X11 mouse/keyboard events.

import type { Logger } from 'pino';
import type { ComputerUseProvider } from '../provider-contract.js';
import { normalizeComputerProviderCapabilities } from '../provider-contract.js';
import type {
  Ctx,
  AppInfo,
  ProviderStatus,
  Lease,
  Target,
  AppState,
  Action,
  ActionResult,
} from '../types.js';
import { createLocalExecRunner, quoteShellArg, type ExecRunner } from '../ssh-actions-common.js';
import { listLinuxApps, readLinuxWindowState, performLinuxAction } from '../ssh-actions-linux.js';

export class LocalLinuxProvider implements ComputerUseProvider {
  readonly providerId = 'linux:local';

  // Same capabilities as the SSH linux branch: element actions and text
  // input go through the AT-SPI tree (semantic, no foreground requirement);
  // press_key is pidScoped (xdotool key) and may still need the target
  // foregrounded.
  readonly capabilities = normalizeComputerProviderCapabilities({
    platform: 'linux',
    observationModes: ['vision-native'],
    screenshot: true,
    accessibilityTree: true,
    elementActions: 'semantic',
    elementDoubleClick: true,
    backgroundControl: 'partial',
    pointClick: 'allowed',
    drag: 'unsupported',
    textInput: 'semantic',
    keyboardInput: 'pidScoped',
    requiresForegroundForInput: false,
    nativeCursor: false,
    isolated: false,
  });

  private readonly runner: ExecRunner;
  private readonly logger?: Logger;

  constructor(options?: { logger?: Logger; runner?: ExecRunner }) {
    this.logger = options?.logger;
    // The action layer talks to the X11 desktop (xdotool, wmctrl) and the
    // AT-SPI bus. When OhMyAgent runs outside a desktop session (systemd,
    // SSH) DISPLAY is not exported — default to ':0', the common case.
    this.runner =
      options?.runner ?? createLocalExecRunner({ display: process.env.DISPLAY || ':0' });
  }

  async getStatus(_ctx: Ctx): Promise<ProviderStatus> {
    try {
      // Mirror the SSH health check: the X11 toolchain must be present.
      const result = await this.runner.exec('which xdotool && which scrot && echo OK', {
        timeoutMs: 10_000,
      });
      const ok = result.stdout.includes('OK');
      return {
        providerId: this.providerId,
        available: ok,
        permissions: [],
        message: ok ? undefined : 'xdotool/scrot not found — install xdotool and scrot',
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger?.debug({ err: message }, 'LocalLinuxProvider: toolchain probe failed');
      return {
        providerId: this.providerId,
        available: false,
        permissions: [],
        message: `Linux X11 tools unavailable: ${message}`,
      };
    }
  }

  async listApps(_ctx: Ctx): Promise<AppInfo[]> {
    return listLinuxApps(this.runner);
  }

  async createLease(ctx: Ctx, target: Target): Promise<Lease> {
    let windowId: string | undefined;
    let pid: number | undefined;
    const appName = target.appName;

    if (appName) {
      assertSafeAppName(appName);
      await this.runner.exec(`nohup ${quoteShellArg(appName)} >/dev/null 2>&1 &`);
      // Poll wmctrl up to 10 times (500 ms apart) until the window appears,
      // then resolve the process PID via xdotool (same as the SSH provider).
      for (let i = 0; i < 10 && windowId === undefined; i++) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        try {
          const wmResult = await this.runner.exec('wmctrl -l');
          const lines = wmResult.stdout.trim().split('\n').filter(Boolean);
          for (const line of lines) {
            const parts = line.split(/\s+/);
            if (parts.length >= 4) {
              const title = parts.slice(3).join(' ');
              if (title.toLowerCase().includes(appName.toLowerCase())) {
                windowId = parts[0];
                break;
              }
            }
          }
        } catch {
          // Continue polling.
        }
      }

      if (windowId) {
        try {
          const pidResult = await this.runner.exec(`xdotool getwindowpid ${windowId}`);
          const parsed = parseInt(pidResult.stdout.trim(), 10);
          if (!isNaN(parsed)) pid = parsed;
        } catch {
          // PID extraction is best-effort.
        }
      }
    } else {
      windowId = target.windowId;
      pid = target.pid ?? target.processId;
    }

    return {
      leaseId: `linux-local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      sessionPath: ctx.sessionPath ?? '',
      agentId: ctx.agentId ?? '',
      providerId: this.providerId,
      appId: appName ?? target.appId ?? 'unknown',
      windowId: windowId ?? undefined,
      createdAt: new Date().toISOString(),
      status: 'active',
      allowedActions: [
        'click_element',
        'double_click',
        'type_text',
        'press_key',
        'scroll',
        'click_point',
        'stop',
      ],
      providerState: {
        pid,
        windowId,
        display: process.env.DISPLAY || ':0',
      },
    };
  }

  async releaseLease(_ctx: Ctx, _lease: Lease): Promise<void> {
    // No cleanup needed for the local provider.
  }

  async stop(_ctx: Ctx, _lease: Lease): Promise<void> {
    // No persistent process to stop.
  }

  async getAppState(_ctx: Ctx, lease: Lease): Promise<AppState> {
    const providerState = lease.providerState as { pid?: number; windowId?: string } | undefined;
    const st = await readLinuxWindowState(this.runner, lease.leaseId, providerState?.windowId);
    if (st.elements.length === 0) {
      this.logger?.warn(
        { windowId: providerState?.windowId },
        'Linux accessibility tree returned no elements — the app may expose no AT-SPI tree; coordinate fallback only',
      );
    }
    return {
      mode: 'vision-native',
      screenshot: st.screenshotBase64
        ? { type: 'image', mimeType: 'image/png', data: st.screenshotBase64 }
        : undefined,
      display: {
        width: st.width,
        height: st.height,
        originalWidth: st.screenWidth,
        originalHeight: st.screenHeight,
      },
      elements: st.elements,
      windowTitle: st.windowTitle || undefined,
    };
  }

  async performAction(_ctx: Ctx, lease: Lease, action: Action): Promise<ActionResult> {
    return performLinuxAction(this.runner, action);
  }
}

function assertSafeAppName(appName: string): void {
  if (!/^[A-Za-z0-9._+-]+$/.test(appName)) {
    throw new Error(`Invalid application name: '${appName}'`);
  }
}
