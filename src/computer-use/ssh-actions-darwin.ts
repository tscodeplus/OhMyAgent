// src/computer-use/ssh-actions-darwin.ts
//
// macOS window-state reading and action execution over SSH.
// Primary path (accessibility-first): the AX (accessibility) tree via a
// native Swift tool (SWIFT_AX_TOOL_SOURCE, compiled with swiftc on first
// use) driving AXUIElement attributes and AXPress-style actions — no mouse
// movement, and the target app does not need to be foreground. Swift is
// used instead of JXA because macOS 15.7's JXA ObjC bridge fails on C
// functions with 2+ out-params (AXUIElementCopyAttributeValue and friends
// throw "incorrect number of arguments"), which broke every JXA AX script.
// Keyboard events (press_key, and the scroll arrow-key degradation) post
// straight into the leased app's event queue via CGEventPostToPid —
// background delivery, the same technique Peekaboo / mac-cua use: the app
// never becomes frontmost and the real keyboard stream is never touched.
// Only the final fallbacks use osascript synthesized input (keystroke /
// key code / coordinate `click at`), and only when no target pid is
// available or the background path fails.
//
// TCC note: AX calls (and CGEventPostToPid, which shares the bucket on most
// versions) require the process to hold Accessibility permission. When the
// OS rejects the AX API (kAXErrorAPIDisabled, -25211) the Swift tool
// returns {"ok":false,"error":"API_DISABLED"} and the platform layer
// surfaces a readable message: grant Accessibility in System Settings >
// Privacy & Security > Accessibility on the Mac and re-launch the app.
// Note CGEventPostToPid itself returns void and fails silently without
// permission — the tool probes the AX API first so the common
// no-permission case is still reported.

import { createHash } from 'node:crypto';
import type { ExecRunner } from './ssh-actions-common.js';
import type { Action, ActionResult, ActionType, AppInfo, UIElement } from './types.js';
import { quoteShellArg, truncateStdout } from './ssh-actions-common.js';

/** macOS key name -> key code mapping for osascript(1) key code commands. */
export const MAC_KEY_CODES: Record<string, number> = {
  Return: 36,
  Enter: 36,
  Escape: 53,
  Esc: 53,
  Tab: 48,
  BackSpace: 51,
  Delete: 117,
  Home: 115,
  End: 119,
  Page_Up: 116,
  Page_Down: 121,
  Up: 126,
  Down: 125,
  Left: 123,
  Right: 124,
  F1: 122,
  F2: 120,
  F3: 99,
  F4: 118,
  F5: 96,
  F6: 97,
  F7: 98,
  F8: 100,
  F9: 101,
  F10: 109,
  F11: 103,
  F12: 111,
  space: 49,
  Space: 49,
};

/** Timeout for JXA AX commands (tree walks can be slow over SSH). */
// Timeout for the Swift AX tool: the first invocation also compiles the
// tool with swiftc (~5-15s), subsequent ones just run the cached binary.
const AX_TOOL_TIMEOUT_MS = 60_000;

/**
 * Return/Enter virtual key code. Background-posted (CGEventPostToPid)
 * Return does not commit Safari's smart search field, so press_key prefers
 * the focused element's AXConfirm action for this key (see press_key).
 */
const MAC_KEYCODE_RETURN = 36;

/**
 * Native Swift AX tool source, embedded here and compiled with swiftc on
 * first use; the compiled binary is cached under the user's app-support
 * dir, keyed by the source hash (see runSwiftAx). Replaces the JXA ObjC
 * bridge, which macOS 15.7 breaks for C functions with 2+ out-params
 * (AXUIElementCopyAttributeValue etc. throw "incorrect number of
 * arguments"). Subcommands: tree / press / setvalue / postkey / hitpress /
 * confirmfocused / confirmpath / scroll / windowid / probe — each emits one
 * JSON object on stdout.
 * The script must not contain backticks or "${" (template-string rules).
 */
export const SWIFT_AX_TOOL_SOURCE = `import ApplicationServices
import Foundation
import CoreGraphics

// ================= helpers =================

func ax(_ el: AXUIElement, _ name: CFString) -> CFTypeRef? {
    var v: CFTypeRef?
    let err = AXUIElementCopyAttributeValue(el, name, &v)
    return err == AXError.success ? v : nil
}

func axErr(_ el: AXUIElement, _ name: CFString) -> AXError {
    var v: CFTypeRef?
    return AXUIElementCopyAttributeValue(el, name, &v)
}

// macOS 15.x regression: the "AXActions" ATTRIBUTE returns
// kAXErrorAttributeUnsupported (-25205) on every element, even Finder's.
// The equivalent C function AXUIElementCopyActionNames still works — use it
// everywhere actions are read, or every element would fail the tree filter
// and come back as an empty tree.
func actionsOf(_ el: AXUIElement) -> [String] {
    var names: CFArray?
    let err = AXUIElementCopyActionNames(el, &names)
    guard err == AXError.success, let arr = names as? [String] else { return [] }
    return arr
}

func pointAttr(_ el: AXUIElement, _ name: CFString) -> CGPoint? {
    guard let v = ax(el, name) else { return nil }
    var p = CGPoint.zero
    return AXValueGetValue(v as! AXValue, .cgPoint, &p) ? p : nil
}

func sizeAttr(_ el: AXUIElement, _ name: CFString) -> CGSize? {
    guard let v = ax(el, name) else { return nil }
    var s = CGSize.zero
    return AXValueGetValue(v as! AXValue, .cgSize, &s) ? s : nil
}

func json(_ obj: Any) -> String {
    guard let data = try? JSONSerialization.data(withJSONObject: obj) else { return "{}" }
    return String(data: data, encoding: .utf8) ?? "{}"
}

func fail(_ error: String) -> Never {
    print(json(["ok": false, "error" as CFString: error]))
    exit(1)
}

func parsePath(_ s: String) -> [Int] {
    s.split(separator: "/").compactMap { Int($0) }
}

func apiDisabled(_ app: AXUIElement) -> Bool {
    axErr(app, "AXRole" as CFString).rawValue == -25211
}

// Root-level children of an app element. Most apps expose their windows
// under AXChildren, but Safari (and some others) keep AXChildren empty and
// expose windows only via AXWindows — with no fallback the tree comes back
// empty and every element action degrades to blind coordinates.
func rootChildren(_ app: AXUIElement) -> [AXUIElement] {
    let kids = (ax(app, "AXChildren" as CFString) as? [AXUIElement]) ?? []
    let windows = (ax(app, "AXWindows" as CFString) as? [AXUIElement]) ?? []
    return kids.isEmpty && !windows.isEmpty ? windows : kids
}

func elByPath(_ app: AXUIElement, _ path: [Int]) -> AXUIElement? {
    var el = app
    for (i, idx) in path.enumerated() {
        let kids = i == 0 ? rootChildren(el) : ((ax(el, "AXChildren" as CFString) as? [AXUIElement]) ?? [])
        guard idx < kids.count else { return nil }
        el = kids[idx]
    }
    return el
}

// ================= tree =================

func walk(_ el: AXUIElement, _ path: [Int], _ depth: Int, _ out: inout [[String: Any]]) {
    if out.count >= 300 || depth >= 12 { return }
    guard let role = ax(el, "AXRole" as CFString) as? String, !role.isEmpty else { return }
    let actions = actionsOf(el)
    if !actions.isEmpty, let p = pointAttr(el, "AXPosition" as CFString),
       let s = sizeAttr(el, "AXSize" as CFString), s.width > 0, s.height > 0 {
        let enabled = (ax(el, "AXEnabled" as CFString) as? Bool) ?? true
        out.append([
            "path": path.map(String.init).joined(separator: "/"),
            "role": role,
            "label": (ax(el, "AXTitle" as CFString) as? String) ?? "",
            "description": (ax(el, "AXDescription" as CFString) as? String) ?? "",
            "actions": actions,
            "enabled": enabled,
            "bounds": ["x": p.x, "y": p.y, "width": s.width, "height": s.height],
        ])
    }
    guard let kids = ax(el, "AXChildren" as CFString) as? [AXUIElement] else { return }
    for (i, k) in kids.enumerated() {
        walk(k, path + [i], depth + 1, &out)
    }
}

func cmdTree(_ pid: pid_t) {
    let app = AXUIElementCreateApplication(pid)
    if apiDisabled(app) {
        print(json(["ok": false, "error" as CFString: "API_DISABLED"]))
        return
    }
    var out: [[String: Any]] = []
    for (i, w) in rootChildren(app).enumerated() {
        walk(w, [i], 0, &out)
    }
    print(json(["ok": true, "elements" as CFString: out, "truncated": out.count >= 300]))
}

// ================= press =================

func cmdPress(_ pid: pid_t, _ path: [Int]) {
    let app = AXUIElementCreateApplication(pid)
    if apiDisabled(app) { fail("API_DISABLED") }
    guard let target = elByPath(app, path) else { fail("ELEMENT_NOT_FOUND") }
    let actions = actionsOf(target)
    if actions.isEmpty { fail("NO_ACTION") }
    var action = "AXPress"
    if !actions.contains(action) { action = actions[0] }
    let err = AXUIElementPerformAction(target, action as CFString)
    if err.rawValue == -25211 { fail("API_DISABLED") }
    if err != AXError.success { fail("PERFORM_FAILED") }
    print(json(["ok": true]))
}

// ================= setvalue =================

func cmdSetValue(_ pid: pid_t, _ path: [Int], _ b64: String) {
    let app = AXUIElementCreateApplication(pid)
    if apiDisabled(app) { fail("API_DISABLED") }
    guard let target = elByPath(app, path) else { fail("ELEMENT_NOT_FOUND") }
    guard let data = Data(base64Encoded: b64), let text = String(data: data, encoding: .utf8), !text.isEmpty else {
        fail("EMPTY_TEXT")
    }
    let err = AXUIElementSetAttributeValue(target, "AXValue" as CFString, text as CFString)
    if err.rawValue == -25211 { fail("API_DISABLED") }
    if err != AXError.success { fail("SET_VALUE_FAILED") }
    print(json(["ok": true]))
}

// ================= confirmfocused =================

// Background-posted Enter (CGEventPostToPid) does not commit Safari's smart
// search field — verified live: URL unchanged after postkey Return, while
// the field's AXConfirm action navigates. Perform the focused element's
// AXConfirm when it offers one; fail with NO_FOCUS / NO_CONFIRM so the
// caller can fall back to the CGEvent path.
func cmdConfirmFocused(_ pid: pid_t) {
    let app = AXUIElementCreateApplication(pid)
    if apiDisabled(app) { fail("API_DISABLED") }
    guard let focused = ax(app, "AXFocusedUIElement" as CFString) else { fail("NO_FOCUS") }
    let target = focused as! AXUIElement
    let actions = actionsOf(target)
    guard actions.contains("AXConfirm") else { fail("NO_CONFIRM") }
    let err = AXUIElementPerformAction(target, "AXConfirm" as CFString)
    if err.rawValue == -25211 { fail("API_DISABLED") }
    if err != AXError.success { fail("PERFORM_FAILED") }
    print(json(["ok": true]))
}

// ================= confirmpath =================

// Same commit semantics as confirmfocused, addressed to an explicit element
// path instead of the app's focused element. A background-launched app keeps
// the AXWindow as its focused element (actions: AXRaise only) — verified
// live on macOS 15: after AXPress + AXValue set on Safari's address bar,
// AXFocusedUIElement still reports the window, so confirmfocused fails with
// NO_CONFIRM while the field itself offers AXConfirm. The caller tracks the
// element it last set text into (providerState.lastTextTargetPath) and
// confirms that element here.
func cmdConfirmPath(_ pid: pid_t, _ path: [Int]) {
    let app = AXUIElementCreateApplication(pid)
    if apiDisabled(app) { fail("API_DISABLED") }
    guard let target = elByPath(app, path) else { fail("ELEMENT_NOT_FOUND") }
    let actions = actionsOf(target)
    guard actions.contains("AXConfirm") else { fail("NO_CONFIRM") }
    let err = AXUIElementPerformAction(target, "AXConfirm" as CFString)
    if err.rawValue == -25211 { fail("API_DISABLED") }
    if err != AXError.success { fail("PERFORM_FAILED") }
    print(json(["ok": true]))
}

// ================= postkey =================

func cmdPostKey(_ pid: pid_t, _ code: CGKeyCode, _ flags: UInt64, _ repeatCount: Int) {
    let app = AXUIElementCreateApplication(pid)
    if apiDisabled(app) { fail("API_DISABLED") }
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) else {
        fail("EVENT_CREATE_FAILED")
    }
    if flags != 0 {
        down.flags = CGEventFlags(rawValue: flags)
        up.flags = CGEventFlags(rawValue: flags)
    }
    for _ in 0..<repeatCount {
        down.postToPid(pid)
        up.postToPid(pid)
    }
    print(json(["ok": true]))
}

// ================= hitpress =================

func cmdHitPress(_ pid: pid_t, _ x: Float, _ y: Float) {
    let sys = AXUIElementCreateSystemWide()
    var elRef: AXUIElement?
    let hr = AXUIElementCopyElementAtPosition(sys, x, y, &elRef)
    if hr.rawValue == -25211 { fail("API_DISABLED") }
    guard hr == AXError.success, let element = elRef else { fail("HIT_TEST_FAILED") }
    var hitPid: pid_t = 0
    let pidr = AXUIElementGetPid(element, &hitPid)
    if pidr != AXError.success || hitPid != pid { fail("FOREIGN_ELEMENT") }
    var cur: AXUIElement? = element
    var found: AXUIElement?
    var d = 0
    while let c = cur, d < 8 {
        if actionsOf(c).contains("AXPress") {
            found = c
            break
        }
        if let parent = ax(c, "AXParent" as CFString) { cur = parent as! AXUIElement }
        d += 1
    }
    guard let target = found else { fail("NO_ACTION") }
    let err = AXUIElementPerformAction(target, "AXPress" as CFString as CFString)
    if err.rawValue == -25211 { fail("API_DISABLED") }
    if err != AXError.success { fail("PERFORM_FAILED") }
    print(json(["ok": true]))
}

// ================= scroll =================

func cmdScroll(_ pid: pid_t, _ path: [Int], _ direction: String, _ amount: Int) {
    let app = AXUIElementCreateApplication(pid)
    if apiDisabled(app) { fail("API_DISABLED") }
    guard let target = elByPath(app, path) else { fail("ELEMENT_NOT_FOUND") }
    let actionName: String
    switch direction {
    case "up": actionName = "AXScrollUpByLine"
    case "down": actionName = "AXScrollDownByLine"
    case "left": actionName = "AXScrollLeftByLine"
    default: actionName = "AXScrollRightByLine"
    }
    var sc: AXUIElement?
    var cur: AXUIElement? = target
    for _ in 0..<10 {
        guard let c = cur else { break }
        let role = (ax(c, "AXRole" as CFString) as? String) ?? ""
        if role == "AXScrollArea" || role == "AXScrollBar" {
            sc = c
            break
        }
        if let parent = ax(c, "AXParent" as CFString) { cur = parent as! AXUIElement }
    }
    guard let scrollEl = sc else { fail("NO_SCROLLABLE") }
    let role = (ax(scrollEl, "AXRole" as CFString) as? String) ?? ""
    if role == "AXScrollArea" {
        for _ in 0..<amount {
            let r = AXUIElementPerformAction(scrollEl, actionName as CFString)
            if r.rawValue == -25211 { fail("API_DISABLED") }
            if r != AXError.success { fail("PERFORM_FAILED") }
        }
        print(json(["ok": true]))
        return
    }
    let val = (ax(scrollEl, "AXValue" as CFString) as? NSNumber)?.doubleValue ?? Double.nan
    let mn = (ax(scrollEl, "AXMinValue" as CFString) as? NSNumber)?.doubleValue ?? Double.nan
    let mx = (ax(scrollEl, "AXMaxValue" as CFString) as? NSNumber)?.doubleValue ?? Double.nan
    guard !val.isNaN, !mn.isNaN, !mx.isNaN else { fail("VALUE_UNREADABLE") }
    let step = 0.1
    let nv = (direction == "up" || direction == "left") ? val - step : val + step
    let clamped = min(max(nv, mn), mx)
    let err = AXUIElementSetAttributeValue(scrollEl, "AXValue" as CFString, NSNumber(value: clamped))
    if err.rawValue == -25211 { fail("API_DISABLED") }
    if err != AXError.success { fail("SET_VALUE_FAILED") }
    print(json(["ok": true]))
}

// ================= windowid =================

func cmdWindowId(_ pid: pid_t) {
    let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    guard let list = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else {
        print(json([:]))
        return
    }
    var bestID = 0
    var bestArea = 0.0
    for w in list {
        guard let ownerPid = w[kCGWindowOwnerPID as String] as? Int, ownerPid == pid else { continue }
        guard let layer = w[kCGWindowLayer as String] as? Int, layer == 0 else { continue }
        guard let b = w[kCGWindowBounds as String] as? [String: Any] else { continue }
        let width = (b["Width"] as? Double) ?? 0
        let height = (b["Height"] as? Double) ?? 0
        let area = width * height
        if area > bestArea {
            bestArea = area
            bestID = w[kCGWindowNumber as String] as? Int ?? 0
        }
    }
    if bestID > 0 {
        print(json(["id": bestID]))
    } else {
        print(json([:]))
    }
}

// ================= main =================

let args = CommandLine.arguments
guard args.count >= 2 else { fail("USAGE") }
switch args[1] {
case "probe":
    let sysProbe = AXUIElementCreateSystemWide()
    let errProbe = axErr(sysProbe, "AXRole" as CFString)
    print(json(["ok": errProbe == AXError.success]))
case "tree":
    guard args.count >= 3, let pid = pid_t(args[2]) else { fail("ARGS") }
    cmdTree(pid)
case "press":
    guard args.count >= 4, let pid = pid_t(args[2]) else { fail("ARGS") }
    cmdPress(pid, parsePath(args[3]))
case "setvalue":
    guard args.count >= 5, let pid = pid_t(args[2]) else { fail("ARGS") }
    cmdSetValue(pid, parsePath(args[3]), args[4])
case "postkey":
    guard args.count >= 6, let pid = pid_t(args[2]), let code = CGKeyCode(args[3]),
          let flags = UInt64(args[4]), let rep = Int(args[5]) else { fail("ARGS") }
    cmdPostKey(pid, code, flags, rep)
case "confirmfocused":
    guard args.count >= 3, let pid = pid_t(args[2]) else { fail("ARGS") }
    cmdConfirmFocused(pid)
case "confirmpath":
    guard args.count >= 4, let pid = pid_t(args[2]) else { fail("ARGS") }
    cmdConfirmPath(pid, parsePath(args[3]))
case "hitpress":
    guard args.count >= 5, let pid = pid_t(args[2]), let x = Float(args[3]), let y = Float(args[4]) else { fail("ARGS") }
    cmdHitPress(pid, x, y)
case "scroll":
    guard args.count >= 6, let pid = pid_t(args[2]), let rep = Int(args[5]) else { fail("ARGS") }
    cmdScroll(pid, parsePath(args[3]), args[4], rep)
case "windowid":
    guard args.count >= 3, let pid = pid_t(args[2]) else { fail("ARGS") }
    cmdWindowId(pid)
default:
    fail("UNKNOWN_CMD")
}
`;

interface SwiftAxResult {
  ok?: boolean;
  error?: string;
  elements?: RawAxElement[];
  truncated?: boolean;
  id?: number;
}

const AX_TOOL_HASH = createHash('sha256').update(SWIFT_AX_TOOL_SOURCE).digest('hex').slice(0, 16);
// The compiled tool is cached under the user's app-support dir, keyed by the
// source hash — NOT /tmp. /tmp is world-writable (any process can overwrite
// the binary or trigger a rebuild) and is cleared on reboot, which twice
// silently regressed the AX layer to an older embedded source during the
// macOS 15 regression hunt. A hash-named binary is immutable: the embedded
// source never changes, so the tool is compiled at most once per install
// and the old mtime-compare dance disappears entirely.
const AX_TOOL_DIR = '$HOME/Library/Application Support/OhMyAgent';
const AX_TOOL_SRC = `${AX_TOOL_DIR}/oma-ax-${AX_TOOL_HASH}.swift`;
const AX_TOOL_BIN = `${AX_TOOL_DIR}/oma-ax-${AX_TOOL_HASH}`;

/**
 * Run the Swift AX tool through the runner. A normal call is one mkdir +
 * one `-x` check + exec of the hash-keyed binary; only the first call per
 * embedded source compiles (to a per-pid temp, atomically renamed into
 * place so concurrent first calls never interleave a partial binary). A
 * failed compile emits a JSON error, so callers see COMPILE_FAILED instead
 * of a silent null. Returns the parsed JSON result, or null when the
 * command fails or stdout is not valid JSON — callers must treat null as
 * a graceful degradation signal, never throw.
 */
export async function runSwiftAx(
  runner: ExecRunner,
  args: string[],
  timeoutMs = AX_TOOL_TIMEOUT_MS,
): Promise<SwiftAxResult | null> {
  try {
    const srcB64 = Buffer.from(SWIFT_AX_TOOL_SOURCE, 'utf8').toString('base64');
    const bin = `"${AX_TOOL_BIN}"`;
    const cmd =
      `mkdir -p "${AX_TOOL_DIR}" && ` +
      `( [ -x ${bin} ] || ` +
      `  { echo ${srcB64} | base64 -d > "${AX_TOOL_SRC}" && ` +
      `    swiftc -O "${AX_TOOL_SRC}" -o "${AX_TOOL_BIN}.$$" && mv "${AX_TOOL_BIN}.$$" "${AX_TOOL_BIN}" || ` +
      `    { echo '{"ok":false,"error":"COMPILE_FAILED"}'; exit 1; }; } ) && ` +
      `${bin} ${args.join(' ')}`;
    const res = await runner.exec(cmd, { timeoutMs });
    const trimmed = res.stdout.trim();
    if (!trimmed) return null;
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object') return parsed as SwiftAxResult;
    return null;
  } catch {
    return null;
  }
}

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
    ['a', 0],
    ['s', 1],
    ['d', 2],
    ['f', 3],
    ['h', 4],
    ['g', 5],
    ['z', 6],
    ['x', 7],
    ['c', 8],
    ['v', 9],
    ['b', 11],
    ['q', 12],
    ['w', 13],
    ['e', 14],
    ['r', 15],
    ['y', 16],
    ['t', 17],
    ['o', 31],
    ['u', 32],
    ['i', 34],
    ['p', 35],
    ['l', 37],
    ['j', 38],
    ['k', 40],
    ['n', 45],
    ['m', 46],
    ['1', 18],
    ['2', 19],
    ['3', 20],
    ['4', 21],
    ['5', 23],
    ['6', 22],
    ['7', 26],
    ['8', 28],
    ['9', 25],
    ['0', 29],
    [' ', 49],
    ['-', 27],
    ['=', 24],
    ['[', 33],
    [']', 30],
    ['\\', 42],
    [';', 41],
    ["'", 39],
    [',', 43],
    ['.', 47],
    ['/', 44],
    ['`', 50],
  ];
  const shifted: Array<[string, number]> = [
    ['~', 50],
    ['!', 18],
    ['@', 19],
    ['#', 20],
    ['$', 21],
    ['%', 23],
    ['^', 22],
    ['&', 26],
    ['*', 28],
    ['(', 25],
    [')', 29],
    ['_', 27],
    ['+', 24],
    ['{', 33],
    ['}', 30],
    ['|', 42],
    [':', 41],
    ['"', 39],
    ['<', 43],
    ['>', 47],
    ['?', 44],
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

/** CGEvent modifier masks, for combo keys and the System Events fallback. */
const CG_EVENT_FLAG_COMMAND = 0x001000;
const CG_EVENT_FLAG_CONTROL = 0x040000;
const CG_EVENT_FLAG_ALTERNATE = 0x080000;

/** Modifier prefix name -> CGEvent flag mask. "Meta" is the cross-platform
 * name agents emit; on macOS it means Command. */
const MAC_MODIFIER_FLAGS: Record<string, number> = {
  Cmd: CG_EVENT_FLAG_COMMAND,
  Command: CG_EVENT_FLAG_COMMAND,
  Meta: CG_EVENT_FLAG_COMMAND,
  Super: CG_EVENT_FLAG_COMMAND,
  Win: CG_EVENT_FLAG_COMMAND,
  Windows: CG_EVENT_FLAG_COMMAND,
  Ctrl: CG_EVENT_FLAG_CONTROL,
  Control: CG_EVENT_FLAG_CONTROL,
  Alt: CG_EVENT_FLAG_ALTERNATE,
  Option: CG_EVENT_FLAG_ALTERNATE,
  Opt: CG_EVENT_FLAG_ALTERNATE,
  Shift: CG_EVENT_FLAG_SHIFT,
};

/**
 * Resolve a press_key value to a virtual key code + modifier flags, or null
 * when the key has no US-layout keycode (CJK characters etc.). Supports
 * single keys ("l", "Return", "F5") and combo keys ("Cmd+L", "Meta+A",
 * "Ctrl+Shift+Z") — the base letter is matched lowercase so the Shift flag
 * comes only from an explicit Shift modifier, never from the letter case.
 */
function macKeyToKeyEvent(key: string): { code: number; flags: number } | null {
  const named = MAC_KEY_CODES[key];
  if (named !== undefined) return { code: named, flags: 0 };
  if (key.length === 1) {
    const m = MAC_ASCII_KEY_CODES[key];
    if (m) return { code: m.code, flags: m.shift ? CG_EVENT_FLAG_SHIFT : 0 };
  }
  const parts = key.split('+');
  if (parts.length >= 2) {
    let flags = 0;
    for (const mod of parts.slice(0, -1)) {
      const f = MAC_MODIFIER_FLAGS[mod];
      if (f === undefined) return null;
      flags |= f;
    }
    const baseRaw = parts[parts.length - 1];
    let code = MAC_KEY_CODES[baseRaw];
    if (code === undefined && baseRaw.length === 1) {
      const m = MAC_ASCII_KEY_CODES[baseRaw.toLowerCase()];
      if (m) code = m.code;
    }
    if (code === undefined) return null;
    return { code, flags };
  }
  return null;
}

/** Map CGEvent flags to the System Events `key code ... using {...}`
 * modifier list (empty when no modifiers). */
function macModifiersAppleScript(flags: number): string {
  const mods: string[] = [];
  if (flags & CG_EVENT_FLAG_COMMAND) mods.push('command down');
  if (flags & CG_EVENT_FLAG_SHIFT) mods.push('shift down');
  if (flags & CG_EVENT_FLAG_CONTROL) mods.push('control down');
  if (flags & CG_EVENT_FLAG_ALTERNATE) mods.push('option down');
  return mods.length > 0 ? ` using {${mods.join(', ')}}` : '';
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
  const script = `tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`;
  return `osascript -e ${quoteShellArg(script)}`;
}

/**
 * Query whether the process is the frontmost app via System Events.
 * Returns undefined when the query itself fails (TCC or app-not-visible) —
 * callers must not block on an unknown answer.
 */
async function isAppFrontmost(runner: ExecRunner, pid: number): Promise<boolean | undefined> {
  try {
    const res = await runner.exec(
      `osascript -e 'tell application "System Events" to get frontmost of (first process whose unix id is ${pid})'`,
    );
    return res.stdout.trim() === 'true';
  } catch {
    return undefined;
  }
}

/**
 * Bring the app to the front and verify it actually became frontmost.
 * Used before degraded synthesized-input fallbacks (`key code` / keystroke)
 * so the keys land in the leased app instead of whatever the user has on
 * top — mirrors the Windows SetForegroundWindow + verification pattern.
 */
async function ensureAppFrontmost(runner: ExecRunner, pid: number): Promise<boolean> {
  try {
    await runner.exec(macActivateAppCommand(pid));
    const now = await isAppFrontmost(runner, pid);
    return now === true;
  } catch {
    return false;
  }
}

/**
 * The pid of the app currently holding the foreground (System Events query),
 * undefined when the query fails (TCC, no frontmost app) — callers must not
 * block on an unknown answer.
 */
async function getFrontmostPid(runner: ExecRunner): Promise<number | undefined> {
  try {
    const res = await runner.exec(
      `osascript -e 'tell application "System Events" to get unix id of first process whose frontmost is true'`,
    );
    const pid = parseInt(res.stdout.trim(), 10);
    return isNaN(pid) ? undefined : pid;
  } catch {
    return undefined;
  }
}

/**
 * Whether the user touched the keyboard/mouse within the last 3 seconds
 * (HIDIdleTime via ioreg, seconds). Unknown (command failed / unparseable)
 * means idle — the guard must never block on an unknown answer.
 */
async function isUserActive(runner: ExecRunner): Promise<boolean> {
  try {
    const res = await runner.exec(
      `ioreg -c IOHIDSystem | awk '/HIDIdleTime/ {print $NF/1000000000; exit}'`,
    );
    const idleSec = parseFloat(res.stdout.trim());
    if (isNaN(idleSec)) return false;
    return idleSec < 3;
  } catch {
    return false;
  }
}

interface FrontmostSwap {
  ok: boolean;
  /** Failure reason when !ok (the user is active — the foreground must not be stolen). */
  error?: string;
  /** The app that held the foreground before the swap; restore target. */
  prevFgPid?: number;
}

/**
 * Ensure synthesized (frontmost-bound) input would reach the leased app:
 * no-op when already frontmost or no pid is known; otherwise refuse while
 * the user is actively using the computer, then activate and verify.
 * Returns false when the app cannot be brought to the front — the caller
 * must fail rather than post keys into the user's app. Mirrors the Windows
 * USER_ACTIVE guard + foreground hand-back pattern.
 */
async function requireFrontmostForInput(runner: ExecRunner, pid?: number): Promise<FrontmostSwap> {
  if (pid === undefined || pid <= 0) return { ok: true };
  const frontmost = await isAppFrontmost(runner, pid);
  if (frontmost === true) return { ok: true };
  if (await isUserActive(runner)) {
    return { ok: false, error: 'User is actively using the computer; retry later' };
  }
  const prevFgPid = await getFrontmostPid(runner);
  if (!(await ensureAppFrontmost(runner, pid))) {
    return { ok: false, error: 'Could not foreground target app' };
  }
  return { ok: true, prevFgPid };
}

/**
 * Hand the foreground back to the app that held it before an agent-initiated
 * activation, but only while the target still holds it — a third app means
 * the user/OS switched, never yank it away.
 */
async function restoreFrontmost(
  runner: ExecRunner,
  targetPid: number | undefined,
  prevFgPid?: number,
) {
  if (!prevFgPid || !targetPid || prevFgPid === targetPid) return;
  if ((await getFrontmostPid(runner)) !== targetPid) return;
  await runner.exec(macActivateAppCommand(prevFgPid)).catch(() => {});
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
    const names = result.stdout
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return names.map((name) => ({
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
  /** True when the frontmost process is loginwindow (screen locked / at the login screen). */
  locked?: boolean;
  /** Human-readable note when the AX tree could not be read (e.g. TCC). */
  axError?: string;
}

/** Notice appended to the agent-visible state when the screen is locked. */
export const DARWIN_LOCKED_NOTICE =
  'The Mac screen is at the login/lock screen (frontmost process: loginwindow). ' +
  'The user session may still be active, but visual control requires the screen to be ' +
  'unlocked — ask the user to unlock the Mac; do not attempt to type credentials.';

/**
 * Resolve the CGWindowNumber of the app's largest on-screen window, or
 * undefined when the query fails / the app has no on-screen window. The
 * Swift tool emits {} when the app has no on-screen window (minimized /
 * hidden / no windows) so the caller falls back to a full-screen capture.
 */
async function getWindowIdForPid(runner: ExecRunner, pid: number): Promise<number | undefined> {
  const result = await runSwiftAx(runner, ['windowid', String(pid)]);
  const id = result?.id;
  return typeof id === 'number' && id > 0 ? id : undefined;
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
  // The leased app is launched in the background (open -g) and stays
  // non-frontmost, so a full-screen capture shows whatever IS frontmost
  // (the desktop / the user's app) — never the leased app. When the pid is
  // known, capture the app's own window instead (screencapture -l grabs the
  // window's content even when it is occluded), falling back to the full
  // screen when no window id can be resolved.
  let screenshotBase64 = '';
  if (pid !== undefined && pid > 0) {
    const windowId = await getWindowIdForPid(runner, pid);
    if (windowId) {
      try {
        await runner.exec(`screencapture -x -l ${windowId} /tmp/cua_${leaseId}.png`);
        const b64Result = await runner.exec(`base64 -i /tmp/cua_${leaseId}.png`);
        screenshotBase64 = b64Result.stdout.trim();
      } catch {
        /* window capture failed — full-screen fallback below */
      }
    }
  }
  if (!screenshotBase64) {
    try {
      await runner.exec(`screencapture -x -T0 /tmp/cua_${leaseId}.png`);
      const b64Result = await runner.exec(`base64 -i /tmp/cua_${leaseId}.png`);
      screenshotBase64 = b64Result.stdout.trim();
    } catch {
      /* screencapture failed */
    }
  }
  await runner.exec(`rm -f /tmp/cua_${leaseId}.png`).catch(() => {});

  // Frontmost app name: identifies the locked-screen case (loginwindow) and
  // is the fallback title when no pid is available. NOTE: `front process`
  // is NOT reliable here — on macOS 15 it reports "loginwindow" even when
  // the screen is unlocked and a real app is frontmost (observed with
  // OhMyAgent: lsappinfo front + `frontmost is true` said ohmyagent-desktop
  // while `front process` said loginwindow). The frontmost query reflects
  // the actual top window (loginwindow only when the lock/login UI really
  // covers the screen), so lock detection keys on it.
  let windowTitle = '';
  let locked = false;
  try {
    const titleResult = await runner.exec(
      `osascript -e 'tell application "System Events" to get name of first process whose frontmost is true'`,
    );
    windowTitle = truncateStdout(titleResult.stdout.trim());
    locked = windowTitle.toLowerCase() === 'loginwindow';
  } catch {
    /* Non-critical */
  }

  // With a lease pid, the state should describe the LEASED app (e.g.
  // "Safari"), not whatever holds the foreground — the background-launched
  // app is usually not frontmost, and "Finder"/"loginwindow" would mislead
  // the agent about what the snapshot shows.
  if (pid !== undefined && pid > 0) {
    try {
      const nameResult = await runner.exec(
        `osascript -e 'tell application "System Events" to get name of first process whose unix id is ${pid}'`,
      );
      const name = nameResult.stdout.trim();
      if (name) windowTitle = truncateStdout(name);
    } catch {
      /* keep the front-process name */
    }
  }

  // AX tree. runSwiftAx returns null when the tool fails / output is not
  // valid JSON — we yield an empty list and surface an axError instead.
  let elements: UIElement[] = [];
  let axError: string | undefined;
  const treeResult = await runSwiftAx(runner, ['tree', String(pid ?? 0)]);
  if (treeResult?.ok === true && Array.isArray(treeResult.elements)) {
    elements = treeResult.elements.map(mapRawElement);
  } else if (treeResult?.error === 'API_DISABLED') {
    axError = AX_API_DISABLED_MESSAGE;
  } else if (treeResult === null) {
    // The JXA script itself failed (non-JSON output / exec error) — with
    // missing Accessibility permission the AX API can reject the process
    // with errors other than API_DISABLED, which aborts the whole script.
    // Surface that instead of reporting a silently empty tree.
    axError = AX_API_DISABLED_MESSAGE;
  }

  return { screenshotBase64, windowTitle, elements, locked, axError };
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
  'textbox',
  'textarea',
  'textfield',
  'searchfield',
  'passwordfield',
  'combobox',
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
function jxaErrorToMessage(result: SwiftAxResult | null): string {
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
  textTargetPath?: string,
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
      const result = await runSwiftAx(runner, [
        'press',
        String(pid ?? 0),
        action.snapshotElement.elementId,
      ]);
      if (result?.ok === true) return { ok: true, action: action.type };
      return { ok: false, action: action.type, error: jxaErrorToMessage(result) };
    }

    case 'click_point': {
      const cx = action.x ?? 0;
      const cy = action.y ?? 0;
      // Primary path: AX hit-test at the screen point and AXPress the
      // resolved element (only when it belongs to the leased app — never
      // click whatever the user has on top). No synthesized mouse event, so
      // the real cursor never moves. Degrades to the explicit System Events
      // click (cursor moves) when no pid is available or AX cannot resolve.
      if (pid !== undefined && pid > 0) {
        const result = await runSwiftAx(runner, ['hitpress', String(pid), String(cx), String(cy)]);
        if (result?.ok === true) return { ok: true, action: action.type };
        if (result?.error === 'API_DISABLED') {
          return { ok: false, action: action.type, error: AX_API_DISABLED_MESSAGE };
        }
      }
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
      const text =
        action.text.length > MAX_AX_TEXT_LENGTH
          ? action.text.slice(0, MAX_AX_TEXT_LENGTH)
          : action.text;
      // Primary path: set kAXValueAttribute directly on a text-field element.
      const el = action.snapshotElement;
      if (el && AX_TEXT_ROLES.has(el.role)) {
        const pathParts = parseElementPath(el.elementId);
        if (pathParts) {
          const textB64 = Buffer.from(text, 'utf8').toString('base64');
          const result = await runSwiftAx(runner, [
            'setvalue',
            String(pid ?? 0),
            el.elementId,
            textB64,
          ]);
          if (result?.ok === true) return { ok: true, action: action.type };
          // Fall through to activate + keystroke degradation on AX failure.
        }
      }
      // Degradation: keystroke synthesizes input into the *frontmost* app,
      // so ensure the leased app is frontmost first (activate + verify) —
      // the AX path already failed, so this is an explicit foreground swap,
      // and it must land in the leased app, never the user's front app. The
      // swap refuses while the user is active and is handed back afterwards.
      const swap = await requireFrontmostForInput(runner, pid);
      if (!swap.ok) {
        return {
          ok: false,
          action: action.type,
          error: swap.error ?? 'Could not foreground target app for text entry',
        };
      }
      const result = await execCommand(runner, macKeystrokeCommand(text), action.type);
      await restoreFrontmost(runner, pid, swap.prevFgPid);
      return result;
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
      // Enter/Return: the AX-native commit for text fields is AXConfirm on
      // the focused element. Safari (and most Cocoa apps) ignore Enter
      // posted in the background via CGEventPostToPid for smart-search
      // commits — the value was set but no navigation started (verified on
      // macOS 15). Prefer AXConfirm; fall through to the CGEvent path when
      // no focused element offers it.
      if (keyEvent?.code === MAC_KEYCODE_RETURN && pid !== undefined && pid > 0) {
        const confirm = await runSwiftAx(runner, ['confirmfocused', String(pid)]);
        if (confirm?.ok === true) return { ok: true, action: action.type };
        if (confirm?.error === 'API_DISABLED') {
          return { ok: false, action: action.type, error: AX_API_DISABLED_MESSAGE };
        }
        // A background-launched app keeps the AXWindow as its focused element
        // (actions: AXRaise only) — AXFocusedUIElement never reaches the text
        // field, so confirmfocused fails with NO_CONFIRM. Fall back to the
        // element the caller last set text into (providerState tracks it),
        // which is the intended commit target (Safari's address bar offers
        // AXConfirm).
        if (textTargetPath) {
          const confirmPath = await runSwiftAx(runner, [
            'confirmpath',
            String(pid),
            textTargetPath,
          ]);
          if (confirmPath?.ok === true) return { ok: true, action: action.type };
          if (confirmPath?.error === 'API_DISABLED') {
            return { ok: false, action: action.type, error: AX_API_DISABLED_MESSAGE };
          }
        }
        // NO_FOCUS / NO_CONFIRM / ELEMENT_NOT_FOUND / tool failure — fall
        // through to background post.
      }
      // Primary path: background delivery via CGEventPostToPid straight into
      // the leased app's event queue — no foreground requirement, no global
      // keyboard stream. Only possible with a target pid; keys without a
      // US-layout keycode (e.g. CJK) skip straight to the fallback.
      if (keyEvent && pid !== undefined && pid > 0) {
        const result = await runSwiftAx(runner, [
          'postkey',
          String(pid),
          String(keyEvent.code),
          String(keyEvent.flags),
          '1',
        ]);
        if (result?.ok === true) return { ok: true, action: action.type };
        if (result?.error === 'API_DISABLED') {
          return { ok: false, action: action.type, error: AX_API_DISABLED_MESSAGE };
        }
        // Other JXA failures degrade to synthesized input below.
      }
      // Degraded path: System Events key code / keystroke posts into the
      // FRONTMOST app. Ensure the leased app is frontmost first (activate +
      // verify), else the key would land in whatever the user has on top.
      // The swap refuses while the user is active and is handed back once
      // the key has been delivered.
      const swap = await requireFrontmostForInput(runner, pid);
      if (!swap.ok) {
        return {
          ok: false,
          action: action.type,
          error: swap.error ?? 'Could not foreground target app for key delivery',
        };
      }
      let command: string;
      if (keyEvent) {
        // Keep the combo modifiers on the degraded path: without them
        // "Cmd+L" would arrive as a bare "l" in the leased app.
        command = `osascript -e 'tell application "System Events" to key code ${keyEvent.code}${macModifiersAppleScript(keyEvent.flags)}'`;
      } else if (action.key.length === 1) {
        command = macKeystrokeCommand(action.key);
      } else {
        return {
          ok: false,
          action: action.type,
          error: `Unsupported macOS key: '${action.key}'`,
        };
      }
      const result = await execCommand(runner, command, action.type);
      await restoreFrontmost(runner, pid, swap.prevFgPid);
      return result;
    }

    case 'scroll': {
      const direction = (action.direction ?? 'down') as 'up' | 'down' | 'left' | 'right';
      const amount = action.amount ?? 1;
      // Primary path: AX scroll on an ancestor scrollable of the element.
      const el = action.snapshotElement;
      if (el) {
        const pathParts = parseElementPath(el.elementId);
        if (pathParts) {
          const axRepeat = Math.min(Math.max(amount, 1), 10);
          const result = await runSwiftAx(runner, [
            'scroll',
            String(pid ?? 0),
            el.elementId,
            direction,
            String(axRepeat),
          ]);
          if (result?.ok === true) return { ok: true, action: action.type };
          // Fall through to arrow-key degradation on AX failure.
        }
      }
      const repeat = Math.min(amount, 20);
      const code: Record<string, number> = {
        up: 126,
        down: 125,
        left: 123,
        right: 124,
      };
      const keyCode = code[direction] ?? 125;
      // Degradation path, background first: post the arrow keys into the
      // leased app's queue via CGEventPostToPid (same path as press_key);
      // synthesized input only when no pid is available or JXA fails.
      if (pid !== undefined && pid > 0) {
        const result = await runSwiftAx(runner, [
          'postkey',
          String(pid),
          String(keyCode),
          '0',
          String(repeat),
        ]);
        if (result?.ok === true) return { ok: true, action: action.type };
        if (result?.error === 'API_DISABLED') {
          return { ok: false, action: action.type, error: AX_API_DISABLED_MESSAGE };
        }
      }
      // System Events key code targets the frontmost app — same ensure as
      // press_key so the scroll keys reach the leased app, not the user's.
      // Same active-user refusal and foreground hand-back.
      const swap = await requireFrontmostForInput(runner, pid);
      if (!swap.ok) {
        return {
          ok: false,
          action: action.type,
          error: swap.error ?? 'Could not foreground target app for scroll keys',
        };
      }
      const command = Array.from(
        { length: repeat },
        () => `osascript -e 'tell application "System Events" to key code ${keyCode}'`,
      ).join(' && ');
      const result = await execCommand(runner, command, action.type);
      await restoreFrontmost(runner, pid, swap.prevFgPid);
      return result;
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
