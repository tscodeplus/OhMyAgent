// src/computer-use/ssh-actions-darwin.ts
//
// macOS window-state reading and action execution over SSH.
// Primary path (accessibility-first): the AX (accessibility) tree read via
// JXA (`osascript -l JavaScript`) + the ObjC bridge, driving AXUIElement
// attributes and AXPress-style actions — no mouse movement, and the target
// app does not need to be foreground. Keyboard events (press_key, and the
// scroll arrow-key degradation) post straight into the leased app's event
// queue via CGEventPostToPid — background delivery, the same technique
// Peekaboo / mac-cua use: the app never becomes frontmost and the real
// keyboard stream is never touched. Only the final fallbacks use osascript
// synthesized input (keystroke / key code / coordinate `click at`), and
// only when no target pid is available or the background path fails.
//
// TCC note: AX calls (and CGEventPostToPid, which shares the bucket on most
// versions) require the *remote* terminal to hold Accessibility
// permission. On newer macOS the Event Posting permission may be a separate
// bucket. When the OS rejects the AX API (kAXErrorAPIDisabled, -25211) the
// JXA scripts return {"ok":false,"error":"API_DISABLED"} and the platform
// layer surfaces a readable message: grant Accessibility in System Settings
// > Privacy & Security > Accessibility on the Mac and re-launch the
// terminal app. Note CGEventPostToPid itself returns void and fails
// silently without permission — the scripts probe the AX API first so the
// common no-permission case is still reported.

import type { ExecRunner } from './ssh-actions-common.js';
import type { Action, ActionResult, ActionType, AppInfo, UIElement } from './types.js';
import { quoteShellArg, truncateStdout } from './ssh-actions-common.js';

/** macOS key name -> key code mapping for osascript(1) key code commands. */
export const MAC_KEY_CODES: Record<string, number> = {
  'Return': 36, 'Enter': 36, 'Escape': 53, 'Esc': 53,
  'Tab': 48, 'BackSpace': 51, 'Delete': 117,
  'Home': 115, 'End': 119, 'Page_Up': 116, 'Page_Down': 121,
  'Up': 126, 'Down': 125, 'Left': 123, 'Right': 124,
  'F1': 122, 'F2': 120, 'F3': 99, 'F4': 118,
  'F5': 96, 'F6': 97, 'F7': 98, 'F8': 100,
  'F9': 101, 'F10': 109, 'F11': 103, 'F12': 111,
  'space': 49, 'Space': 49,
};

/** Timeout for JXA AX commands (tree walks can be slow over SSH). */
const AX_JXA_TIMEOUT_MS = 20_000;

/** kCGEventFlagMaskShift — required by uppercase/symbol-shifted keys. */
const CG_EVENT_FLAG_SHIFT = 0x020000;

/**
 * ASCII character -> macOS virtual key code + Shift flag (US ANSI layout).
 * Uppercase letters and symbol-shifted punctuation need the Shift flag;
 * characters without a US-layout keycode (e.g. CJK) resolve to null and
 * skip straight to the synthesized-input fallback. Key codes are hardware
 * scan codes — unlike the keystroke fallback they are layout-independent.
 */
const MAC_ASCII_KEY_CODES: Record<string, { code: number; shift: boolean }> = (() => {
  const plain: Array<[string, number]> = [
    ['a', 0], ['s', 1], ['d', 2], ['f', 3], ['h', 4], ['g', 5], ['z', 6],
    ['x', 7], ['c', 8], ['v', 9], ['b', 11], ['q', 12], ['w', 13], ['e', 14],
    ['r', 15], ['y', 16], ['t', 17], ['o', 31], ['u', 32], ['i', 34],
    ['p', 35], ['l', 37], ['j', 38], ['k', 40], ['n', 45], ['m', 46],
    ['1', 18], ['2', 19], ['3', 20], ['4', 21], ['5', 23], ['6', 22],
    ['7', 26], ['8', 28], ['9', 25], ['0', 29],
    [' ', 49], ['-', 27], ['=', 24], ['[', 33], [']', 30], ['\\', 42],
    [';', 41], ["'", 39], [',', 43], ['.', 47], ['/', 44], ['`', 50],
  ];
  const shifted: Array<[string, number]> = [
    ['~', 50], ['!', 18], ['@', 19], ['#', 20], ['$', 21], ['%', 23],
    ['^', 22], ['&', 26], ['*', 28], ['(', 25], [')', 29], ['_', 27],
    ['+', 24], ['{', 33], ['}', 30], ['|', 42], [':', 41], ['"', 39],
    ['<', 43], ['>', 47], ['?', 44],
  ];
  const map: Record<string, { code: number; shift: boolean }> = {};
  for (const [ch, code] of plain) map[ch] = { code, shift: false };
  for (const [ch, code] of shifted) map[ch] = { code, shift: true };
  for (let i = 0; i < 26; i++) {
    const lower = String.fromCharCode(97 + i);
    const upper = String.fromCharCode(65 + i);
    if (map[lower]) map[upper] = { code: map[lower].code, shift: true };
  }
  return map;
})();

/**
 * Resolve a press_key value to a virtual key code + modifier flags, or null
 * when the key has no US-layout keycode (CJK characters etc.).
 */
function macKeyToKeyEvent(key: string): { code: number; flags: number } | null {
  const named = MAC_KEY_CODES[key];
  if (named !== undefined) return { code: named, flags: 0 };
  if (key.length === 1) {
    const m = MAC_ASCII_KEY_CODES[key];
    if (m) return { code: m.code, flags: m.shift ? CG_EVENT_FLAG_SHIFT : 0 };
  }
  return null;
}

/** Cap for injected text (64KB); oversized payloads are truncated. */
const MAX_AX_TEXT_LENGTH = 64 * 1024;

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
export function macKeystrokeCommand(text: string): string {
  const appleScriptSafe = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = `tell application "System Events" to keystroke "${appleScriptSafe}"`;
  return `osascript -e ${quoteShellArg(script)}`;
}

/**
 * Bring the app with the given pid to the front via System Events.
 * Used only *before* degraded synthesized-input fallbacks (keystroke), so
 * the typed text lands in the leased app instead of whatever is currently
 * frontmost. The pid is an integer, so injection into the AppleScript is
 * impossible.
 */
export function macActivateAppCommand(pid: number): string {
  const script =
    `tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`;
  return `osascript -e ${quoteShellArg(script)}`;
}

/**
 * List running macOS applications via osascript — visible processes (those
 * with windows on the desktop). Shared by the SSH provider and the local
 * macOS provider (local-darwin).
 */
export async function listDarwinApps(runner: ExecRunner): Promise<AppInfo[]> {
  try {
    const result = await runner.exec(
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

export interface DarwinWindowState {
  screenshotBase64: string;
  windowTitle: string;
  elements: UIElement[];
  /** Human-readable note when the AX tree could not be read (e.g. TCC). */
  axError?: string;
}

/**
 * Read the current state of the remote macOS desktop: screenshot, front
 * process name and the accessibility (AX) tree. Every step degrades
 * gracefully (never throws): a failed/non-JSON JXA result silently yields
 * an empty element list.
 *
 * @param pid target app pid for the AX tree; 0 (default) = focused app.
 */
export async function readDarwinWindowState(
  runner: ExecRunner,
  leaseId: string,
  pid?: number,
): Promise<DarwinWindowState> {
  let screenshotBase64 = '';
  try {
    await runner.exec(`screencapture -x -T0 /tmp/cua_${leaseId}.png`);
    const b64Result = await runner.exec(`base64 -i /tmp/cua_${leaseId}.png`);
    screenshotBase64 = b64Result.stdout.trim();
    await runner.exec(`rm -f /tmp/cua_${leaseId}.png`).catch(() => {});
  } catch { /* screencapture failed */ }

  let windowTitle = '';
  try {
    const titleResult = await runner.exec(
      `osascript -e 'tell application "System Events" to get name of front process'`,
    );
    windowTitle = truncateStdout(titleResult.stdout.trim());
  } catch { /* Non-critical */ }

  // AX tree. The JXA command also contains 'osascript', so this must be
  // tolerant of non-JSON stdout ('Finder' from the title probe mocks) —
  // runJxa returns null and we yield an empty list.
  let elements: UIElement[] = [];
  let axError: string | undefined;
  const treeResult = await runJxa(runner, jxaTreeScript(pid ?? 0));
  if (treeResult?.ok === true && Array.isArray(treeResult.elements)) {
    elements = treeResult.elements.map(mapRawElement);
  } else if (treeResult?.error === 'API_DISABLED') {
    axError = AX_API_DISABLED_MESSAGE;
  }

  return { screenshotBase64, windowTitle, elements, axError };
}

// ---------------------------------------------------------------------------
// AX (JXA) helpers
// ---------------------------------------------------------------------------

const AX_API_DISABLED_MESSAGE =
  'macOS accessibility API is disabled (kAXErrorAPIDisabled). Grant ' +
  'Accessibility permission in System Settings > Privacy & Security > ' +
  'Accessibility on the Mac, then retry.';

interface RawAxElement {
  path?: string;
  role?: string;
  label?: string;
  description?: string;
  actions?: string[];
  enabled?: boolean;
  bounds?: { x: number; y: number; width: number; height: number };
}

interface JxaResult {
  ok?: boolean;
  error?: string;
  elements?: RawAxElement[];
}

/** AXRole name -> platform UIElement role. Unknown roles are lowercased. */
const AX_ROLE_MAP: Record<string, string> = {
  AXButton: 'button',
  AXTextField: 'textbox',
  AXTextArea: 'textbox',
  AXSecureTextField: 'passwordfield',
  AXCheckBox: 'checkbox',
  AXComboBox: 'combobox',
  AXRadioButton: 'radiobutton',
  AXMenuItem: 'menuitem',
  AXTabGroup: 'tabgroup',
  AXScrollBar: 'scrollbar',
  AXSlider: 'slider',
  AXTable: 'table',
  AXCell: 'cell',
  AXStaticText: 'text',
  AXWindow: 'window',
  AXPopUpButton: 'button',
  AXMenuBar: 'menubar',
  AXMenu: 'menu',
  AXList: 'list',
  AXScrollArea: 'scrollarea',
  AXGroup: 'group',
  AXImage: 'image',
  AXLink: 'link',
  AXProgressIndicator: 'progressbar',
  AXHeading: 'heading',
};

/** Roles whose value can be set directly via kAXValueAttribute. */
const AX_TEXT_ROLES = new Set([
  'textbox', 'textarea', 'textfield', 'searchfield', 'passwordfield', 'combobox',
]);

/** AX scroll action per direction (attached to AXScrollArea elements). */
const SCROLL_AX_ACTIONS: Record<'up' | 'down' | 'left' | 'right', string> = {
  up: 'AXScrollUpByLine',
  down: 'AXScrollDownByLine',
  left: 'AXScrollLeftByLine',
  right: 'AXScrollRightByLine',
};

function mapAxRole(role: string): string {
  return AX_ROLE_MAP[role] ?? role.toLowerCase();
}

function mapRawElement(raw: RawAxElement): UIElement {
  const b = raw.bounds ?? { x: 0, y: 0, width: 0, height: 0 };
  return {
    elementId: raw.path ?? '',
    role: mapAxRole(raw.role ?? 'unknown'),
    label: raw.label || undefined,
    description: raw.description || undefined,
    bounds: { x: b.x ?? 0, y: b.y ?? 0, width: b.width ?? 0, height: b.height ?? 0 },
    enabled: raw.enabled !== false,
    actions: raw.actions,
  };
}

/**
 * Parse an elementId ('/0/2/5') into integer child indices, or null if the
 * id is not a valid AX path. Safe values only — numbers and slashes — so the
 * string may be injected into JXA verbatim.
 */
function parseElementPath(elementId: string | undefined): number[] | null {
  if (!elementId) return null;
  const parts = elementId.split('/').filter((p) => p.length > 0);
  if (parts.length === 0) return null;
  const nums = parts.map(Number);
  if (nums.some((n) => !Number.isInteger(n) || n < 0)) return null;
  return nums;
}

/** Wrap a JXA script in `osascript -l JavaScript -e <script>` (single-quoted). */
function jxaCommand(script: string): string {
  return `osascript -l JavaScript -e ${quoteShellArg(script)}`;
}

/**
 * Run a JXA script over SSH and parse its JSON output.
 * Returns null when the command fails or stdout is not valid JSON
 * (e.g. 'Finder' from a non-AX osascript probe) — callers must treat
 * null as a graceful degradation signal, never throw.
 */
async function runJxa(runner: ExecRunner, script: string): Promise<JxaResult | null> {
  try {
    const res = await runner.exec(jxaCommand(script), { timeoutMs: AX_JXA_TIMEOUT_MS });
    const trimmed = res.stdout.trim();
    if (!trimmed) return null;
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object') return parsed as JxaResult;
    return null;
  } catch {
    return null;
  }
}

/**
 * Common JXA preamble for element-targeted actions:
 *   - attr(): AXUIElementCopyAttributeValue wrapper. NSString/NSNumber
 *     results are explicitly unwrapped with String()/Number() before
 *     JSON.stringify — never serialize raw ObjC refs (that yields
 *     {value=...} noise).
 *   - elByPath(): re-walk kAXChildrenAttribute along the element path.
 *   - app: pid > 0 → `AXUIElementCreateApplication(pid)` with the pid
 *     inlined and the focused-app fallback branch *omitted entirely*, so
 *     the script can never touch the user's focused app; else the focused
 *     application via AXUIElementCreateSystemWide + kAXFocusedApplication
 *     (no pid is available for actions; the caller passes 0).
 *   - pathStr: injected as '/0/2/5' (digits + slashes only, injection-safe).
 *
 * IMPORTANT quoting rule: JXA scripts are passed through quoteShellArg, so
 * the script itself must never contain a single quote — all JS string
 * literals below use double quotes.
 */
function jxaCommon(pid: number, pathParts: number[]): string {
  const canonicalPath = `/${pathParts.join('/')}`;
  const appSetup = pid > 0
    ? `var app = $.AXUIElementCreateApplication(${pid});`
    : `var app;
var sys = $.AXUIElementCreateSystemWide();
var fav = Ref(), fae = Ref();
var fr = $.AXUIElementCopyAttributeValue(sys, $.kAXFocusedApplicationAttribute, fav, fae);
app = (fr === 0 && fav[0]) ? fav[0] : sys;`;
  return `ObjC.import('Foundation');
ObjC.import('ApplicationServices');
function attr(el, name) {
  var v = Ref(), e = Ref();
  var r = $.AXUIElementCopyAttributeValue(el, name, v, e);
  if (r !== 0) return null;
  return v[0] || null;
}
function elByPath(app, parts) {
  var el = app;
  for (var i = 0; i < parts.length; i++) {
    var kids = attr(el, $.kAXChildrenAttribute);
    if (!kids || !kids[parts[i]]) return null;
    el = kids[parts[i]];
  }
  return el;
}
var pid = ${pid};
${appSetup}
var pathStr = "${canonicalPath}";
var parts = pathStr.split('/').slice(1).map(Number);
`;
}

/** Guard against the TCC-disabled error (kAXErrorAPIDisabled = -25211). */
function jxaApiDisabledGuard(): string {
  return `  var probe = Ref(), perr = Ref();
  var pr = $.AXUIElementCopyAttributeValue(app, $.kAXRoleAttribute, probe, perr);
  if (pr === -25211) return { ok: false, error: 'API_DISABLED' };
`;
}

/**
 * JXA script: walk the AX tree (max 300 elements, depth 12) and emit
 * interactive elements (have actions, valid position and size) as JSON.
 * 0 = focused application.
 */
function jxaTreeScript(pid: number): string {
  return `ObjC.import('Foundation');
ObjC.import('ApplicationServices');
function attr(el, name) {
  var v = Ref(), e = Ref();
  var r = $.AXUIElementCopyAttributeValue(el, name, v, e);
  if (r !== 0) return null;
  return v[0] || null;
}
function walk(el, path, depth, out) {
  if (out.length >= 300 || depth >= 12) return;
  var role = String(attr(el, $.kAXRoleAttribute) || '');
  if (!role) return;
  var a = attr(el, $.kAXActionsAttribute);
  var actions = [];
  if (a) { for (var i = 0; i < a.length; i++) actions.push(String(a[i])); }
  var pos = attr(el, $.kAXPositionAttribute);
  var size = attr(el, $.kAXSizeAttribute);
  // AXValue bridges to {x,y}/{width,height} in JXA; also accept {w,h}.
  var px = pos ? Number(pos.x !== undefined ? pos.x : pos.w) : NaN;
  var py = pos ? Number(pos.y !== undefined ? pos.y : pos.h) : NaN;
  var sw = size ? Number(size.width !== undefined ? size.width : size.w) : NaN;
  var sh = size ? Number(size.height !== undefined ? size.height : size.h) : NaN;
  if (actions.length > 0 && !isNaN(px) && !isNaN(sw) && sw > 0 && sh > 0) {
    out.push({
      path: path.join('/'),
      role: role,
      label: String(attr(el, $.kAXTitleAttribute) || ''),
      description: String(attr(el, $.kAXDescriptionAttribute) || ''),
      actions: actions,
      enabled: !!attr(el, $.kAXEnabledAttribute),
      bounds: { x: px, y: py, width: sw, height: sh }
    });
  }
  var children = attr(el, $.kAXChildrenAttribute);
  if (!children) return;
  for (var i = 0; i < children.length; i++) walk(children[i], path.concat(i), depth + 1, out);
}
var pid = ${pid};
${pid > 0
  ? `var app = $.AXUIElementCreateApplication(${pid});`
  : `var app;
var sys = $.AXUIElementCreateSystemWide();
var fav = Ref(), fae = Ref();
var fr = $.AXUIElementCopyAttributeValue(sys, $.kAXFocusedApplicationAttribute, fav, fae);
app = (fr === 0 && fav[0]) ? fav[0] : sys;`}
var apiDisabled = false;
var probe = Ref(), perr = Ref();
var pr = $.AXUIElementCopyAttributeValue(app, $.kAXRoleAttribute, probe, perr);
if (pr === -25211) apiDisabled = true;
if (apiDisabled) {
  JSON.stringify({ ok: false, error: 'API_DISABLED' });
} else {
  var out = [];
  walk(app, [], 0, out);
  JSON.stringify({ ok: true, elements: out, truncated: out.length >= 300 });
}`;
}

/**
 * JXA script: locate the element by path and perform its press action
 * (kAXPressAction preferred, else the first listed action).
 */
function jxaPressScript(pid: number, pathParts: number[]): string {
  return `${jxaCommon(pid, pathParts)}
function runAction() {
${jxaApiDisabledGuard()}
  var target = elByPath(app, parts);
  if (!target) return { ok: false, error: 'ELEMENT_NOT_FOUND' };
  var a = attr(target, $.kAXActionsAttribute);
  var actions = [];
  if (a) { for (var i = 0; i < a.length; i++) actions.push(String(a[i])); }
  if (actions.length === 0) return { ok: false, error: 'NO_ACTION' };
  var press = "AXPress";
  var found = false;
  for (var i = 0; i < actions.length; i++) {
    if (actions[i] === press) { found = true; break; }
  }
  if (!found) press = actions[0];
  var r = $.AXUIElementPerformAction(target, press);
  if (r === -25211) return { ok: false, error: 'API_DISABLED' };
  if (r !== 0) return { ok: false, error: 'PERFORM_FAILED' };
  return { ok: true };
}
JSON.stringify(runAction());`;
}

/**
 * JXA script: set kAXValueAttribute on the element (text input).
 * The text is injected as base64 (digits/letters only, injection-safe)
 * and decoded inside JXA with NSData/NSString — a raw string would have to
 * be shell-escaped *and* JS-escaped, and any single quote would break the
 * quoteShellArg wrapping.
 */
function jxaSetValueScript(pid: number, pathParts: number[], textB64: string): string {
  return `${jxaCommon(pid, pathParts)}
function runAction() {
${jxaApiDisabledGuard()}
  var target = elByPath(app, parts);
  if (!target) return { ok: false, error: 'ELEMENT_NOT_FOUND' };
  var nsdata = $.NSData.alloc.initWithBase64EncodedStringOptions("${textB64}", 0);
  var text = (nsdata && nsdata.length > 0) ? $.NSString.alloc.initWithDataEncoding(nsdata, $.NSUTF8StringEncoding) : "";
  if (text === "") return { ok: false, error: 'EMPTY_TEXT' };
  var r = $.AXUIElementSetAttributeValue(target, $.kAXValueAttribute, text);
  if (r === -25211) return { ok: false, error: 'API_DISABLED' };
  if (r !== 0) return { ok: false, error: 'SET_VALUE_FAILED' };
  return { ok: true };
}
JSON.stringify(runAction());`;
}

/**
 * JXA script: post a keyboard event directly into the leased app's event
 * queue via CGEventPostToPid — the app does NOT need to be frontmost and
 * the global keyboard stream is never touched. The AX probe surfaces the
 * common no-permission case (CGEventPostToPid itself returns void and
 * silently drops events without Accessibility / Event Posting permission).
 * `repeat` posts the event that many times (scroll degradation needs a
 * repeat count; press_key always passes 1).
 */
function jxaPostKeyScript(pid: number, code: number, flags: number, repeat = 1): string {
  return `ObjC.import('Foundation');
ObjC.import('ApplicationServices');
ObjC.import('CoreGraphics');
var pid = ${pid};
var app = $.AXUIElementCreateApplication(pid);
var probe = Ref(), perr = Ref();
var pr = $.AXUIElementCopyAttributeValue(app, $.kAXRoleAttribute, probe, perr);
if (pr === -25211) {
  JSON.stringify({ ok: false, error: 'API_DISABLED' });
} else {
  var down = $.CGEventCreateKeyboardEvent($(), ${code}, true);
  var up = $.CGEventCreateKeyboardEvent($(), ${code}, false);
  var flags = ${flags};
  if (flags !== 0) {
    $.CGEventSetFlags(down, flags);
    $.CGEventSetFlags(up, flags);
  }
  for (var n = 0; n < ${repeat}; n++) {
    $.CGEventPostToPid(pid, down);
    $.CGEventPostToPid(pid, up);
  }
  JSON.stringify({ ok: true });
}`;
}

/**
 * JXA script: scroll a scrollable ancestor of the element. Prefers the
 * AXScrollArea scroll action (kAXScrollDownByLineAction etc.); falls back
 * to adjusting an AXScrollBar's kAXValueAttribute by a fixed step.
 */
function jxaScrollScript(
  pid: number,
  pathParts: number[],
  direction: 'up' | 'down' | 'left' | 'right',
  amount: number,
): string {
  const actionName = SCROLL_AX_ACTIONS[direction];
  const repeat = Math.min(Math.max(amount, 1), 10);
  const decrease = direction === 'up' || direction === 'left';
  return `${jxaCommon(pid, pathParts)}
function toNum(v) {
  if (typeof v === 'number') return v;
  if (v && typeof v === 'object') {
    if (typeof v.width === 'number') return v.width;
    if (typeof v.w === 'number') return v.w;
  }
  return NaN;
}
function runAction() {
${jxaApiDisabledGuard()}
  var target = elByPath(app, parts);
  if (!target) return { ok: false, error: 'ELEMENT_NOT_FOUND' };
  var sc = null;
  var cur = target;
  for (var d = 0; d < 10; d++) {
    var role = String(attr(cur, $.kAXRoleAttribute) || '');
    if (role === "AXScrollArea" || role === "AXScrollBar") { sc = cur; break; }
    cur = attr(cur, $.kAXParentAttribute);
    if (!cur) break;
  }
  if (!sc) return { ok: false, error: 'NO_SCROLLABLE' };
  var role = String(attr(sc, $.kAXRoleAttribute) || '');
  if (role === "AXScrollArea") {
    for (var i = 0; i < ${repeat}; i++) {
      var r = $.AXUIElementPerformAction(sc, "${actionName}");
      if (r === -25211) return { ok: false, error: 'API_DISABLED' };
      if (r !== 0) return { ok: false, error: 'PERFORM_FAILED' };
    }
    return { ok: true };
  }
  var v = toNum(attr(sc, $.kAXValueAttribute));
  var mn = toNum(attr(sc, $.kAXMinValueAttribute));
  var mx = toNum(attr(sc, $.kAXMaxValueAttribute));
  if (isNaN(v) || isNaN(mn) || isNaN(mx)) return { ok: false, error: 'VALUE_UNREADABLE' };
  var step = 0.1;
  var nv = ${decrease ? 'v - step' : 'v + step'};
  nv = Math.min(Math.max(nv, mn), mx);
  var r2 = $.AXUIElementSetAttributeValue(sc, $.kAXValueAttribute, nv);
  if (r2 === -25211) return { ok: false, error: 'API_DISABLED' };
  if (r2 !== 0) return { ok: false, error: 'SET_VALUE_FAILED' };
  return { ok: true };
}
JSON.stringify(runAction());`;
}

/** Map a JXA result to a readable error message. */
function jxaErrorToMessage(result: JxaResult | null): string {
  if (!result) {
    return 'AX action failed: JXA returned no valid result (accessibility tree unavailable)';
  }
  if (result.error === 'API_DISABLED') return AX_API_DISABLED_MESSAGE;
  return `AX action failed: ${result.error}`;
}

async function execCommand(
  runner: ExecRunner,
  command: string,
  action: ActionType,
): Promise<ActionResult> {
  try {
    await runner.exec(command);
    return { ok: true, action };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, action, error: message };
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Execute a computer-use action on the remote macOS desktop.
 * AX element actions are the primary path (no mouse movement); osascript
 * synthesized input is the fallback for keys, coordinate clicks and
 * AX paths that fail to resolve.
 *
 * @param pid pid of the leased app — the AX tree and element actions are
 *   addressed to this app, so actions never hit the user's focused app.
 *   undefined (or 0) falls back to the focused application, which is only
 *   correct when no lease pid is available (coordinate-only actions).
 */
export async function performDarwinAction(
  runner: ExecRunner,
  action: Action,
  pid?: number,
): Promise<ActionResult> {
  switch (action.type) {
    // Primary path: AXPress on the snapshot element — never a synthesized
    // coordinate `click at` while a snapshotElement is available.
    case 'click_element': {
      if (!action.snapshotElement) {
        return {
          ok: false,
          action: action.type,
          error: 'No snapshotElement provided for click_element',
        };
      }
      const pathParts = parseElementPath(action.snapshotElement.elementId);
      if (!pathParts) {
        return {
          ok: false,
          action: action.type,
          error: `Invalid elementId '${action.snapshotElement.elementId}' for click_element (expected path like /0/2/5)`,
        };
      }
      const result = await runJxa(runner, jxaPressScript(pid ?? 0, pathParts));
      if (result?.ok === true) return { ok: true, action: action.type };
      return { ok: false, action: action.type, error: jxaErrorToMessage(result) };
    }

    // Explicit coordinate action — degraded, kept as-is.
    case 'click_point': {
      const cx = action.x ?? 0;
      const cy = action.y ?? 0;
      return execCommand(
        runner,
        `osascript -e 'tell application "System Events" to click at {${cx}, ${cy}}'`,
        action.type,
      );
    }

    case 'type_text': {
      if (!action.text) {
        return {
          ok: false,
          action: action.type,
          error: 'No text provided for type_text',
        };
      }
      // Cap oversized payloads (keystroke / SSH command-line sanity limit).
      const text = action.text.length > MAX_AX_TEXT_LENGTH
        ? action.text.slice(0, MAX_AX_TEXT_LENGTH)
        : action.text;
      // Primary path: set kAXValueAttribute directly on a text-field element.
      const el = action.snapshotElement;
      if (el && AX_TEXT_ROLES.has(el.role)) {
        const pathParts = parseElementPath(el.elementId);
        if (pathParts) {
          const textB64 = Buffer.from(text, 'utf8').toString('base64');
          const result = await runJxa(runner, jxaSetValueScript(pid ?? 0, pathParts, textB64));
          if (result?.ok === true) return { ok: true, action: action.type };
          // Fall through to activate + keystroke degradation on AX failure.
        }
      }
      // Degradation: keystroke synthesizes input into the *frontmost* app,
      // so first bring the leased app to the front (explicit — the AX path
      // already failed) so the typed text lands in it.
      const activate = pid !== undefined && pid > 0
        ? `${macActivateAppCommand(pid)} && `
        : '';
      return execCommand(runner, `${activate}${macKeystrokeCommand(text)}`, action.type);
    }

    case 'press_key': {
      if (!action.key) {
        return {
          ok: false,
          action: action.type,
          error: 'No key provided for press_key',
        };
      }
      const keyEvent = macKeyToKeyEvent(action.key);
      // Primary path: background delivery via CGEventPostToPid straight into
      // the leased app's event queue — no foreground requirement, no global
      // keyboard stream. Only possible with a target pid; keys without a
      // US-layout keycode (e.g. CJK) skip straight to the fallback.
      if (keyEvent && pid !== undefined && pid > 0) {
        const result = await runJxa(runner, jxaPostKeyScript(pid, keyEvent.code, keyEvent.flags));
        if (result?.ok === true) return { ok: true, action: action.type };
        if (result?.error === 'API_DISABLED') {
          return { ok: false, action: action.type, error: AX_API_DISABLED_MESSAGE };
        }
        // Other JXA failures degrade to synthesized input below.
      }
      let command: string;
      if (keyEvent) {
        command = `osascript -e 'tell application "System Events" to key code ${keyEvent.code}'`;
      } else if (action.key.length === 1) {
        command = macKeystrokeCommand(action.key);
      } else {
        return {
          ok: false,
          action: action.type,
          error: `Unsupported macOS key: '${action.key}'`,
        };
      }
      return execCommand(runner, command, action.type);
    }

    case 'scroll': {
      const direction = (action.direction ?? 'down') as 'up' | 'down' | 'left' | 'right';
      const amount = action.amount ?? 1;
      // Primary path: AX scroll on an ancestor scrollable of the element.
      const el = action.snapshotElement;
      if (el) {
        const pathParts = parseElementPath(el.elementId);
        if (pathParts) {
          const result = await runJxa(runner, jxaScrollScript(pid ?? 0, pathParts, direction, amount));
          if (result?.ok === true) return { ok: true, action: action.type };
          // Fall through to arrow-key degradation on AX failure.
        }
      }
      const repeat = Math.min(amount, 20);
      const code: Record<string, number> = {
        up: 126, down: 125, left: 123, right: 124,
      };
      const keyCode = code[direction] ?? 125;
      // Degradation path, background first: post the arrow keys into the
      // leased app's queue via CGEventPostToPid (same path as press_key);
      // synthesized input only when no pid is available or JXA fails.
      if (pid !== undefined && pid > 0) {
        const result = await runJxa(runner, jxaPostKeyScript(pid, keyCode, 0, repeat));
        if (result?.ok === true) return { ok: true, action: action.type };
        if (result?.error === 'API_DISABLED') {
          return { ok: false, action: action.type, error: AX_API_DISABLED_MESSAGE };
        }
      }
      const command = Array.from({ length: repeat }, () =>
        `osascript -e 'tell application "System Events" to key code ${keyCode}'`,
      ).join(' && ');
      return execCommand(runner, command, action.type);
    }

    // Explicit coordinate action — degraded, kept as-is.
    case 'double_click': {
      if (action.snapshotElement) {
        const b = action.snapshotElement.bounds;
        const dblCx = Math.round(b.x + b.width / 2);
        const dblCy = Math.round(b.y + b.height / 2);
        return execCommand(
          runner,
          `osascript -e 'tell application "System Events" to click at {${dblCx}, ${dblCy}}' && sleep 0.1 && osascript -e 'tell application "System Events" to click at {${dblCx}, ${dblCy}}'`,
          action.type,
        );
      }
      const dblX = action.x ?? 0;
      const dblY = action.y ?? 0;
      return execCommand(
        runner,
        `osascript -e 'tell application "System Events" to click at {${dblX}, ${dblY}}' && sleep 0.1 && osascript -e 'tell application "System Events" to click at {${dblX}, ${dblY}}'`,
        action.type,
      );
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
