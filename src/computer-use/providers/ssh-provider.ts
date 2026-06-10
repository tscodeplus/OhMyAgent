// src/computer-use/providers/ssh-provider.ts
//
// SSH-based ComputerUseProvider that controls a remote Linux desktop
// via SSH commands (scrot for screenshots, xdotool for mouse/keyboard).

import type { ComputerUseProvider } from '../provider-contract.js';
import { normalizeComputerProviderCapabilities } from '../provider-contract.js';
import type { Ctx, ProviderStatus, AppInfo, WindowInfo, Lease, Target, AppState, UIElement, Action, ActionResult } from '../types.js';
import type { ComputerUseSettings } from '../settings.js';
import { SSHPool } from '../transports/ssh-pool.js';
import type { Logger } from 'pino';
import {
  psListWindows, psGetForegroundInfo, psTakeScreenshot,
  psMouseClick, psDoubleClick, psSendKeys, psPressKey,
  psScroll, psLaunchApp, wrapPowerShell,
} from '../powershell-scripts.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Known xdotool key names (beyond alphanumeric chars). */
const SPECIAL_KEYS = new Set([
  'Return', 'Escape', 'Tab', 'BackSpace', 'Delete',
  'Home', 'End', 'Page_Up', 'Page_Down',
  'Up', 'Down', 'Left', 'Right',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
  'space', 'minus', 'equal', 'bracketleft', 'bracketright',
  'backslash', 'semicolon', 'apostrophe', 'comma', 'period', 'slash', 'grave',
]);

/**
 * Returns true if `key` is a single alphanumeric character or a known
 * xdotool special key name.
 */
function isValidKey(key: string): boolean {
  if (/^[a-zA-Z0-9]$/.test(key)) return true;
  return SPECIAL_KEYS.has(key);
}

/**
 * Escape a string for safe use inside a double-quoted SSH command argument.
 *
 * Applied transformations:
 *   - Backslash `\` → `\\`
 *   - Double quote `"` → `\"`
 *   - Dollar sign `$` → `\$`
 *   - Backtick `` ` `` → `` \` ``
 *   - Newline → space
 */
function escapeShellText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/`/g, '\\`')
    .replace(/\n/g, ' ');
}

function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build a safe `osascript` keystroke command for macOS.
 *
 * Two layers of quoting are involved and BOTH must be handled:
 *   1. AppleScript string literal — escape `\` and `"` so the text stays a
 *      single string argument to `keystroke`.
 *   2. POSIX shell — the whole `-e` script is passed as one argv element via
 *      single-quote wrapping (`quoteShellArg`), so a `'` / `$` / backtick in
 *      the user text can no longer break out of the quoting and inject a
 *      command. Previously only `\` and `"` were escaped and the script was
 *      wrapped in raw single quotes, so any `'` in the text escaped the shell
 *      quoting → arbitrary command execution over SSH.
 */
function macKeystrokeCommand(text: string): string {
  const appleScriptSafe = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = `tell application "System Events" to keystroke "${appleScriptSafe}"`;
  return `osascript -e ${quoteShellArg(script)}`;
}

function assertSafeAppName(appName: string): void {
  if (!/^[A-Za-z0-9._+-]+$/.test(appName)) {
    throw new Error(`Invalid application name: '${appName}'`);
  }
}

/**
 * Truncate stdout that exceeds 12000 characters, appending a note about the
 * original length.  This is intentionally *not* applied to screenshot base64
 * data which must remain intact.
 */
function truncateStdout(stdout: string): string {
  if (stdout.length > 12000) {
    return stdout.slice(0, 12000) + `...(truncated, ${stdout.length} chars)`;
  }
  return stdout;
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
    elementActions: true,
    elementDoubleClick: true,
    backgroundControl: 'full',
    pointClick: 'allowed',
    drag: 'unsupported',
    textInput: 'foreground',
    keyboardInput: 'pidScoped',
    requiresForegroundForInput: true,
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

  /** macOS key name -> key code mapping for osascript(1) key code commands. */
  private static readonly MAC_KEY_CODES: Record<string, number> = {
    'Return': 36, 'Enter': 36, 'Escape': 53, 'Esc': 53,
    'Tab': 48, 'BackSpace': 51, 'Delete': 117,
    'Home': 115, 'End': 119, 'Page_Up': 116, 'Page_Down': 121,
    'Up': 126, 'Down': 125, 'Left': 123, 'Right': 124,
    'F1': 122, 'F2': 120, 'F3': 99, 'F4': 118,
    'F5': 96, 'F6': 97, 'F7': 98, 'F8': 100,
    'F9': 101, 'F10': 109, 'F11': 103, 'F12': 111,
    'space': 49, 'Space': 49,
  };

  constructor(options: {
    sshPool: SSHPool;
    settings: ComputerUseSettings;
    logger?: Logger;
  }) {
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
      return this._listAppsMacOS();
    }
    if (remoteOS === 'win32') {
      return this._listAppsWindows();
    }

    // Primary path: wmctrl -l
    try {
      const result = await this.sshPool.exec('wmctrl -l');
      const stdout = truncateStdout(result.stdout);
      const lines = stdout.trim().split('\n').filter(Boolean);

      // Group windows by first word of the title.
      const appMap = new Map<string, WindowInfo[]>();

      for (const line of lines) {
        const parts = line.split(/\s+/);
        if (parts.length < 4) continue;
        const wid = parts[0];
        const title = parts.slice(3).join(' ');
        const firstWord = title.split(/\s+/)[0] || title;

        const win: WindowInfo = { windowId: wid, title };
        const existing = appMap.get(firstWord) ?? [];
        existing.push(win);
        appMap.set(firstWord, existing);
      }

      return Array.from(appMap.entries()).map(([name, windows]) => ({
        appId: `app.${name.toLowerCase()}`,
        name,
        windows,
        running: true,
      }));
    } catch {
      // Fallback: xdotool search --name '' && getwindowname for each window
      try {
        const searchResult = await this.sshPool.exec('xdotool search --name ""');
        const wids = searchResult.stdout.trim().split('\n').filter(Boolean);
        const apps: AppInfo[] = [];

        for (const wid of wids) {
          try {
            const nameResult = await this.sshPool.exec(`xdotool getwindowname ${wid}`);
            const title = nameResult.stdout.trim();
            if (!title) continue;

            const firstWord = title.split(/\s+/)[0];
            const existing = apps.find(a => a.name === firstWord);
            if (existing) {
              existing.windows.push({ windowId: wid, title });
            } else {
              apps.push({
                appId: `app.${firstWord.toLowerCase()}`,
                name: firstWord,
                windows: [{ windowId: wid, title }],
                running: true,
              });
            }
          } catch {
            // Skip windows we cannot read the name of.
          }
        }

        return apps;
      } catch {
        return [];
      }
    }
  }

  /**
   * List running macOS applications via osascript.  Returns visible processes
   * (those with visible windows on the desktop).
   */
  private async _listAppsMacOS(): Promise<AppInfo[]> {
    try {
      const result = await this.sshPool.exec(
        `osascript -e 'tell application "System Events" to get name of every process whose visible is true'`,
      );
      const names = result.stdout.split(',').map(s => s.trim()).filter(Boolean);
      return names.map(name => ({
        appId: name,
        name,
        running: true,
        windows: [],
      }));
    } catch {
      return [];
    }
  }

  private async _listAppsWindows(): Promise<AppInfo[]> {
    try {
      const { stdout } = await this.sshPool.exec(wrapPowerShell(psListWindows()), { timeoutMs: 10000 });
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
      return Array.from(apps.values()).map(a => ({
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

      // 3. Poll wmctrl up to 10 times (500 ms apart) until the window appears.
      for (let i = 0; i < 10; i++) {
        await new Promise(resolve => setTimeout(resolve, 500));
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
      | { pid?: number; windowId?: string; display?: string }
      | undefined;
    const windowId = providerState?.windowId || lease.windowId;
    const leaseId = lease.leaseId;

    const remoteOS = await this._detectRemoteOS();

    // 1. Activate the target window (best-effort, ignore errors).
    if (windowId && remoteOS === 'linux') {
      try {
        await this.sshPool.exec(`xdotool windowactivate ${windowId}`);
      } catch {
        // Non-critical.
      }
    }

    // 2. Capture a screenshot + base64 encode (OS-specific).
    let screenshotBase64 = '';
    if (remoteOS === 'darwin') {
      try {
        await this.sshPool.exec(`screencapture -x -T0 /tmp/cua_${leaseId}.png`);
        const b64Result = await this.sshPool.exec(`base64 -i /tmp/cua_${leaseId}.png`);
        screenshotBase64 = b64Result.stdout.trim();
        await this.sshPool.exec(`rm -f /tmp/cua_${leaseId}.png`).catch(() => {});
      } catch { /* screencapture failed */ }
    } else if (remoteOS === 'win32') {
      try {
        const winPath = `C:\\Windows\\Temp\\cua_${leaseId}.png`;
        const script = psTakeScreenshot(winPath);
        const result = await this.sshPool.exec(wrapPowerShell(script), { timeoutMs: 15000 });
        screenshotBase64 = result.stdout.split('\n').pop()?.trim() || '';
        await this.sshPool.exec(
          wrapPowerShell(`Remove-Item 'C:\\Windows\\Temp\\cua_${leaseId}.png' -ErrorAction SilentlyContinue`)
        ).catch(() => {});
      } catch { /* PowerShell screenshot failed */ }
    } else {
      let screenshotTaken = false;
      try {
        await this.sshPool.exec(`scrot -z /tmp/cua_${leaseId}.png`);
        screenshotTaken = true;
      } catch {
        try {
          await this.sshPool.exec(`import -window root /tmp/cua_${leaseId}.png`);
          screenshotTaken = true;
        } catch { /* both failed */ }
      }
      if (screenshotTaken) {
        try {
          const b64Result = await this.sshPool.exec(`base64 -w0 /tmp/cua_${leaseId}.png`);
          screenshotBase64 = b64Result.stdout.trim();
        } catch { /* encoding failed */ }
        await this.sshPool.exec(`rm -f /tmp/cua_${leaseId}.png`).catch(() => {});
      }
    }

    // 4. Window info — OS-specific.
    let windowTitle = '';
    let windowWidth = 1920;
    let windowHeight = 1080;
    let elements: UIElement[] = [];

    if (remoteOS === 'darwin') {
      try {
        const titleResult = await this.sshPool.exec(
          `osascript -e 'tell application "System Events" to get name of front process'`,
        );
        windowTitle = truncateStdout(titleResult.stdout.trim());
      } catch { /* Non-critical */ }
    } else if (remoteOS === 'win32') {
      try {
        const fgResult = await this.sshPool.exec(wrapPowerShell(psGetForegroundInfo()), { timeoutMs: 8000 });
        const lines = fgResult.stdout.split('\n');
        const jsonLine = lines.find(l => l.startsWith('{'));
        if (jsonLine) {
          const fgInfo = JSON.parse(jsonLine);
          windowTitle = fgInfo.title || '';
          windowWidth = fgInfo.desktopWidth || windowWidth;
          windowHeight = fgInfo.desktopHeight || windowHeight;
          elements = (fgInfo.elements || []).map((el: any, i: number) => ({
            elementId: el.elementId || `el-${i}`,
            role: el.role || 'pane',
            label: el.label || '',
            bounds: el.bounds || { x: 0, y: 0, width: 100, height: 30 },
            enabled: el.enabled !== false,
          }));
        }
      } catch { /* PowerShell window info failed */ }
    } else {
      try {
        const titleResult = await this.sshPool.exec('xdotool getactivewindow getwindowname');
        windowTitle = truncateStdout(titleResult.stdout.trim());
      } catch { /* Non-critical */ }

      try {
        const geoResult = await this.sshPool.exec(
          'xdotool getactivewindow getwindowgeometry --shell',
        );
        const geo = geoResult.stdout.trim();
        for (const line of geo.split('\n')) {
          const eqIdx = line.indexOf('=');
          if (eqIdx === -1) continue;
          const key = line.slice(0, eqIdx);
          const value = line.slice(eqIdx + 1);
          if (key === 'WIDTH') {
            windowWidth = parseInt(value, 10) || windowWidth;
          } else if (key === 'HEIGHT') {
            windowHeight = parseInt(value, 10) || windowHeight;
          }
        }
      } catch { /* Use defaults */ }
    }

    // Read full display geometry for Linux.
    let screenWidth = windowWidth;
    let screenHeight = windowHeight;
    if (remoteOS === 'linux') {
      try {
        const displayGeo = await this.sshPool.exec('xdotool getdisplaygeometry');
        const parts = displayGeo.stdout.trim().split(/\s+/);
        if (parts.length >= 2) {
          screenWidth = parseInt(parts[0], 10) || screenWidth;
          screenHeight = parseInt(parts[1], 10) || screenHeight;
        }
      } catch { /* fallback */ }
    }

    // Accessibility tree — only if elements is still empty (Linux path).
    if (elements.length === 0) {
      elements.push(...await this.readAccessibilityTree(leaseId));
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
    };
  }

  /**
   * Attempt to read the accessibility (AT-SPI2) tree from the remote host.
   * Returns an empty array when python3-pyatspi is not installed, degrading
   * to coordinate-only interaction mode.
   */
  private async readAccessibilityTree(_leaseId: string): Promise<UIElement[]> {
    // To keep the implementation pragmatic for Phase 1 we simply test whether
    // the at-spi2 infrastructure is available. Full tree parsing will be added
    // in a later phase.
    try {
      await this.sshPool.exec(
        `python3 -c "
import sys
try:
    import pyatspi  # noqa: F401
    print('ATSPI_OK')
except ImportError:
    sys.exit(1)
"`,
        { timeoutMs: 10_000 },
      );
      // at-spi2 is available — future phases will parse the full tree.
    } catch {
      // Not available — coordinate-only mode.
    }
    return [];
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
    if (this._remotePlatform && (now - this._remotePlatformDetectedAt) < SSHComputerUseProvider.OS_CACHE_TTL_MS) {
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

  async performAction(
    _ctx: Ctx,
    _lease: Lease,
    action: Action,
  ): Promise<ActionResult> {
    let command: string;
    const remoteOS = await this._detectRemoteOS();

    switch (action.type) {
      case 'click_element':
      case 'click_point': {
        if (action.type === 'click_element' && !action.snapshotElement) {
          return {
            ok: false,
            action: action.type,
            error: 'No snapshotElement provided for click_element',
          };
        }
        const cx = action.snapshotElement
          ? Math.round(action.snapshotElement.bounds.x + action.snapshotElement.bounds.width / 2)
          : (action.x ?? 0);
        const cy = action.snapshotElement
          ? Math.round(action.snapshotElement.bounds.y + action.snapshotElement.bounds.height / 2)
          : (action.y ?? 0);
        if (remoteOS === 'darwin') {
          command = `osascript -e 'tell application "System Events" to click at {${cx}, ${cy}}'`;
        } else if (remoteOS === 'win32') {
          command = wrapPowerShell(psMouseClick(cx, cy));
        } else {
          command = `xdotool mousemove ${cx} ${cy} click 1`;
        }
        break;
      }

      case 'type_text': {
        if (!action.text) {
          return {
            ok: false,
            action: action.type,
            error: 'No text provided for type_text',
          };
        }
        if (remoteOS === 'darwin') {
          command = macKeystrokeCommand(action.text);
        } else if (remoteOS === 'win32') {
          command = wrapPowerShell(psSendKeys(action.text));
        } else {
          const escaped = escapeShellText(action.text);
          command = `xdotool type --delay 50 "${escaped}"`;
        }
        break;
      }

      case 'press_key': {
        if (!action.key) {
          return {
            ok: false,
            action: action.type,
            error: 'No key provided for press_key',
          };
        }
        if (remoteOS === 'darwin') {
          const code = SSHComputerUseProvider.MAC_KEY_CODES[action.key];
          if (code !== undefined) {
            command = `osascript -e 'tell application "System Events" to key code ${code}'`;
          } else if (action.key.length === 1) {
            command = macKeystrokeCommand(action.key);
          } else {
            return {
              ok: false,
              action: action.type,
              error: `Unsupported macOS key: '${action.key}'`,
            };
          }
        } else if (remoteOS === 'win32') {
          command = wrapPowerShell(psPressKey(action.key));
        } else {
          if (!isValidKey(action.key)) {
            return {
              ok: false,
              action: action.type,
              error: `Invalid key: '${action.key}'`,
            };
          }
          command = `xdotool key "${action.key}"`;
        }
        break;
      }

      case 'scroll': {
        const direction = action.direction ?? 'down';
        const amount = action.amount ?? 1;
        if (remoteOS === 'darwin') {
          const repeat = Math.min(amount, 20);
          const code: Record<string, number> = {
            up: 126, down: 125, left: 123, right: 124,
          };
          const keyCode = code[direction] ?? 125;
          command = Array.from({ length: repeat }, () =>
            `osascript -e 'tell application "System Events" to key code ${keyCode}'`,
          ).join(' && ');
        } else if (remoteOS === 'win32') {
          command = wrapPowerShell(psScroll(direction, amount));
        } else {
          const buttonMap: Record<string, number> = {
            up: 4,
            down: 5,
            left: 6,
            right: 7,
          };
          const button = buttonMap[direction] ?? 5;
          command = `xdotool click ${button} --repeat ${amount}`;
        }
        break;
      }

      case 'double_click': {
        if (remoteOS === 'darwin') {
          if (action.snapshotElement) {
            const b = action.snapshotElement.bounds;
            const dblCx = Math.round(b.x + b.width / 2);
            const dblCy = Math.round(b.y + b.height / 2);
            command = `osascript -e 'tell application "System Events" to click at {${dblCx}, ${dblCy}}' && sleep 0.1 && osascript -e 'tell application "System Events" to click at {${dblCx}, ${dblCy}}'`;
          } else {
            const dblX = action.x ?? 0;
            const dblY = action.y ?? 0;
            command = `osascript -e 'tell application "System Events" to click at {${dblX}, ${dblY}}' && sleep 0.1 && osascript -e 'tell application "System Events" to click at {${dblX}, ${dblY}}'`;
          }
        } else if (remoteOS === 'win32') {
          if (action.snapshotElement) {
            const b = action.snapshotElement.bounds;
            command = wrapPowerShell(psDoubleClick(Math.round(b.x + b.width / 2), Math.round(b.y + b.height / 2)));
          } else {
            command = wrapPowerShell(psDoubleClick(action.x ?? 0, action.y ?? 0));
          }
        } else {
          if (action.snapshotElement) {
            const b = action.snapshotElement.bounds;
            const dblCx = Math.round(b.x + b.width / 2);
            const dblCy = Math.round(b.y + b.height / 2);
            command = `xdotool mousemove ${dblCx} ${dblCy} click --repeat 2 1`;
          } else {
            const dblX = action.x ?? 0;
            const dblY = action.y ?? 0;
            command = `xdotool mousemove ${dblX} ${dblY} click --repeat 2 1`;
          }
        }
        break;
      }

      case 'stop':
        return { ok: true, action: 'stop' };

      default:
        return {
          ok: false,
          action: action.type,
          error: `Unsupported action type: '${action.type}'`,
        };
    }

    // Execute the constructed command on the remote host.
    try {
      await this.sshPool.exec(command);
      return { ok: true, action: action.type };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, action: action.type, error: message };
    }
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
