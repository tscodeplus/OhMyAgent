// src/computer-use/providers/local-darwin.ts
//
// Local macOS ComputerUseProvider (accessibility-first). Drives the exact
// same JXA AX action layer as the SSH provider (ssh-actions-darwin.ts) but
// executes the commands through child_process on this machine — no SSH, no
// nut.js input injection. Replaces NutJSProvider on macOS, which had no
// element tree (click_element was unsupported) and injected global CGEvents
// (physical mouse movement, synthesized keystrokes, clipboard-free but
// foreground-bound typing).

import type { Logger } from 'pino';
import type { ComputerUseProvider } from '../provider-contract.js';
import { normalizeComputerProviderCapabilities } from '../provider-contract.js';
import type {
  Ctx, AppInfo, ProviderStatus, Lease, Target, AppState, Action, ActionResult,
} from '../types.js';
import { createLocalExecRunner, quoteShellArg, type ExecRunner } from '../ssh-actions-common.js';
import {
  listDarwinApps, readDarwinWindowState, performDarwinAction, DARWIN_LOCKED_NOTICE,
} from '../ssh-actions-darwin.js';

export class LocalDarwinProvider implements ComputerUseProvider {
  readonly providerId = 'darwin:local';

  // Same capabilities as the SSH darwin branch: element actions, text input
  // and press_key all go through the AX tree / CGEventPostToPid (semantic
  // background delivery, no foreground requirement — see ssh-actions-darwin).
  readonly capabilities = normalizeComputerProviderCapabilities({
    platform: 'darwin',
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
    // macOS needs no DISPLAY prefix.
    this.runner = options?.runner ?? createLocalExecRunner();
  }

  async getStatus(_ctx: Ctx): Promise<ProviderStatus> {
    try {
      // osascript + System Events reachable ⇒ AX automation is available
      // (TCC granted or promptable). Failures surface as unavailable.
      await this.runner.exec(
        `osascript -e 'tell application "System Events" to get name of front process'`,
        { timeoutMs: 10_000 },
      );
      return {
        providerId: this.providerId,
        available: true,
        permissions: [{ name: 'macos-accessibility', granted: true }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger?.debug({ err: message }, 'LocalDarwinProvider: osascript probe failed');
      return {
        providerId: this.providerId,
        available: false,
        permissions: [],
        message: `macOS accessibility unavailable: ${message}`,
      };
    }
  }

  async listApps(_ctx: Ctx): Promise<AppInfo[]> {
    return listDarwinApps(this.runner);
  }

  async createLease(ctx: Ctx, target: Target): Promise<Lease> {
    let pid: number | undefined;
    if (target.appName) {
      assertSafeAppName(target.appName);
      // `open -g -a <name>` launches via LaunchServices without activating
      // the app (--background: the window appears but the foreground is not
      // stolen). Flag order matters: `open -a -g` misparses `-g` as the `-a`
      // app-name argument and treats <name> as a file to open (failing with
      // "Unable to find application named '-g'"). The AX tree is addressed
      // by pid, so resolve it with an exact process-name match — pgrep -f
      // would also match the app's helper processes (e.g. "Safari Web
      // Content"), whose empty AX trees make every action fail.
      await this.runner.exec(`open -g -a ${quoteShellArg(target.appName)}`);
      for (let i = 0; i < 5 && pid === undefined; i++) {
        await new Promise(resolve => setTimeout(resolve, 500));
        pid = await resolveAppPid(this.runner, target.appName);
      }
    } else {
      pid = target.pid ?? target.processId;
    }

    return {
      leaseId: `darwin-local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      sessionPath: ctx.sessionPath ?? '',
      agentId: ctx.agentId ?? '',
      providerId: this.providerId,
      appId: target.appName ?? target.appId ?? 'unknown',
      windowId: target.windowId ?? undefined,
      createdAt: new Date().toISOString(),
      status: 'active',
      allowedActions: [
        'click_element', 'double_click', 'type_text', 'press_key', 'scroll',
        'click_point', 'stop',
      ],
      providerState: { pid },
    };
  }

  async releaseLease(_ctx: Ctx, _lease: Lease): Promise<void> {
    // No cleanup needed for the local provider.
  }

  async stop(_ctx: Ctx, _lease: Lease): Promise<void> {
    // No persistent process to stop.
  }

  async getAppState(_ctx: Ctx, lease: Lease): Promise<AppState> {
    const providerState = lease.providerState as { pid?: number } | undefined;
    const st = await readDarwinWindowState(this.runner, lease.leaseId, providerState?.pid);
    if (st.axError) {
      this.logger?.warn({ axError: st.axError }, 'macOS accessibility tree unavailable');
    } else if (st.elements.length === 0) {
      this.logger?.warn(
        { pid: providerState?.pid },
        'macOS accessibility tree returned no elements — the app may expose no AX tree; screenshot fallback only',
      );
    }
    return {
      mode: 'vision-native',
      screenshot: st.screenshotBase64
        ? { type: 'image', mimeType: 'image/png', data: st.screenshotBase64 }
        : undefined,
      display: { width: 1920, height: 1080 },
      elements: st.elements,
      windowTitle: st.windowTitle || undefined,
      notice: st.locked ? DARWIN_LOCKED_NOTICE : undefined,
    };
  }

  async performAction(_ctx: Ctx, lease: Lease, action: Action): Promise<ActionResult> {
    const providerState = lease.providerState as { pid?: number } | undefined;
    return performDarwinAction(this.runner, action, providerState?.pid);
  }
}

function assertSafeAppName(appName: string): void {
  if (!/^[A-Za-z0-9._+-]+$/.test(appName)) {
    throw new Error(`Invalid application name: '${appName}'`);
  }
}

/**
 * Resolve the pid of a launched app by exact process-name match. System
 * Events is the primary query (the names listApps reports); pgrep -x is the
 * fallback when Accessibility permission is missing. Exact-name matching
 * never picks helper processes, whose paths/names contain the app name.
 * appName is restricted to [A-Za-z0-9._+-] by assertSafeAppName, so it needs
 * no escaping inside the AppleScript string.
 */
async function resolveAppPid(runner: ExecRunner, appName: string): Promise<number | undefined> {
  try {
    const res = await runner.exec(
      `osascript -e ${quoteShellArg(
        `tell application "System Events" to get unix id of first process whose name is "${appName}"`,
      )}`,
    );
    const parsed = parseInt(res.stdout.trim(), 10);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  } catch { /* No AX permission — pgrep fallback below. */ }
  try {
    const res = await runner.exec(`pgrep -ix ${quoteShellArg(appName)} | tail -1`);
    const parsed = parseInt(res.stdout.trim(), 10);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  } catch { /* Best-effort. */ }
  return undefined;
}
