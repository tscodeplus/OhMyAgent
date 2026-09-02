// src/computer-use/providers/ssh-provider.ts
//
// SSH-based ComputerUseProvider that controls a remote desktop
// (Linux / macOS / Windows) via SSH commands. Platform-specific window-state
// reading and action execution live in ssh-actions-{linux,darwin,win32}.ts;
// this file is the dispatcher (OS detection, lease lifecycle, listing).

import type { ComputerUseProvider } from '../provider-contract.js';
import { normalizeComputerProviderCapabilities } from '../provider-contract.js';
import type {
  Ctx,
  ProviderStatus,
  AppInfo,
  WindowInfo,
  Lease,
  Target,
  AppState,
  UIElement,
  Action,
  ActionResult,
} from '../types.js';
import type { ComputerUseSettings } from '../settings.js';
import { SSHPool } from '../transports/ssh-pool.js';
import type { Logger } from 'pino';
import { psListWindows, wrapPowerShell } from '../powershell-scripts.js';
import { listLinuxApps, readLinuxWindowState, performLinuxAction } from '../ssh-actions-linux.js';
import {
  listDarwinApps,
  readDarwinWindowState,
  performDarwinAction,
  DARWIN_LOCKED_NOTICE,
} from '../ssh-actions-darwin.js';
import { readWin32WindowState, performWin32Action } from '../ssh-actions-win32.js';
import { quoteShellArg } from '../ssh-actions-common.js';

function assertSafeAppName(appName: string): void {
  // Spaces allowed — real app names are "Microsoft Edge" / "Google Chrome".
  // The name is embedded in an AppleScript string literal and passed
  // through quoteShellArg, so quotes and shell metacharacters remain
  // forbidden.
  if (!/^[A-Za-z0-9._+\- ]+$/.test(appName)) {
    throw new Error(`Invalid application name: '${appName}'`);
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class SSHComputerUseProvider implements ComputerUseProvider {
  readonly providerId = 'ssh';
  readonly capabilities = normalizeComputerProviderCapabilities({
    platform: 'linux',
    observationModes: ['vision-native'],
    screenshot: true,
    accessibilityTree: true,
    // Shared by all three SSH platforms (Linux AT-SPI / macOS AX / win32 UIA):
    // element actions and text input go through the accessibility tree
    // (semantic, no foreground requirement); press_key is pidScoped and
    // background: macOS posts CGEventPostToPid into the app's event queue
    // (no foreground), win32 uses PostMessage. Linux xdotool key still needs
    // the target window focused, so the shared capability stays 'partial'.
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

  private readonly sshPool: SSHPool;
  private readonly settings: ComputerUseSettings;
  private readonly logger?: Logger;

  /** Cache for remote OS detection (null = not yet detected). */
  private _remotePlatform: string | null = null;
  /** Timestamp of the last OS detection, for TTL-based invalidation. */
  private _remotePlatformDetectedAt = 0;
  /** Re-detect remote OS after this many ms (default: 5 minutes). */
  private static readonly OS_CACHE_TTL_MS = 5 * 60 * 1000;

  constructor(options: { sshPool: SSHPool; settings: ComputerUseSettings; logger?: Logger }) {
    this.sshPool = options.sshPool;
    this.settings = options.settings;
    this.logger = options.logger;
  }

  // -----------------------------------------------------------------------
  // Status
  // -----------------------------------------------------------------------

  async getStatus(_ctx: Ctx): Promise<ProviderStatus> {
    const result = await this.sshPool.healthCheck();
    return {
      providerId: 'ssh',
      available: result.reachable,
      permissions: [],
      message: result.reachable ? undefined : 'SSH connection failed',
    };
  }

  // -----------------------------------------------------------------------
  // Application listing
  // -----------------------------------------------------------------------

  async listApps(_ctx: Ctx): Promise<AppInfo[]> {
    const remoteOS = await this._detectRemoteOS();
    if (remoteOS === 'darwin') {
      return listDarwinApps(this.sshPool);
    }
    if (remoteOS === 'win32') {
      return this._listAppsWindows();
    }
    return listLinuxApps(this.sshPool);
  }

  private async _listAppsWindows(): Promise<AppInfo[]> {
    try {
      const { stdout } = await this.sshPool.exec(wrapPowerShell(psListWindows()), {
        timeoutMs: 10000,
      });
      const apps = new Map<string, { name: string; pid: number; windows: WindowInfo[] }>();
      for (const line of stdout.split('\n')) {
        if (!line.startsWith('APP|')) continue;
        const [, procName, pidStr, hwnd, title] = line.split('|');
        const name = procName || 'unknown';
        const pid = parseInt(pidStr, 10);
        if (!apps.has(name)) {
          apps.set(name, { name, pid, windows: [] });
        }
        apps.get(name)!.windows.push({
          windowId: hwnd || `pid-${pid}`,
          title: title || name,
          isOnScreen: true,
        });
      }
      return Array.from(apps.values()).map((a) => ({
        appId: a.name,
        name: a.name,
        pid: a.pid,
        running: true,
        windows: a.windows,
      }));
    } catch {
      return [];
    }
  }

  // -----------------------------------------------------------------------
  // Lease lifecycle
  // -----------------------------------------------------------------------

  async createLease(ctx: Ctx, target: Target): Promise<Lease> {
    let pid: number | undefined;
    let windowId: string | undefined;
    const appName = target.appName;

    if (appName) {
      assertSafeAppName(appName);

      // 1. Verify the application exists on the remote system.
      try {
        await this.sshPool.exec(`command -v -- ${quoteShellArg(appName)}`);
      } catch {
        throw new Error(`Application '${appName}' not found on remote system`);
      }

      // 2. Launch the application in the background.
      await this.sshPool.exec(`nohup ${quoteShellArg(appName)} >/dev/null 2>&1 &`);

      // 3. Resolve the running process — platform-specific (wmctrl/xdotool
      // do not exist on macOS; pgrep exists on both).
      const remoteOS = await this._detectRemoteOS();
      if (remoteOS === 'darwin') {
        // macOS: the AX tree is addressed by pid, so the pid is what
        // matters. pgrep -f matches the just-launched process (the remote
        // shell itself is excluded via $$) and tail -1 picks the newest.
        try {
          const pidResult = await this.sshPool.exec(
            `pgrep -f -i ${quoteShellArg(appName)} | grep -v "^$$\$" | tail -1`,
          );
          const parsed = parseInt(pidResult.stdout.trim(), 10);
          if (!isNaN(parsed)) pid = parsed;
        } catch {
          // PID extraction is best-effort.
        }
      } else {
        // Linux (and Windows via the shared fallback): poll wmctrl up to
        // 10 times (500 ms apart) until the window appears.
        for (let i = 0; i < 10; i++) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          try {
            const wmResult = await this.sshPool.exec('wmctrl -l');
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
            if (windowId) break;
          } catch {
            // Continue polling.
          }
        }

        // 4. Extract the process PID via xdotool.
        if (windowId) {
          try {
            const pidResult = await this.sshPool.exec(`xdotool getwindowpid ${windowId}`);
            const parsed = parseInt(pidResult.stdout.trim(), 10);
            if (!isNaN(parsed)) pid = parsed;
          } catch {
            // PID extraction is best-effort.
          }
        }
      }
    } else {
      // Use the identifiers the caller supplied directly.
      windowId = target.windowId;
      pid = target.pid ?? target.processId;
    }

    return {
      leaseId: `ssh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      sessionPath: ctx.sessionPath ?? '',
      agentId: ctx.agentId ?? '',
      providerId: 'ssh',
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
        display: this.settings.ssh.display,
      },
    };
  }

  // -----------------------------------------------------------------------
  // App state observation
  // -----------------------------------------------------------------------

  async getAppState(_ctx: Ctx, lease: Lease): Promise<AppState> {
    const providerState = lease.providerState as
      { pid?: number; windowId?: string; display?: string } | undefined;
    const leaseId = lease.leaseId;
    const remoteOS = await this._detectRemoteOS();

    let screenshotBase64 = '';
    let windowTitle = '';
    let notice: string | undefined;
    let windowWidth = 1920;
    let windowHeight = 1080;
    let screenWidth = windowWidth;
    let screenHeight = windowHeight;
    let elements: UIElement[] = [];

    if (remoteOS === 'darwin') {
      const st = await readDarwinWindowState(
        this.sshPool,
        leaseId,
        providerState?.pid, // AX tree targets the leased app; undefined = focused app
      );
      screenshotBase64 = st.screenshotBase64;
      windowTitle = st.windowTitle;
      elements = st.elements;
      if (st.axError) {
        this.logger?.warn({ axError: st.axError }, 'macOS accessibility tree unavailable');
      } else if (st.elements.length === 0) {
        this.logger?.warn(
          { pid: providerState?.pid },
          'macOS accessibility tree returned no elements — the app may expose no AX tree; screenshot fallback only',
        );
      }
      if (st.locked) {
        this.logger?.warn('macOS screen is at the login/lock screen (loginwindow)');
        notice = DARWIN_LOCKED_NOTICE;
      }
    } else if (remoteOS === 'win32') {
      const st = await readWin32WindowState(
        this.sshPool,
        leaseId,
        providerState?.windowId || lease.windowId,
      );
      screenshotBase64 = st.screenshotBase64;
      windowTitle = st.windowTitle;
      windowWidth = st.width;
      windowHeight = st.height;
      screenWidth = st.screenWidth;
      screenHeight = st.screenHeight;
      elements = st.elements;
    } else {
      const st = await readLinuxWindowState(
        this.sshPool,
        leaseId,
        providerState?.windowId || lease.windowId,
      );
      screenshotBase64 = st.screenshotBase64;
      windowTitle = st.windowTitle;
      windowWidth = st.width;
      windowHeight = st.height;
      screenWidth = st.screenWidth;
      screenHeight = st.screenHeight;
      elements = st.elements;
    }

    return {
      mode: 'vision-native',
      screenshot: screenshotBase64
        ? { type: 'image', mimeType: 'image/png', data: screenshotBase64 }
        : undefined,
      display: {
        width: windowWidth,
        height: windowHeight,
        originalWidth: screenWidth,
        originalHeight: screenHeight,
      },
      elements,
      windowTitle: windowTitle || undefined,
      notice,
    };
  }

  // -----------------------------------------------------------------------
  // Remote OS detection
  // -----------------------------------------------------------------------

  /**
   * Detect the remote operating system by running `uname -s` via the SSH pool.
   * Results are cached with a TTL (default 5 min) to handle reconnection to
   * a different OS host.
   *
   * Returns 'darwin', 'linux', or 'win32'.  Falls back to 'linux' when the
   * remote host cannot be reached.
   */
  private async _detectRemoteOS(): Promise<string> {
    const now = Date.now();
    if (
      this._remotePlatform &&
      now - this._remotePlatformDetectedAt < SSHComputerUseProvider.OS_CACHE_TTL_MS
    ) {
      return this._remotePlatform;
    }
    try {
      const result = await this.sshPool.exec('uname -s');
      const name = result.stdout.trim().toLowerCase();
      if (name.includes('darwin')) {
        this._remotePlatform = 'darwin';
      } else if (name.includes('linux')) {
        this._remotePlatform = 'linux';
      } else if (name.includes('mingw') || name.includes('msys') || name.includes('cygwin')) {
        this._remotePlatform = 'win32';
      } else {
        this._remotePlatform = 'linux';
      }
    } catch {
      // Keep old cached value on transient failure when TTL hasn't expired
      if (!this._remotePlatform) {
        this._remotePlatform = 'linux';
      }
    }
    this._remotePlatformDetectedAt = now;
    return this._remotePlatform;
  }

  // -----------------------------------------------------------------------
  // Action execution
  // -----------------------------------------------------------------------

  async performAction(_ctx: Ctx, lease: Lease, action: Action): Promise<ActionResult> {
    const remoteOS = await this._detectRemoteOS();
    const providerState = lease.providerState as { pid?: number; windowId?: string } | undefined;

    if (remoteOS === 'darwin') {
      // AX element actions must target the *leased* app, never the user's
      // focused app — the pid is embedded in the JXA script.
      const textTargetPath = (providerState as { lastTextTargetPath?: string } | undefined)
        ?.lastTextTargetPath;
      const result = await performDarwinAction(
        this.sshPool,
        action,
        providerState?.pid,
        textTargetPath,
      );
      // Track where text was last set so a following Enter can AXConfirm
      // that element (background apps keep the window focused; see
      // ssh-actions-darwin).
      if (result.ok && action.type === 'type_text') {
        const path = action.snapshotElement?.elementId ?? action.elementId;
        if (path && lease.providerState) lease.providerState.lastTextTargetPath = path;
      }
      return result;
    }
    if (remoteOS === 'win32') {
      return performWin32Action(this.sshPool, action, providerState?.windowId || lease.windowId);
    }
    return performLinuxAction(this.sshPool, action);
  }

  // -----------------------------------------------------------------------
  // Clean-up
  // -----------------------------------------------------------------------

  async releaseLease(_ctx: Ctx, lease: Lease): Promise<void> {
    // Remove the remote screenshot file (best-effort).
    try {
      await this.sshPool.exec(`rm -f /tmp/cua_${lease.leaseId}.png`);
    } catch {
      // Non-critical.
    }
  }

  async stop(_ctx: Ctx, _lease: Lease): Promise<void> {
    // Phase 1: no SIGTERM to the remote process — clean-up only.
    // Future phases may send SIGTERM to the PID stored in lease.providerState.
  }
}
