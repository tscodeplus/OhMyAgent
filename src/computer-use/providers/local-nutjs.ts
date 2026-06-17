/**
 * NutJSProvider — local desktop automation via @nut-tree-fork/nut-js.
 * Supports Linux (X11), macOS, and Windows.
 *
 * nut.js provides cross-platform mouse, keyboard, and screen capture APIs
 * backed by C++ native addons. No accessibility tree is available, so
 * element-level interactions use coordinate-based actions.
 */

import type { ComputerUseProvider } from '../provider-contract.js';
import { normalizeComputerProviderCapabilities } from '../provider-contract.js';
import type {
  Ctx, ProviderStatus, AppInfo, WindowInfo,
  Lease, Target, AppState, UIElement, Action, ActionResult,
} from '../types.js';
import type { Logger } from 'pino';
import { Key, Button, Point } from '@nut-tree-fork/shared';

// ─── Constants ─────────────────────────────────────────────────────────────

import { truncateToolOutput } from '../../shared/truncation.js';

/**
 * macOS key code mapping for use with osascript (AppleScript key code).
 * Included here for reference and potential SSH macOS integration.
 */
const MAC_KEY_CODES: Record<string, number> = {
  'Return': 36, 'Enter': 36, 'Escape': 53, 'Esc': 53,
  'Tab': 48, 'BackSpace': 51, 'Delete': 117,
  'Home': 115, 'End': 119, 'Page_Up': 116, 'Page_Down': 121,
  'Up': 126, 'Down': 125, 'Left': 123, 'Right': 124,
  'F1': 122, 'F2': 120, 'F3': 99, 'F4': 118,
  'F5': 96, 'F6': 97, 'F7': 98, 'F8': 100,
  'F9': 101, 'F10': 109, 'F11': 103, 'F12': 111,
  'space': 49, 'Space': 49,
};

// ─── Provider ──────────────────────────────────────────────────────────────

export class NutJSProvider implements ComputerUseProvider {
  readonly providerId = 'nutjs';
  readonly capabilities = normalizeComputerProviderCapabilities({
    platform: process.platform as 'linux' | 'win32' | 'darwin',
    observationModes: ['vision-native'],
    screenshot: true,
    accessibilityTree: false,
    elementActions: false,
    elementDoubleClick: true,
    backgroundControl: 'full',
    pointClick: 'allowed',
    drag: 'allowed',
    textInput: 'foreground',
    keyboardInput: 'foreground',
    requiresForegroundForInput: false,
    nativeCursor: true,
    isolated: false,
  });

  private _logger?: Logger;
  private _nutjs: typeof import('@nut-tree-fork/nut-js') | null = null;
  private _nutjsLoadError: Error | null = null;

  constructor(options?: { logger?: Logger }) {
    this._logger = options?.logger;
  }

  /**
   * Lazy-load nut.js runtime bindings. The `Key`, `Button`, and `Point` values
   * are imported statically from `@nut-tree-fork/shared` (pure TS, no native
   * addon). All other runtime bindings (screen, mouse, keyboard, window
   * functions) are resolved lazily here.
   *
   * On platforms where the native addon cannot load (Termux aarch64, headless
   * Linux without X11, etc.), the first call caches the error and subsequent
   * calls re-throw without attempting to re-import.
   */
  private async _getNut(): Promise<typeof import('@nut-tree-fork/nut-js')> {
    if (this._nutjsLoadError) throw this._nutjsLoadError;
    if (!this._nutjs) {
      try {
        this._nutjs = await import('@nut-tree-fork/nut-js');
      } catch (err: unknown) {
        this._nutjsLoadError = err instanceof Error ? err : new Error(String(err));
        throw this._nutjsLoadError;
      }
    }
    return this._nutjs;
  }

  // ─── getStatus ───────────────────────────────────────────────────────────

  async getStatus(_ctx: Ctx): Promise<ProviderStatus> {
    try {
      const nut = await this._getNut();
      const w = await nut.screen.width();
      return {
        providerId: this.providerId,
        available: w > 0,
        permissions: [],
      };
    } catch (err: unknown) {
      return {
        providerId: this.providerId,
        available: false,
        permissions: [],
        message: `nut.js not available: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // ─── listApps ────────────────────────────────────────────────────────────

  async listApps(_ctx: Ctx): Promise<AppInfo[]> {
    let nut;
    try {
      nut = await this._getNut();
    } catch (err) {
      this._logger?.debug({ err }, 'NutJSProvider: _getNut failed — returning empty app list');
      return [];
    }
    const windows = await nut.getWindows();

    const apps = new Map<string, { name: string; pid?: number; windows: WindowInfo[] }>();

    for (const w of windows) {
      let title = '';
      let region: any = null;
      try {
        title = await w.title;
      } catch (err) {
        this._logger?.debug({ err }, 'NutJSProvider: window title inaccessible — using fallback');
      }
      try {
        region = await w.region;
      } catch (err) {
        this._logger?.debug({ err }, 'NutJSProvider: window region inaccessible — using fallback');
      }

      const appName = (w as any).ownerName || title || 'unknown';

      if (!apps.has(appName)) {
        apps.set(appName, { name: appName, pid: (w as any).processId, windows: [] });
      }

      apps.get(appName)!.windows.push({
        windowId: `${region?.left ?? 0}x${region?.top ?? 0}-${Date.now()}`,
        title: title || appName,
        bounds: region
          ? {
              x: region.left,
              y: region.top,
              width: region.width,
              height: region.height,
            }
          : undefined,
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

  // ─── createLease ─────────────────────────────────────────────────────────

  async createLease(ctx: Ctx, target: Target): Promise<Lease> {
    let nut;
    try {
      nut = await this._getNut();
    } catch (err: unknown) {
      throw new Error(
        `NutJS provider unavailable: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    if (target.appName) {
      await this._launchApp(target.appName);
    }

    let activeTitle = '';
    let activeRegion: any = null;
    try {
      const activeWin = await nut.getActiveWindow();
      if (activeWin) {
        activeTitle = await activeWin.title;
        activeRegion = await activeWin.region;
      }
    } catch (err) {
      this._logger?.debug({ err }, 'NutJSProvider: getActiveWindow failed (headless/Wayland?) — using defaults');
    }

    const leaseId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    return {
      leaseId,
      sessionPath: ctx.sessionPath ?? '',
      agentId: ctx.agentId ?? '',
      providerId: this.providerId,
      appId: target.appName || target.appId || 'desktop',
      windowId: target.windowId || activeTitle || undefined,
      createdAt: new Date().toISOString(),
      status: 'active',
      allowedActions: [
        'click_point', 'double_click', 'type_text', 'press_key',
        'scroll', 'drag', 'stop',
      ],
      providerState: {
        windowTitle: activeTitle,
        windowBounds: activeRegion
          ? { left: activeRegion.left, top: activeRegion.top, width: activeRegion.width, height: activeRegion.height }
          : { left: 0, top: 0, width: 0, height: 0 },
        targetApp: target.appName,
      },
    };
  }

  // ─── releaseLease / stop ─────────────────────────────────────────────────

  async releaseLease(_ctx: Ctx, _lease: Lease): Promise<void> {
    // No cleanup needed for local nut.js provider
  }

  async stop(_ctx: Ctx, _lease: Lease): Promise<void> {
    // No persistent process to stop
  }

  // ─── getAppState ─────────────────────────────────────────────────────────

  async getAppState(_ctx: Ctx, lease: Lease): Promise<AppState> {
    let nut;
    try {
      nut = await this._getNut();
    } catch (err) {
      this._logger?.debug({ err }, 'NutJSProvider: _getNut failed in getScreenState');
      return {
        mode: 'vision-native',
        display: { width: 0, height: 0 },
        elements: [],
      };
    }

    // Dynamically import sharp for image conversion
    let sharpModule: any;
    try {
      sharpModule = await import('sharp');
    } catch {
      this._logger?.warn('NutJSProvider: sharp module not available, screenshot will be omitted');
    }
    const sharp = sharpModule?.default;

    // 1. Screen dimensions and grab raw pixel data
    const [screenWidth, screenHeight] = await Promise.all([
      nut.screen.width(),
      nut.screen.height(),
    ]);

    let base64Data = '';
    let imageWidth = screenWidth;
    let imageHeight = screenHeight;

    try {
      const image = await nut.screen.grab();
      let pixelData = image;

      // Default color mode is BGR; convert to RGB for sharp
      if (pixelData.channels >= 3 && pixelData.channels < 4) {
        pixelData = await pixelData.toRGB();
      }

      imageWidth = pixelData.width;
      imageHeight = pixelData.height;

      if (sharp && pixelData.data && pixelData.data.length > 0) {
        // 2. Raw pixel data -> PNG -> base64
        const pngBuffer = await sharp(pixelData.data, {
          raw: {
            width: pixelData.width,
            height: pixelData.height,
            channels: pixelData.channels,
          },
        }).png().toBuffer();
        base64Data = pngBuffer.toString('base64');
      }
    } catch (err: unknown) {
      this._logger?.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'NutJSProvider: screen capture failed',
      );
    }

    // 3. Window list as UI elements
    const elements: UIElement[] = [];
    try {
      const windows = await nut.getWindows();
      for (let i = 0; i < windows.length; i++) {
        let winRegion: any;
        let winTitle = '';
        try {
          winRegion = await windows[i].region;
          winTitle = await windows[i].title;
        } catch (err) {
          this._logger?.debug({ err, windowIndex: i }, 'NutJSProvider: skipping inaccessible window');
        }
        if (winRegion && winRegion.width > 0 && winRegion.height > 0) {
          elements.push({
            elementId: `win-${i}`,
            role: 'window',
            label: winTitle || '(untitled)',
            bounds: {
              x: winRegion.left,
              y: winRegion.top,
              width: winRegion.width,
              height: winRegion.height,
            },
            enabled: true,
          });
        }
      }
    } catch (err: unknown) {
      this._logger?.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'NutJSProvider: failed to enumerate windows',
      );
    }

    // 4. Active window title
    let windowTitle: string | undefined;
    try {
      const activeWin = await nut.getActiveWindow();
      if (activeWin) {
        windowTitle = await activeWin.title;
      }
    } catch (err) {
      this._logger?.debug({ err }, 'NutJSProvider: activeWin.title failed — falling back to lease providerState');
      windowTitle = lease.providerState?.windowTitle as string | undefined;
    }

    // 5. Mouse cursor position — reported via focusedElementId
    let focusedElementId: string | undefined;
    try {
      const mousePos = await nut.mouse.getPosition();
      focusedElementId = `cursor:${mousePos.x},${mousePos.y}`;
    } catch (err) {
      this._logger?.debug({ err }, 'NutJSProvider: mouse.getPosition failed — non-fatal');
    }

    return {
      mode: 'vision-native',
      screenshot: base64Data
        ? {
            type: 'image',
            mimeType: 'image/png',
            data: base64Data,
          }
        : undefined,
      display: {
        width: imageWidth,
        height: imageHeight,
      },
      elements,
      windowTitle,
      focusedElementId,
    };
  }

  // ─── performAction ───────────────────────────────────────────────────────

  async performAction(_ctx: Ctx, _lease: Lease, action: Action): Promise<ActionResult> {
    let nut;
    try {
      nut = await this._getNut();
    } catch (err: unknown) {
      return {
        ok: false,
        action: action.type,
        error: `NutJS provider unavailable: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    switch (action.type) {
      case 'click_point': {
        if (action.x === undefined || action.y === undefined) {
          return { ok: false, action: action.type, error: 'x and y coordinates required' };
        }
        try {
          await nut.mouse.setPosition(new Point(Math.round(action.x), Math.round(action.y)));
          await nut.mouse.leftClick();
          return { ok: true, action: action.type };
        } catch (err: unknown) {
          return {
            ok: false,
            action: action.type,
            error: `click_point failed: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }

      case 'double_click': {
        const x = action.snapshotElement
          ? action.snapshotElement.bounds.x + action.snapshotElement.bounds.width / 2
          : action.x;
        const y = action.snapshotElement
          ? action.snapshotElement.bounds.y + action.snapshotElement.bounds.height / 2
          : action.y;
        if (x === undefined || y === undefined) {
          return { ok: false, action: action.type, error: 'x and y coordinates required' };
        }
        try {
          await nut.mouse.setPosition(new Point(Math.round(x), Math.round(y)));
          await nut.mouse.doubleClick(Button.LEFT);
          return { ok: true, action: action.type };
        } catch (err: unknown) {
          return {
            ok: false,
            action: action.type,
            error: `double_click failed: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }

      case 'type_text': {
        if (!action.text) {
          return { ok: false, action: action.type, error: 'text is required' };
        }
        try {
          await nut.keyboard.type(action.text);
          return { ok: true, action: action.type };
        } catch (err: unknown) {
          return {
            ok: false,
            action: action.type,
            error: `type_text failed: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }

      case 'press_key': {
        if (!action.key) {
          return { ok: false, action: action.type, error: 'key is required' };
        }
        try {
          const mapped = this._mapKeyToNut(action.key);
          if (mapped) {
            await nut.keyboard.pressKey(mapped);
          } else if (action.key.length === 1) {
            // Single character — use type as fallback
            await nut.keyboard.type(action.key);
          } else {
            return {
              ok: false,
              action: action.type,
              error: `Unsupported key: '${action.key}'`,
            };
          }
          return { ok: true, action: action.type };
        } catch (err: unknown) {
          return {
            ok: false,
            action: action.type,
            error: `press_key failed: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }

      case 'scroll': {
        try {
          const amount = Math.min(action.amount || 3, 20);
          const direction = action.direction || 'down';
          for (let i = 0; i < amount; i++) {
            switch (direction) {
              case 'up':
                await nut.mouse.scrollUp(1);
                break;
              case 'down':
                await nut.mouse.scrollDown(1);
                break;
              case 'left':
                await nut.mouse.scrollLeft(1);
                break;
              case 'right':
                await nut.mouse.scrollRight(1);
                break;
            }
          }
          return { ok: true, action: action.type };
        } catch (err: unknown) {
          return {
            ok: false,
            action: action.type,
            error: `scroll failed: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }

      case 'drag': {
        if (action.x === undefined || action.y === undefined) {
          return { ok: false, action: action.type, error: 'x and y coordinates required' };
        }
        try {
          const start = await nut.mouse.getPosition();
          await nut.mouse.drag([
            start,
            new Point(Math.round(action.x), Math.round(action.y)),
          ]);
          return { ok: true, action: action.type };
        } catch (err: unknown) {
          return {
            ok: false,
            action: action.type,
            error: `drag failed: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }

      case 'stop':
        return { ok: true, action: 'stop' };

      case 'click_element':
      case 'perform_secondary_action':
        return {
          ok: false,
          action: action.type,
          error: `Action '${action.type}' not supported by NutJS (no element tree)`,
        };

      default:
        return {
          ok: false,
          action: action.type,
          error: `Unknown action: ${(action as any).type || action.type}`,
        };
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  /**
   * Launch an application by name.
   *
   * - macOS: `open -a <name>`
   * - Windows: `cmd /c start "" <name>`
   * - Linux: spawn `<name>` directly
   */
  private async _launchApp(appName: string): Promise<void> {
    const { spawn } = await import('child_process');
    return new Promise<void>(resolve => {
      const platform = process.platform;
      let cmd: string;
      let args: string[];

      if (platform === 'darwin') {
        cmd = 'open';
        args = ['-a', appName];
      } else if (platform === 'win32') {
        cmd = 'cmd';
        args = ['/c', 'start', '', appName];
      } else {
        // Linux: attempt to spawn the binary directly
        cmd = appName;
        args = [];
      }

      const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
      child.on('error', (err: Error) => {
        this._logger?.warn({ err, appName }, 'NutJSProvider: failed to launch app');
      });
      child.unref();

      // Allow time for the window to appear
      setTimeout(resolve, 2000);
    });
  }

  /**
   * Map a key name string to a nut.js Key enum value.
   * Uses the statically imported `Key` enum for type-safe key references.
   *
   * Returns the Key enum value if found, or null for unrecognised key names.
   */
  private _mapKeyToNut(key: string): Key | null {
    const map: Record<string, Key> = {
      'Enter': Key.Enter,
      'Return': Key.Enter,
      'Escape': Key.Escape,
      'Esc': Key.Escape,
      'Tab': Key.Tab,
      'BackSpace': Key.Backspace,
      'Delete': Key.Delete,
      'Home': Key.Home,
      'End': Key.End,
      'Page_Up': Key.PageUp,
      'Page_Down': Key.PageDown,
      'Up': Key.Up,
      'Down': Key.Down,
      'Left': Key.Left,
      'Right': Key.Right,
      'F1': Key.F1,
      'F2': Key.F2,
      'F3': Key.F3,
      'F4': Key.F4,
      'F5': Key.F5,
      'F6': Key.F6,
      'F7': Key.F7,
      'F8': Key.F8,
      'F9': Key.F9,
      'F10': Key.F10,
      'F11': Key.F11,
      'F12': Key.F12,
      'space': Key.Space,
      'Space': Key.Space,
      'Control': Key.LeftControl,
      'Alt': Key.LeftAlt,
      'Shift': Key.LeftShift,
    };
    return map[key] ?? null;
  }
}
