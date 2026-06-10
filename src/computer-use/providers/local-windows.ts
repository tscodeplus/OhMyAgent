/**
 * Local Windows Provider — controls the Windows host directly via powershell.exe.
 * Used when OhMyAgent runs in WSL and needs to control the Windows desktop.
 * No SSH required — uses child_process.exec to run PowerShell commands.
 */

import type { ComputerUseProvider } from '../provider-contract.js';
import { normalizeComputerProviderCapabilities } from '../provider-contract.js';
import type {
  Ctx, ProviderStatus, AppInfo, WindowInfo,
  Lease, Target, AppState, UIElement, Action, ActionResult,
} from '../types.js';
import type { ComputerUseSettings } from '../settings.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import type { Logger } from 'pino';
import {
  psListWindows, psGetForegroundInfo, psTakeScreenshot,
  psMouseClick, psDoubleClick, psSendKeys, psPressKey,
  psScroll, psLaunchApp, psCloseApp, psFocusApp, wrapPowerShell,
} from '../powershell-scripts.js';

const execAsync = promisify(exec);

import { truncateToolOutput } from '../../shared/truncation.js';

/** Extract and return CU_DEBUG lines from PowerShell output for structured logging. */
function extractDebugLines(stdout: string): string[] {
  const lines: string[] = [];
  for (const line of stdout.split('\n')) {
    if (line.includes('CU_DEBUG|')) {
      lines.push(line.trim());
    }
  }
  return lines;
}

async function runPowerShell(script: string, timeoutMs = 15000): Promise<{ stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execAsync(
      wrapPowerShell(script),
      { timeout: timeoutMs, maxBuffer: 50 * 1024 * 1024, windowsHide: true },
    );
    return { stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (err: any) {
    if (err.killed) {
      return { stdout: '', stderr: `Command timed out after ${timeoutMs}ms` };
    }
    return { stdout: err.stdout?.trim() || '', stderr: err.stderr?.trim() || err.message };
  }
}

// ═══════════════════════════════════════════════════════════
// Provider
// ═══════════════════════════════════════════════════════════

export class LocalWindowsProvider implements ComputerUseProvider {
  readonly providerId = 'windows:local';
  readonly capabilities = normalizeComputerProviderCapabilities({
    platform: 'win32',
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
    requiresForegroundForInput: false,
    nativeCursor: false,
    isolated: false,
    supportsFocusApp: true,
    supportsCloseApp: true,
  });

  private _logger?: Logger;

  constructor(options?: { logger?: Logger }) {
    this._logger = options?.logger;
  }

  async getStatus(_ctx: Ctx): Promise<ProviderStatus> {
    return { providerId: this.providerId, available: true, permissions: [] };
  }

  async listApps(_ctx: Ctx): Promise<AppInfo[]> {
    const { stdout } = await runPowerShell(psListWindows());
    const apps = new Map<string, { name: string; pid: number; windows: WindowInfo[] }>();

    for (const line of stdout.split('\n')) {
      if (!line.startsWith('APP|')) continue;
      const [, procName, pidStr, hwnd, title] = line.split('|');
      const name = procName || 'unknown';
      const pid = parseInt(pidStr, 10);
      const key = name;

      if (!apps.has(key)) {
        apps.set(key, { name, pid, windows: [] });
      }
      apps.get(key)!.windows.push({
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
  }

  async closeApp(_ctx: Ctx, target: string): Promise<void> {
    const result = await runPowerShell(psCloseApp(target), 10000);
    if (result.stderr) {
      throw new Error(`Failed to close Windows app "${target}": ${result.stderr}`);
    }
  }

  async createLease(ctx: Ctx, target: Target): Promise<Lease> {
    // Launch app if name provided and not activateOnly
    if (target.appName && !target.activateOnly) {
      const launch = await runPowerShell(psLaunchApp(target.appName), 30000);
      const debugLines = extractDebugLines(launch.stdout);
      if (debugLines.length > 0) {
        this._logger?.info({ target: target.appName, action: 'launch', debugLines }, 'psLaunchApp debug');
      }
      if (launch.stderr) {
        throw new Error(`Failed to launch Windows app "${target.appName}": ${launch.stderr}`);
      }
    }
    // activateOnly: just focus the already-running window
    if (target.appName && target.activateOnly) {
      const focus = await runPowerShell(psFocusApp(target.appName), 15000);
      const debugLines = extractDebugLines(focus.stdout);
      if (debugLines.length > 0) {
        this._logger?.info({ target: target.appName, action: 'focus', debugLines }, 'psFocusApp debug');
      }
      if (focus.stderr) {
        throw new Error(`Failed to focus Windows app "${target.appName}": ${focus.stderr}`);
      }
    }

    // Get foreground window info for the lease
    const { stdout, stderr } = await runPowerShell(psGetForegroundInfo());
    if (stderr && !stdout) {
      throw new Error(`Failed to read Windows foreground window: ${stderr}`);
    }
    let windowTitle = '';
    let windowRect = { x: 0, y: 0, width: 0, height: 0 };
    try {
      const info = JSON.parse(stdout.split('\n').pop() || '{}');
      windowTitle = info.title || target.appName || '';
      windowRect = info.windowRect || windowRect;
    } catch { /* use defaults */ }

    const leaseId = `win-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return {
      leaseId,
      sessionPath: ctx.sessionPath ?? '',
      agentId: ctx.agentId ?? '',
      providerId: this.providerId,
      appId: target.appName || target.appId || 'desktop',
      windowId: target.windowId,
      createdAt: new Date().toISOString(),
      status: 'active',
      allowedActions: [
        'click_element', 'click_point', 'type_text', 'press_key',
        'scroll', 'double_click', 'perform_secondary_action', 'stop',
      ],
      providerState: { windowTitle, windowRect, targetApp: target.appName },
    };
  }

  async releaseLease(_ctx: Ctx, _lease: Lease): Promise<void> {
    // No cleanup needed for local Windows
  }

  async getAppState(_ctx: Ctx, lease: Lease): Promise<AppState> {
    const screenshotPath = `C:\\Windows\\Temp\\cua_${lease.leaseId}.png`;
    const startTime = Date.now();

    // Screenshot temp file is cleaned up inside the PowerShell script itself
    const screenshotPromise = runPowerShell(psTakeScreenshot(screenshotPath), 10000);
    const fgPromise = runPowerShell(psGetForegroundInfo(), 5000);

    const [screenshotResult, fgResult] = await Promise.all([screenshotPromise, fgPromise]);

    const base64Data = screenshotResult.stdout.split('\n').pop()?.trim() || '';
    const elapsedMs = Date.now() - startTime;
    this._logger?.info({
      leaseId: lease.leaseId,
      base64Len: base64Data.length,
      stdoutLen: screenshotResult.stdout.length,
      stderr: screenshotResult.stderr?.slice(0, 200),
      elapsedMs,
    }, 'getAppState screenshot captured');

    if (screenshotResult.stderr || !base64Data) {
      this._logger?.error({
        stderr: screenshotResult.stderr,
        stdoutLen: screenshotResult.stdout.length,
        base64Empty: !base64Data,
        elapsedMs,
      }, 'getAppState screenshot failed');
      throw new Error(
        `Failed to capture Windows screenshot: ${screenshotResult.stderr || 'empty screenshot data'}`,
      );
    }

    let fgInfo: any = {};
    try {
      // Parse last line as JSON
      const lines = fgResult.stdout.split('\n');
      const jsonLine = lines.find(l => l.startsWith('{'));
      if (jsonLine) fgInfo = JSON.parse(jsonLine);
    } catch {
      if (fgResult.stderr) {
        this._logger?.warn({ stderr: fgResult.stderr }, 'Failed to parse Windows foreground info');
      }
    }

    const elements: UIElement[] = (fgInfo.elements || []).map((el: any, i: number) => ({
      elementId: el.elementId || `el-${i}`,
      role: el.role || 'pane',
      label: el.label || '',
      bounds: el.bounds || { x: 0, y: 0, width: 100, height: 30 },
      enabled: el.enabled !== false,
    }));

    return {
      mode: 'vision-native',
      screenshot: base64Data ? {
        type: 'image',
        mimeType: 'image/png',
        data: base64Data,
      } : undefined,
      display: {
        width: fgInfo.desktopWidth || 1920,
        height: fgInfo.desktopHeight || 1080,
      },
      elements,
      windowTitle: fgInfo.title || lease.providerState?.windowTitle,
    };
  }

  async performAction(_ctx: Ctx, _lease: Lease, action: Action): Promise<ActionResult> {
    let command = '';

    switch (action.type) {
      case 'click_element': {
        // Use element bounds center
        const el = action.snapshotElement;
        if (el?.bounds) {
          const cx = el.bounds.x + el.bounds.width / 2;
          const cy = el.bounds.y + el.bounds.height / 2;
          command = psMouseClick(cx, cy);
        } else if (action.x !== undefined && action.y !== undefined) {
          command = psMouseClick(action.x, action.y);
        } else {
          return { ok: false, action: action.type, error: 'No element bounds or coordinates provided' };
        }
        break;
      }
      case 'click_point': {
        if (action.x !== undefined && action.y !== undefined) {
          command = psMouseClick(action.x, action.y);
        } else {
          return { ok: false, action: action.type, error: 'x and y coordinates required' };
        }
        break;
      }
      case 'type_text': {
        if (action.text) {
          command = psSendKeys(action.text);
        } else {
          return { ok: false, action: action.type, error: 'text is required' };
        }
        break;
      }
      case 'press_key': {
        if (action.key) {
          command = psPressKey(action.key);
        } else {
          return { ok: false, action: action.type, error: 'key is required' };
        }
        break;
      }
      case 'scroll': {
        command = psScroll(action.direction || 'down', action.amount || 3);
        break;
      }
      case 'stop': {
        return { ok: true, action: 'stop' };
      }
      case 'double_click': {
        const el = action.snapshotElement;
        if (el?.bounds) {
          const cx = el.bounds.x + el.bounds.width / 2;
          const cy = el.bounds.y + el.bounds.height / 2;
          command = psDoubleClick(cx, cy);
        } else if (action.x !== undefined && action.y !== undefined) {
          command = psDoubleClick(action.x, action.y);
        } else {
          return { ok: false, action: action.type, error: 'No element bounds or coordinates provided' };
        }
        break;
      }
      case 'drag':
      case 'perform_secondary_action':
        return { ok: false, action: action.type, error: `Action '${action.type}' not yet supported on Windows` };
      default:
        return { ok: false, action: action.type, error: `Unknown action: ${action.type}` };
    }

    const { stdout, stderr } = await runPowerShell(command, 10000);
    if (stderr && !stderr.includes('ok')) {
      this._logger?.warn({ stderr, action: action.type }, 'Windows action had stderr output');
      return { ok: false, action: action.type, error: stderr };
    }
    if (!stdout.includes('ok')) {
      return { ok: false, action: action.type, error: stdout || 'Windows action did not report success' };
    }

    // Clean up screenshot temp file after each getAppState
    // (handled in getAppState via the leaseId)

    return { ok: true, action: action.type };
  }

  async stop(_ctx: Ctx, _lease: Lease): Promise<void> {
    // No persistent process to stop for local Windows
  }
}
