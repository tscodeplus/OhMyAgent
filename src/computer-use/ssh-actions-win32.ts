// src/computer-use/ssh-actions-win32.ts
//
// Windows window-state reading and action execution over SSH.
// Primary path: stateless UIA (UI Automation) one-shot scripts —
// powershell.exe is spawned per action (no resident helper on the remote),
// executes a single command against the accessibility tree and prints one
// JSON line. All interaction is control-level (InvokePattern / ValuePattern
// / ScrollPattern / PostMessage) — the user's mouse, keyboard, focus and
// clipboard are never touched. Coordinate actions (click_point and
// double_click without an element) use the PostMessage click chain (deepest
// child + WS_EX_NOACTIVATE guard), so they never move the real cursor or
// steal the foreground either.

import type { ExecRunner } from './ssh-actions-common.js';
import type { Action, ActionResult, UIElement } from './types.js';
import {
  buildWinUiaOnceScript,
  buildWinUiaOnceRunCommand,
  buildWinUiaOnceWriteCommands,
} from './win-uia/win-uia-scripts.js';
import type { WinUiaOnceCommand, WinUiaOncePayload } from './win-uia/win-uia-scripts.js';

export interface Win32WindowState {
  screenshotBase64: string;
  windowTitle: string;
  width: number;
  height: number;
  screenWidth: number;
  screenHeight: number;
  elements: UIElement[];
}

/** UIA element id format: `win-{hwnd}:{gen}:{index}` (hwnd may be negative). */
const WIN_UIA_ELEMENT_ID_RE = /^win--?\d+:\d+:\d+$/;

interface WinUiaError {
  code?: unknown;
  message?: unknown;
}

interface OnceResult {
  ok: boolean;
  result?: Record<string, unknown>;
  error?: WinUiaError;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asNum(value: unknown): number | undefined {
  return typeof value === 'number' && isFinite(value) ? value : undefined;
}

/**
 * Parse a windowId (from listApps / lease) into a decimal hwnd usable by the
 * UIA script. Accepts '0x…' hex, plain decimal (possibly negative 64-bit
 * handles) and ignores 'pid-…' windowIds. Returns 0 when unknown.
 */
export function parseWin32WindowId(windowId: string | undefined): number {
  if (!windowId) return 0;
  const s = windowId.trim();
  if (s.startsWith('pid-')) return 0;
  let v: number;
  if (/^0x[0-9a-fA-F]+$/.test(s)) {
    v = parseInt(s, 16);
  } else if (/^-?\d+$/.test(s)) {
    v = parseInt(s, 10);
  } else {
    return 0;
  }
  return Number.isSafeInteger(v) && v !== 0 ? v : 0;
}

/** Map a UIA error code to a readable message. */
function onceErrorToMessage(once: OnceResult, fallback: string): string {
  const code = once.error?.code;
  if (code === 'ELEMENT_STALE_TREE') {
    return 'Element belongs to a stale accessibility tree, refresh the snapshot';
  }
  if (code === 'ELEMENT_NO_ACTION') {
    return 'Element does not expose a performable action';
  }
  if (code === 'USER_ACTIVE') {
    return 'User is actively using the computer; retry later';
  }
  const message = once.error?.message;
  return `${fallback}: ${typeof message === 'string' && message ? message : String(code ?? 'unknown')}`;
}

/**
 * Execute a single stateless UIA command: materialize the script on the
 * remote host (chunked, base64), run it, parse the single JSON line.
 */
async function runWin32Once(
  runner: ExecRunner,
  cmd: WinUiaOnceCommand,
  payload: WinUiaOncePayload,
): Promise<OnceResult> {
  const script = buildWinUiaOnceScript(cmd, payload);
  for (const writeCmd of buildWinUiaOnceWriteCommands(script)) {
    try {
      await runner.exec(writeCmd, { timeoutMs: 15_000 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: { code: 'SERVER_ERROR', message: `failed to write UIA script: ${message}` } };
    }
  }
  try {
    const res = await runner.exec(buildWinUiaOnceRunCommand(), { timeoutMs: 15_000 });
    const line = res.stdout.split('\n').find(l => l.trim().startsWith('{'));
    if (!line) {
      return { ok: false, error: { code: 'SERVER_ERROR', message: 'UIA script returned no JSON output' } };
    }
    const parsed: unknown = JSON.parse(line);
    if (!isRecord(parsed)) {
      return { ok: false, error: { code: 'SERVER_ERROR', message: 'UIA script returned invalid JSON' } };
    }
    if (parsed.ok === true) {
      return { ok: true, result: isRecord(parsed.result) ? parsed.result : {} };
    }
    return {
      ok: false,
      error: isRecord(parsed.error)
        ? { code: parsed.error.code, message: parsed.error.message }
        : { code: 'SERVER_ERROR', message: 'UIA script failed' },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: { code: 'SERVER_ERROR', message } };
  }
}

interface RawWinUiaElement {
  elementId?: unknown;
  role?: unknown;
  label?: unknown;
  bounds?: unknown;
  enabled?: unknown;
  focused?: unknown;
  sensitive?: unknown;
  actions?: unknown;
}

function mapWinUiaElement(raw: RawWinUiaElement): UIElement | null {
  if (typeof raw.elementId !== 'string' || typeof raw.role !== 'string') return null;
  const b = isRecord(raw.bounds) ? raw.bounds : {};
  const actions = Array.isArray(raw.actions)
    ? raw.actions.filter((a): a is string => typeof a === 'string')
    : undefined;
  return {
    elementId: raw.elementId,
    role: raw.role,
    label: typeof raw.label === 'string' && raw.label ? raw.label : undefined,
    bounds: {
      x: asNum(b.x) ?? 0,
      y: asNum(b.y) ?? 0,
      width: asNum(b.width) ?? 0,
      height: asNum(b.height) ?? 0,
    },
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true,
    ...(typeof raw.focused === 'boolean' ? { focused: raw.focused } : {}),
    ...(typeof raw.sensitive === 'boolean' ? { sensitive: raw.sensitive } : {}),
    ...(actions && actions.length > 0 ? { actions } : {}),
  };
}

// ---------------------------------------------------------------------------
// State reading
// ---------------------------------------------------------------------------

/**
 * Read the current state of the remote Windows desktop via one stateless
 * UIA `get-app-state` round-trip: accessibility tree + window info +
 * optional screenshot of the target window. Every step degrades gracefully
 * (never throws).
 *
 * @param windowId the leased window (decimal or '0x…' hwnd); absent/unknown
 *   windows fall back to the foreground window.
 */
export async function readWin32WindowState(
  runner: ExecRunner,
  _leaseId: string,
  windowId?: string,
): Promise<Win32WindowState> {
  const once = await runWin32Once(runner, 'get-app-state', {
    hwnd: parseWin32WindowId(windowId),
    screenshot: true,
  });
  if (!once.ok) {
    return {
      screenshotBase64: '',
      windowTitle: '',
      width: 1920,
      height: 1080,
      screenWidth: 1920,
      screenHeight: 1080,
      elements: [],
    };
  }
  const r = once.result ?? {};
  const rawElements = Array.isArray(r.elements) ? r.elements : [];
  const elements: UIElement[] = [];
  for (const raw of rawElements) {
    if (!isRecord(raw)) continue;
    const el = mapWinUiaElement(raw as RawWinUiaElement);
    if (el) elements.push(el);
  }
  const rect = isRecord(r.windowRect) ? r.windowRect : {};
  const display = isRecord(r.display) ? r.display : {};
  return {
    screenshotBase64: typeof r.screenshot === 'string' ? r.screenshot : '',
    windowTitle: typeof r.windowTitle === 'string' ? r.windowTitle : '',
    width: asNum(rect.width) ?? 1920,
    height: asNum(rect.height) ?? 1080,
    screenWidth: asNum(display.width) ?? 1920,
    screenHeight: asNum(display.height) ?? 1080,
    elements,
  };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** Coordinate click — explicit user-requested coordinates only. */
async function runWin32ClickPoint(
  runner: ExecRunner,
  actionType: Action['type'],
  x: number,
  y: number,
): Promise<ActionResult> {
  const once = await runWin32Once(runner, 'click-point', { x, y });
  if (once.ok) return { ok: true, action: actionType };
  return { ok: false, action: actionType, error: onceErrorToMessage(once, 'UIA click failed') };
}

/** Coordinate double-click via the PostMessage chain (WM_LBUTTONDBLCLK). */
async function runWin32DoubleClick(
  runner: ExecRunner,
  actionType: Action['type'],
  x: number,
  y: number,
): Promise<ActionResult> {
  const once = await runWin32Once(runner, 'double-click', { x, y });
  if (once.ok) return { ok: true, action: actionType };
  return { ok: false, action: actionType, error: onceErrorToMessage(once, 'UIA double-click failed') };
}

/**
 * Execute a computer-use action on the remote Windows desktop via a
 * stateless UIA one-shot script (control-level pattern actions — no mouse
 * movement, no clipboard, no focus stealing).
 *
 * @param windowId the leased window (for press-key / text-without-element /
 *   scroll-without-element targeting); unknown windows fall back to the
 *   foreground window inside the script.
 */
export async function performWin32Action(
  runner: ExecRunner,
  action: Action,
  windowId?: string,
): Promise<ActionResult> {
  const hwnd = parseWin32WindowId(windowId);

  switch (action.type) {
    case 'click_element': {
      if (!action.snapshotElement) {
        return {
          ok: false,
          action: action.type,
          error: 'No snapshotElement provided for click_element',
        };
      }
      const elementId = action.snapshotElement.elementId;
      if (!WIN_UIA_ELEMENT_ID_RE.test(elementId)) {
        // Legacy/non-UIA element id — coordinate fallback (explicitly degraded).
        const b = action.snapshotElement.bounds;
        return runWin32ClickPoint(
          runner,
          action.type,
          Math.round(b.x + b.width / 2),
          Math.round(b.y + b.height / 2),
        );
      }
      const once = await runWin32Once(runner, 'click-element', { elementId });
      if (once.ok) return { ok: true, action: action.type };
      return { ok: false, action: action.type, error: onceErrorToMessage(once, 'UIA click failed') };
    }

    case 'click_point': {
      return runWin32ClickPoint(runner, action.type, action.x ?? 0, action.y ?? 0);
    }

    case 'type_text': {
      if (!action.text) {
        return {
          ok: false,
          action: action.type,
          error: 'No text provided for type_text',
        };
      }
      // Primary path: ValuePattern.SetValue on the snapshot element (the
      // elementId embeds its own hwnd); without an element the script sends
      // WM_SETTEXT to the leased window.
      const once = await runWin32Once(runner, 'type-text', {
        elementId: action.snapshotElement?.elementId,
        text: action.text,
        hwnd,
      });
      if (once.ok) return { ok: true, action: action.type };
      return { ok: false, action: action.type, error: onceErrorToMessage(once, 'UIA type failed') };
    }

    case 'press_key': {
      if (!action.key) {
        return {
          ok: false,
          action: action.type,
          error: 'No key provided for press_key',
        };
      }
      // Word-char keys only — the Vk() table maps named keys, F1-F12 and
      // single characters; anything else is rejected up front.
      if (!/^[A-Za-z0-9_.]+$/.test(action.key)) {
        return {
          ok: false,
          action: action.type,
          error: `Invalid key: '${action.key}'`,
        };
      }
      // PostMessage to the leased window (pidScoped semantics, no focus steal).
      const once = await runWin32Once(runner, 'press-key', { key: action.key, hwnd });
      if (once.ok) return { ok: true, action: action.type };
      return { ok: false, action: action.type, error: onceErrorToMessage(once, 'UIA press failed') };
    }

    case 'scroll': {
      const direction = action.direction ?? 'down';
      const amount = action.amount ?? 1;
      const once = await runWin32Once(runner, 'scroll', {
        elementId: action.snapshotElement?.elementId,
        direction,
        amount,
        hwnd,
      });
      if (once.ok) return { ok: true, action: action.type };
      return { ok: false, action: action.type, error: onceErrorToMessage(once, 'UIA scroll failed') };
    }

    case 'double_click': {
      if (action.snapshotElement) {
        // Map to a UIA element click (pattern invoke) — no coordinate injection.
        const elementId = action.snapshotElement.elementId;
        if (WIN_UIA_ELEMENT_ID_RE.test(elementId)) {
          const once = await runWin32Once(runner, 'click-element', { elementId });
          if (once.ok) return { ok: true, action: action.type };
          return { ok: false, action: action.type, error: onceErrorToMessage(once, 'UIA click failed') };
        }
        const b = action.snapshotElement.bounds;
        return runWin32DoubleClick(
          runner,
          action.type,
          Math.round(b.x + b.width / 2),
          Math.round(b.y + b.height / 2),
        );
      }
      return runWin32DoubleClick(runner, action.type, action.x ?? 0, action.y ?? 0);
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
}
