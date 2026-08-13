/**
 * Local Windows Provider — controls the Windows host via the resident UIA
 * helper process (win-uia-server.ps1, driven by uia-client.ts). Used when
 * OhMyAgent runs in WSL and needs to control the Windows desktop.
 *
 * All interactions are UIA control-level actions (InvokePattern /
 * ValuePattern / ScrollPattern / PostMessage): no mouse movement, no focus
 * stealing, no clipboard use. The only exceptions are the explicit
 * click_point action and the explicit focus_app (activateOnly) flow, which
 * are user-requested coordinate/foreground operations.
 */

import type { ComputerUseProvider } from '../provider-contract.js';
import { normalizeComputerProviderCapabilities } from '../provider-contract.js';
import type {
  Ctx, ProviderStatus, AppInfo, WindowInfo,
  Lease, Target, AppState, UIElement, Action, ActionResult,
} from '../types.js';
import type { Logger } from 'pino';
import { UiaClient } from '../win-uia/uia-client.js';

interface UiaAppStateResult {
  hwnd?: number;
  gen?: number;
  windowTitle?: string;
  windowRect?: { x: number; y: number; width: number; height: number };
  display?: { width: number; height: number };
  elements?: UiaElementResult[];
  screenshot?: string;
  truncated?: boolean;
}

interface UiaElementResult {
  elementId: string;
  role: string;
  label?: string;
  bounds?: { x: number; y: number; width: number; height: number };
  enabled?: boolean;
  focused?: boolean;
  sensitive?: boolean;
  actions?: string[];
}

export class LocalWindowsProvider implements ComputerUseProvider {
  readonly providerId = 'windows:local';
  readonly capabilities = normalizeComputerProviderCapabilities({
    platform: 'win32',
    observationModes: ['vision-native'],
    screenshot: true,
    accessibilityTree: true,
    elementActions: 'semantic',
    elementDoubleClick: false,
    backgroundControl: 'full',
    pointClick: 'allowed',
    drag: 'unsupported',
    textInput: 'semantic',
    keyboardInput: 'pidScoped',
    requiresForegroundForInput: false,
    nativeCursor: false,
    isolated: false,
    supportsFocusApp: true,
    supportsCloseApp: true,
  });

  private readonly _logger?: Logger;
  private _client?: UiaClient;

  constructor(options?: { logger?: Logger }) {
    this._logger = options?.logger;
  }

  private client(): UiaClient {
    if (!this._client) {
      this._client = new UiaClient({ logger: this._logger });
    }
    return this._client;
  }

  async getStatus(_ctx: Ctx): Promise<ProviderStatus> {
    try {
      const res = await this.client().request('ping', {}, { timeoutMs: 5000 });
      return {
        providerId: this.providerId,
        available: res.ok,
        permissions: [],
        message: res.ok ? undefined : 'UIA server unavailable',
      };
    } catch {
      return { providerId: this.providerId, available: false, permissions: [], message: 'UIA server unavailable' };
    }
  }

  async listApps(_ctx: Ctx): Promise<AppInfo[]> {
    const res = await this.client().request('list-apps');
    if (!res.ok) return [];
    const appsData = (res.result as { apps?: string[] })?.apps ?? [];
    const apps = new Map<string, { name: string; pid: number; windows: WindowInfo[] }>();

    for (const line of appsData) {
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
    const res = await this.client().request('close-app', { name: target });
    if (!res.ok) {
      throw new Error(`Failed to close Windows app "${target}": ${res.error.message}`);
    }
  }

  async createLease(ctx: Ctx, target: Target): Promise<Lease> {
    let hwnd: number | undefined;
    let launched: { pid?: number; hwnd?: number; title?: string } | undefined;

    if (target.appName) {
      const res = await this.client().request(
        target.activateOnly ? 'focus-app' : 'launch-app',
        { name: target.appName },
      );
      if (!res.ok) {
        throw new Error(`Failed to ${target.activateOnly ? 'focus' : 'launch'} Windows app "${target.appName}": ${res.error.message}`);
      }
      launched = res.result as { pid?: number; hwnd?: number; title?: string };
      hwnd = launched.hwnd;
    }

    // Get window info for the lease. With focus-free launch the foreground
    // after launch is the caller's own window - reading it would store the
    // wrong title/rect. Only fall back to the foreground when launch yielded
    // no window at all; otherwise use the launched window's title (focus-app
    // returns it; launch-app's title is filled lazily via get-app-state).
    let windowTitle = '';
    let windowRect = { x: 0, y: 0, width: 0, height: 0 };
    if (hwnd === undefined || hwnd === 0) {
      const fg = await this.client().request('get-foreground');
      if (fg.ok) {
        const info = fg.result as { hwnd?: number; title?: string; windowRect?: typeof windowRect };
        if (hwnd === undefined || hwnd === 0) hwnd = info.hwnd;
        windowTitle = info.title || target.appName || '';
        windowRect = info.windowRect || windowRect;
      }
    } else if (launched?.title) {
      windowTitle = launched.title;
    }

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
        'click_element', 'click_point', 'double_click', 'type_text', 'press_key',
        'scroll', 'stop',
      ],
      providerState: { hwnd, windowTitle, windowRect, targetApp: target.appName },
    };
  }

  async releaseLease(_ctx: Ctx, _lease: Lease): Promise<void> {
    // The resident server is shared; nothing to release per lease.
  }

  async getAppState(_ctx: Ctx, lease: Lease): Promise<AppState> {
    const providerState = lease.providerState as
      | { hwnd?: number; windowTitle?: string }
      | undefined;
    const res = await this.client().request('get-app-state', {
      hwnd: providerState?.hwnd ?? lease.windowId,
    });
    if (!res.ok) {
      throw new Error(`Failed to read Windows app state: ${res.error.message}`);
    }
    const state = res.result as UiaAppStateResult;

    const elements: UIElement[] = (state.elements ?? []).map((el: UiaElementResult) => ({
      elementId: el.elementId,
      role: el.role || 'pane',
      label: el.label || undefined,
      bounds: el.bounds ?? { x: 0, y: 0, width: 0, height: 0 },
      enabled: el.enabled !== false,
      focused: el.focused,
      sensitive: el.sensitive,
      // PS 5.1 serializes an empty array property as null — normalize to [].
      actions: Array.isArray(el.actions) ? el.actions : [],
    }));

    return {
      mode: 'vision-native',
      screenshot: state.screenshot ? {
        type: 'image',
        mimeType: 'image/png',
        data: state.screenshot,
      } : undefined,
      display: {
        width: state.display?.width || 1920,
        height: state.display?.height || 1080,
      },
      elements,
      windowTitle: state.windowTitle || providerState?.windowTitle,
    };
  }

  async performAction(_ctx: Ctx, lease: Lease, action: Action): Promise<ActionResult> {
    const elementId = action.elementId ?? action.snapshotElement?.elementId;

    switch (action.type) {
      case 'click_element': {
        if (!elementId) {
          return { ok: false, action: action.type, error: 'No elementId provided for click_element' };
        }
        const res = await this.client().request('click-element', { elementId });
        return this._toResult(action.type, res);
      }
      case 'click_point': {
        if (action.x === undefined || action.y === undefined) {
          return { ok: false, action: action.type, error: 'x and y coordinates required' };
        }
        const providerState = lease.providerState as { hwnd?: number } | undefined;
        const res = await this.client().request('click-point', {
          x: action.x,
          y: action.y,
          ...(providerState?.hwnd ? { hwnd: providerState.hwnd } : {}),
        });
        return this._toResult(action.type, res);
      }
      case 'double_click': {
        if (action.x === undefined || action.y === undefined) {
          return { ok: false, action: action.type, error: 'x and y coordinates required' };
        }
        const providerState = lease.providerState as { hwnd?: number } | undefined;
        const res = await this.client().request('double-click', {
          x: action.x,
          y: action.y,
          ...(providerState?.hwnd ? { hwnd: providerState.hwnd } : {}),
        });
        return this._toResult(action.type, res);
      }
      case 'type_text': {
        if (!action.text) {
          return { ok: false, action: action.type, error: 'text is required' };
        }
        const res = await this.client().request('type-text', {
          ...(elementId ? { elementId } : {}),
          text: action.text,
        });
        return this._toResult(action.type, res);
      }
      case 'press_key': {
        if (!action.key) {
          return { ok: false, action: action.type, error: 'key is required' };
        }
        const providerState = lease.providerState as { hwnd?: number } | undefined;
        const hwnd = providerState?.hwnd;
        if (!hwnd) {
          return { ok: false, action: action.type, error: 'No target window for press_key' };
        }
        const res = await this.client().request('press-key', { hwnd, key: action.key });
        return this._toResult(action.type, res);
      }
      case 'scroll': {
        const res = await this.client().request('scroll', {
          ...(elementId ? { elementId } : {}),
          direction: action.direction ?? 'down',
          amount: action.amount ?? 3,
        });
        return this._toResult(action.type, res);
      }
      case 'stop':
        return { ok: true, action: 'stop' };
      case 'drag':
      case 'perform_secondary_action':
        return { ok: false, action: action.type, error: `Action '${action.type}' not yet supported on Windows` };
      default:
        return { ok: false, action: action.type, error: `Unknown action: ${action.type}` };
    }
  }

  async stop(_ctx: Ctx, _lease: Lease): Promise<void> {
    // The resident server stays up for other sessions; idle-exits on its own.
  }

  private _toResult(action: Action['type'], res: { ok: boolean; error?: { message: string } }): ActionResult {
    return res.ok
      ? { ok: true, action }
      : { ok: false, action, error: res.error?.message ?? 'UIA action failed' };
  }
}
