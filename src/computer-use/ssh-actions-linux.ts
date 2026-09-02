// src/computer-use/ssh-actions-linux.ts
//
// Linux desktop window-state reading and action execution over SSH.
// Primary path: AT-SPI2 accessibility tree + control actions (no mouse
// movement). Fallback: xdotool coordinate injection for apps without an
// accessibility tree (games, custom-drawn UIs).
//
// AT-SPI2 access runs a python3 + pyatspi script on the remote host. SSH
// non-login sessions have no DBUS_SESSION_BUS_ADDRESS, so the script recovers
// the address from the at-spi-bus-launcher / dbus-daemon --session process
// (via /proc/<pid>/environ) before touching the bus.

import type { ExecRunner } from './ssh-actions-common.js';
import type { Action, ActionResult, AppInfo, UIElement, WindowInfo } from './types.js';
import { quoteShellArg, truncateStdout } from './ssh-actions-common.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Known xdotool key names (beyond alphanumeric chars). */
const SPECIAL_KEYS = new Set([
  'Return',
  'Escape',
  'Tab',
  'BackSpace',
  'Delete',
  'Home',
  'End',
  'Page_Up',
  'Page_Down',
  'Up',
  'Down',
  'Left',
  'Right',
  'F1',
  'F2',
  'F3',
  'F4',
  'F5',
  'F6',
  'F7',
  'F8',
  'F9',
  'F10',
  'F11',
  'F12',
  'space',
  'minus',
  'equal',
  'bracketleft',
  'bracketright',
  'backslash',
  'semicolon',
  'apostrophe',
  'comma',
  'period',
  'slash',
  'grave',
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

/**
 * Element ids from the AT-SPI tree are DFS index paths ("/0/2/5"). Anything
 * else (legacy ids, window handles) falls back to coordinate injection.
 */
const ATSPI_PATH_RE = /^\/\d+(?:\/\d+)*$/;

/** Cap for injected text (64KB); oversized payloads are truncated. */
const MAX_TEXT_LENGTH = 64 * 1024;

/**
 * Log a degraded (non-accessibility-tree) fallback. The action modules have
 * no pino logger, so stderr keeps the note out of any protocol stdout.
 */
function logDegraded(reason: string): void {
  console.error(`[computer-use/linux] degraded fallback: ${reason}`);
}

/**
 * List running applications on a Linux desktop. Primary path: `wmctrl -l`
 * (windows grouped by first word of the title); fallback: `xdotool search`
 * + `getwindowname` per window. Shared by the SSH provider and the local
 * Linux provider (local-linux).
 */
export async function listLinuxApps(runner: ExecRunner): Promise<AppInfo[]> {
  // Primary path: wmctrl -l
  try {
    const result = await runner.exec('wmctrl -l');
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
      const searchResult = await runner.exec('xdotool search --name ""');
      const wids = searchResult.stdout.trim().split('\n').filter(Boolean);
      const apps: AppInfo[] = [];

      for (const wid of wids) {
        try {
          const nameResult = await runner.exec(`xdotool getwindowname ${wid}`);
          const title = nameResult.stdout.trim();
          if (!title) continue;

          const firstWord = title.split(/\s+/)[0];
          const existing = apps.find((a) => a.name === firstWord);
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

export interface LinuxWindowState {
  screenshotBase64: string;
  windowTitle: string;
  width: number;
  height: number;
  screenWidth: number;
  screenHeight: number;
  elements: UIElement[];
}

/**
 * Read the current state of the remote Linux desktop: screenshot, window
 * title/geometry, display geometry and the AT-SPI2 accessibility tree.
 * Every step degrades gracefully (never throws).
 */
export async function readLinuxWindowState(
  runner: ExecRunner,
  leaseId: string,
  windowId?: string,
): Promise<LinuxWindowState> {
  // NOTE: this function must never activate the target window — stealing
  // focus would violate the no-intrusion core promise of the accessibility
  // tree path. xdotool can read metadata of *any* window by id, so the
  // leased window is addressed directly below; only when no window id is
  // known do we fall back to the currently active window's metadata (no
  // activation involved).

  // 1. Capture a screenshot.
  let screenshotBase64 = '';
  let screenshotTaken = false;
  try {
    await runner.exec(`scrot -z /tmp/cua_${leaseId}.png`);
    screenshotTaken = true;
  } catch {
    try {
      await runner.exec(`import -window root /tmp/cua_${leaseId}.png`);
      screenshotTaken = true;
    } catch {
      /* both failed */
    }
  }
  if (screenshotTaken) {
    try {
      const b64Result = await runner.exec(`base64 -w0 /tmp/cua_${leaseId}.png`);
      screenshotBase64 = b64Result.stdout.trim();
    } catch {
      /* encoding failed */
    }
    await runner.exec(`rm -f /tmp/cua_${leaseId}.png`).catch(() => {});
  }

  // 2. Window title and geometry — read the leased window *by id* (no
  // activation). Without a window id, fall back to the currently active
  // window's metadata; both degrade to defaults on failure.
  let windowTitle = '';
  let windowWidth = 1920;
  let windowHeight = 1080;
  const titleCommand = windowId
    ? `xdotool getwindowname ${windowId}`
    : 'xdotool getactivewindow getwindowname';
  const geoCommand = windowId
    ? `xdotool getwindowgeometry --shell ${windowId}`
    : 'xdotool getactivewindow getwindowgeometry --shell';
  try {
    const titleResult = await runner.exec(titleCommand);
    windowTitle = truncateStdout(titleResult.stdout.trim());
  } catch {
    /* Non-critical */
  }

  try {
    const geoResult = await runner.exec(geoCommand);
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
  } catch {
    /* Use defaults */
  }

  // 3. Full display geometry.
  let screenWidth = windowWidth;
  let screenHeight = windowHeight;
  try {
    const displayGeo = await runner.exec('xdotool getdisplaygeometry');
    const parts = displayGeo.stdout.trim().split(/\s+/);
    if (parts.length >= 2) {
      screenWidth = parseInt(parts[0], 10) || screenWidth;
      screenHeight = parseInt(parts[1], 10) || screenHeight;
    }
  } catch {
    /* fallback */
  }

  // 4. Accessibility tree (AT-SPI2). Best-effort: derive the window owner PID
  // from the lease's windowId for app matching; when that fails the python
  // script falls back to the focused window. Returns [] when AT-SPI is
  // unavailable, degrading to coordinate-only interaction.
  let appTarget: string | number | undefined;
  if (windowId) {
    try {
      const pidResult = await runner.exec(`xdotool getwindowpid ${windowId}`);
      const parsedPid = parseInt(pidResult.stdout.trim(), 10);
      if (!isNaN(parsedPid)) appTarget = parsedPid;
    } catch {
      /* Non-critical */
    }
  }
  const elements = await readLinuxAccessibilityTree(runner, appTarget);

  return {
    screenshotBase64,
    windowTitle,
    width: windowWidth,
    height: windowHeight,
    screenWidth,
    screenHeight,
    elements,
  };
}

// ---------------------------------------------------------------------------
// Python (pyatspi) scripts
// ---------------------------------------------------------------------------
//
// Each script is wrapped in shell single quotes by the caller, so the python
// code must not contain single quotes; inner strings use double quotes.
// All failures are reported as {"ok":false,"error":...} JSON on stdout —
// never a non-zero exit / traceback the caller has to interpret.

/**
 * Shared preamble: recover DBUS_SESSION_BUS_ADDRESS (SSH sessions have none)
 * and connect to the AT-SPI bus. `_find_node` walks a DFS index path like
 * "/0/2/5" from the desktop root.
 */
const PY_COMMON = `
import os, sys, json

def _dbus_env():
    d = os.environ.get("DBUS_SESSION_BUS_ADDRESS")
    if d:
        return d
    try:
        out = os.popen("ps aux").read()
    except Exception:
        return None
    for line in out.splitlines():
        if "at-spi-bus-launcher" in line or ("dbus-daemon" in line and "--session" in line):
            parts = line.split()
            if len(parts) < 2:
                continue
            pid = parts[1]
            try:
                data = open("/proc/" + pid + "/environ", "rb").read()
            except Exception:
                continue
            for part in data.split(b"\\0"):
                if part.startswith(b"DBUS_SESSION_BUS_ADDRESS="):
                    return part.split(b"=", 1)[1].decode()
    return None

def _setup():
    d = _dbus_env()
    if d is None:
        return (None, None, "NO_DBUS")
    os.environ["DBUS_SESSION_BUS_ADDRESS"] = d
    try:
        import pyatspi
    except Exception:
        return (None, None, "PYATSPI_MISSING")
    try:
        desktop = pyatspi.Registry.getDesktop(0)
    except Exception:
        return (None, None, "DBUS_FAIL")
    return (pyatspi, desktop, None)

def _find_node(desktop, path):
    parts = path.split("/")[1:]
    cur = desktop
    for part in parts:
        try:
            cur = cur.get_child_at_index(int(part))
        except Exception:
            return None
        if cur is None:
            return None
    return cur
`.trim();

/**
 * Read the accessibility tree of the target application: match by pid or
 * process name (argv[1]), fall back to the focused application, then to the
 * first application on the desktop. Emits interactive nodes only
 * (depth <= 12, at most 300 elements, 2000 visited nodes), each with its DFS
 * index path relative to the desktop root.
 */
const PY_READ_SCRIPT = `
${PY_COMMON}

def _apps(desktop):
    out = []
    try:
        n = desktop.get_child_count()
    except Exception:
        return out
    for i in range(n):
        try:
            out.append((i, desktop.get_child_at_index(i)))
        except Exception:
            continue
    return out

def _app_pid(app):
    try:
        v = app.get_process_id()
        if v is not None:
            return v
    except Exception:
        pass
    try:
        a = app.get_application()
        if a is None:
            return None
        try:
            return a.get_process_id()
        except Exception:
            return None
    except Exception:
        return None

def _pick_app(apps, arg):
    want = str(arg)
    if want.isdigit():
        pid = int(want)
        for idx, app in apps:
            try:
                if _app_pid(app) == pid:
                    return (idx, app)
            except Exception:
                continue
        return None
    low = want.lower()
    for idx, app in apps:
        try:
            name = (app.get_name() or "").lower()
        except Exception:
            continue
        if name == low:
            return (idx, app)
    for idx, app in apps:
        try:
            name = (app.get_name() or "").lower()
        except Exception:
            continue
        if name and low in name:
            return (idx, app)
    return None

def _focused_app(apps, pyatspi):
    try:
        focused = pyatspi.Registry.getFocused()
    except Exception:
        return None
    if focused is None:
        return None
    cur = focused
    last = None
    for _ in range(64):
        p = None
        try:
            p = cur.parent
        except Exception:
            p = None
        if p is None:
            try:
                p = cur.get_parent()
            except Exception:
                p = None
        if p is None:
            break
        last = cur
        cur = p
    if last is None:
        return None
    try:
        fname = (last.get_name() or "").lower()
    except Exception:
        return None
    for idx, app in apps:
        try:
            if (app.get_name() or "").lower() == fname:
                return (idx, app)
        except Exception:
            continue
    return None

INTERACTIVE = set([
    "push button", "check box", "radio button", "combo box",
    "text entry", "list item", "tab", "page tab", "menu item",
    "slider", "spin button", "tree table cell",
    "scroll bar", "text", "password text",
])

def _is_interactive(obj, pyatspi):
    try:
        if obj.get_state().contains(pyatspi.STATE_FOCUSABLE):
            return True
    except Exception:
        pass
    try:
        acts = obj.get_actions()
        if acts is not None and acts.length > 0:
            return True
    except Exception:
        pass
    try:
        return obj.get_role_name() in INTERACTIVE
    except Exception:
        return False

def _element(obj, path, pyatspi):
    try:
        role = obj.get_role_name()
    except Exception:
        role = ""
    try:
        name = obj.get_name() or ""
    except Exception:
        name = ""
    try:
        desc = obj.get_description() or ""
    except Exception:
        desc = ""
    anames = []
    try:
        acts = obj.get_actions()
        for j in range(acts.length):
            try:
                anames.append(acts.get_name(j))
            except Exception:
                continue
    except Exception:
        pass
    ext = None
    try:
        ext = obj.get_component().get_extents(pyatspi.XY_SCREEN)
    except Exception:
        pass
    if ext is None or len(ext) < 4:
        return None
    x, y, w, h = ext[0], ext[1], ext[2], ext[3]
    if w <= 0 or h <= 0:
        return None
    try:
        enabled = obj.get_state().contains(pyatspi.STATE_ENABLED)
    except Exception:
        enabled = True
    return {
        "path": path,
        "role": role,
        "label": name,
        "description": desc,
        "actions": anames,
        "bounds": {"x": int(x), "y": int(y), "width": int(w), "height": int(h)},
        "enabled": enabled,
    }

MAX_DEPTH = 12
MAX_ELEMENTS = 300
MAX_VISITS = 2000

def _walk(obj, depth, path, out, state, pyatspi):
    if state[1]:
        return
    if depth > MAX_DEPTH:
        return
    if state[0] >= MAX_VISITS:
        state[1] = True
        return
    try:
        n = obj.get_child_count()
    except Exception:
        n = 0
    for i in range(n):
        if state[1] or len(out) >= MAX_ELEMENTS:
            state[1] = True
            return
        try:
            child = obj.get_child_at_index(i)
        except Exception:
            continue
        if child is None:
            continue
        cpath = path + "/" + str(i)
        state[0] += 1
        try:
            if _is_interactive(child, pyatspi):
                el = _element(child, cpath, pyatspi)
                if el is not None:
                    out.append(el)
        except Exception:
            pass
        _walk(child, depth + 1, cpath, out, state, pyatspi)

def _main():
    arg = None
    if len(sys.argv) > 1:
        arg = sys.argv[1]
    pyatspi, desktop, err = _setup()
    if err is not None:
        print(json.dumps({"ok": False, "error": err}))
        return
    apps = _apps(desktop)
    target = None
    if arg is not None:
        target = _pick_app(apps, arg)
    if target is None:
        target = _focused_app(apps, pyatspi)
    if target is None and len(apps) > 0:
        target = (apps[0][0], apps[0][1])
    if target is None:
        print(json.dumps({"ok": False, "error": "NO_APP"}))
        return
    idx, app = target
    out = []
    state = [1, False]
    _walk(app, 1, "/" + str(idx), out, state, pyatspi)
    print(json.dumps({"ok": True, "elements": out, "truncated": state[1]}))

_main()
`.trim();

/**
 * Activate an element by path: re-walk the tree, then invoke the role
 * appropriate action (toggle/press for check boxes, otherwise click, press
 * or activate — first match wins).
 */
const PY_CLICK_SCRIPT = `
${PY_COMMON}

def _pick_action(role, actions, n):
    names = []
    for j in range(n):
        try:
            names.append(actions.get_name(j).lower())
        except Exception:
            continue
    if role == "check box":
        for name in names:
            if "toggle" in name:
                return name
        if "press" in names:
            return "press"
        return None
    for name in ("click", "press", "activate"):
        if name in names:
            return name
    return None

def _main():
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "NO_PATH"}))
        return
    path = sys.argv[1]
    pyatspi, desktop, err = _setup()
    if err is not None:
        print(json.dumps({"ok": False, "error": err}))
        return
    node = _find_node(desktop, path)
    if node is None:
        print(json.dumps({"ok": False, "error": "STALE"}))
        return
    try:
        actions = node.get_actions()
        n = actions.length
    except Exception:
        actions = None
        n = 0
    if actions is None or n <= 0:
        print(json.dumps({"ok": False, "error": "NO_ACTION"}))
        return
    try:
        role = node.get_role_name()
    except Exception:
        role = ""
    picked = _pick_action(role, actions, n)
    if picked is None:
        print(json.dumps({"ok": False, "error": "NO_ACTION"}))
        return
    try:
        done = False
        for j in range(n):
            if actions.get_name(j).lower() == picked:
                done = actions.do_action(j)
                break
        if done:
            print(json.dumps({"ok": True}))
        else:
            print(json.dumps({"ok": False, "error": "DO_ACTION_FAILED"}))
    except Exception:
        print(json.dumps({"ok": False, "error": "DO_ACTION_FAILED"}))

_main()
`.trim();

/**
 * Replace the whole content of a text field via the EditableText interface.
 * Nodes without EditableText report NO_EDITABLE_TEXT so the caller can fall
 * back to keyboard typing.
 */
const PY_TYPE_SCRIPT = `
${PY_COMMON}

def _main():
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "NO_PATH"}))
        return
    if len(sys.argv) < 3:
        print(json.dumps({"ok": False, "error": "NO_TEXT"}))
        return
    path = sys.argv[1]
    text = sys.argv[2]
    pyatspi, desktop, err = _setup()
    if err is not None:
        print(json.dumps({"ok": False, "error": err}))
        return
    node = _find_node(desktop, path)
    if node is None:
        print(json.dumps({"ok": False, "error": "STALE"}))
        return
    try:
        editable = node.get_editable_text()
    except Exception:
        print(json.dumps({"ok": False, "error": "NO_EDITABLE_TEXT"}))
        return
    try:
        editable.set_text_contents(text)
        print(json.dumps({"ok": True}))
    except Exception:
        print(json.dumps({"ok": False, "error": "SET_TEXT_FAILED"}))

_main()
`.trim();

/**
 * Scroll an element into view (scrollTo) or, for scroll-bar nodes, move the
 * scroll-bar value in the requested direction. Any failure is reported so
 * the caller can fall back to xdotool wheel clicks.
 */
const PY_SCROLL_SCRIPT = `
${PY_COMMON}

def _main():
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "NO_PATH"}))
        return
    path = sys.argv[1]
    direction = "down"
    amount = 1
    if len(sys.argv) > 2:
        direction = sys.argv[2]
    if len(sys.argv) > 3:
        try:
            amount = max(int(sys.argv[3]), 1)
        except Exception:
            amount = 1
    pyatspi, desktop, err = _setup()
    if err is not None:
        print(json.dumps({"ok": False, "error": err}))
        return
    node = _find_node(desktop, path)
    if node is None:
        print(json.dumps({"ok": False, "error": "STALE"}))
        return
    try:
        role = node.get_role_name()
    except Exception:
        role = ""
    if role == "scroll bar":
        try:
            value = node.get_value()
            lo = value.get_minimum_value()
            hi = value.get_maximum_value()
            cur = value.get_current_value()
            step = (hi - lo) / 10.0
            if step < 1.0:
                step = 1.0
            if direction == "up" or direction == "left":
                new = cur - step * amount
            else:
                new = cur + step * amount
            if new < lo:
                new = lo
            if new > hi:
                new = hi
            value.set_current_value(new)
            print(json.dumps({"ok": True}))
        except Exception:
            print(json.dumps({"ok": False, "error": "SCROLL_FAILED"}))
        return
    try:
        st = None
        for name in ("SCROLL_TYPE_ANY", "SCROLL_TYPE_ANYWHERE"):
            try:
                st = getattr(pyatspi, name)
                break
            except Exception:
                continue
        if st is None:
            print(json.dumps({"ok": False, "error": "NO_SCROLL_TYPE"}))
            return
        done = node.get_component().scroll_to(st)
        if done:
            print(json.dumps({"ok": True}))
        else:
            print(json.dumps({"ok": False, "error": "SCROLL_FAILED"}))
    except Exception:
        print(json.dumps({"ok": False, "error": "SCROLL_FAILED"}))

_main()
`.trim();

// ---------------------------------------------------------------------------
// Tree parsing
// ---------------------------------------------------------------------------

/**
 * Map verbose pyatspi role names to the concise roles used in UIElement.
 * Unmapped roles pass through unchanged.
 */
const LINUX_ROLE_MAP: Record<string, string> = {
  'push button': 'button',
  'text entry': 'textbox',
  'check box': 'checkbox',
  'combo box': 'combobox',
  'radio button': 'radiobutton',
  'page tab': 'tabitem',
  'menu item': 'menuitem',
  'spin button': 'spinbutton',
  'tree table cell': 'cell',
  label: 'text',
};

interface RawTreeElement {
  path?: unknown;
  role?: unknown;
  label?: unknown;
  description?: unknown;
  actions?: unknown;
  bounds?: unknown;
  enabled?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function mapTreeElement(raw: RawTreeElement): UIElement | null {
  if (typeof raw.path !== 'string' || typeof raw.role !== 'string') return null;
  const bounds = isRecord(raw.bounds) ? raw.bounds : {};
  const num = (v: unknown): number => (typeof v === 'number' && isFinite(v) ? v : 0);
  const actions = Array.isArray(raw.actions)
    ? raw.actions.filter((a): a is string => typeof a === 'string')
    : undefined;
  return {
    elementId: raw.path,
    role: LINUX_ROLE_MAP[raw.role] ?? raw.role,
    label: typeof raw.label === 'string' && raw.label ? raw.label : undefined,
    description:
      typeof raw.description === 'string' && raw.description ? raw.description : undefined,
    bounds: {
      x: num(bounds.x),
      y: num(bounds.y),
      width: num(bounds.width),
      height: num(bounds.height),
    },
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true,
    ...(actions && actions.length > 0 ? { actions } : {}),
  };
}

/**
 * Read the AT-SPI2 accessibility tree from the remote host.
 *
 * `appNameOrPid` optionally narrows the tree to one application (process name
 * or numeric pid). Without it the python script uses the focused window's
 * application, then the first application on the desktop.
 *
 * Returns [] (never throws) when pyatspi is not installed, the session has no
 * accessible bus, or the script output is not JSON.
 */
export async function readLinuxAccessibilityTree(
  runner: ExecRunner,
  appNameOrPid?: string | number,
): Promise<UIElement[]> {
  let command = `python3 -c '${PY_READ_SCRIPT}'`;
  if (appNameOrPid !== undefined && appNameOrPid !== '') {
    command += ` ${quoteShellArg(String(appNameOrPid))}`;
  }
  try {
    const result = await runner.exec(command, { timeoutMs: 15_000 });
    const text = result.stdout.trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return []; // Non-JSON output (e.g. legacy pyatspi probe) — empty tree.
    }
    if (!isRecord(parsed) || parsed.ok === false) return [];
    const rawElements = parsed.elements;
    if (!Array.isArray(rawElements)) return [];
    const elements: UIElement[] = [];
    for (const raw of rawElements) {
      if (!isRecord(raw)) continue;
      const el = mapTreeElement(raw as RawTreeElement);
      if (el) elements.push(el);
    }
    return elements;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

interface PythonActionResult {
  ok: boolean;
  error?: string;
}

/**
 * Run a python action script with the given argv. All arguments are
 * single-quote shell escaped, so user-controlled text cannot break out of
 * the command. Failures are returned as {ok:false,error} — never thrown.
 */
async function runPythonAction(
  runner: ExecRunner,
  script: string,
  args: string[],
): Promise<PythonActionResult> {
  const argv = args.map(quoteShellArg).join(' ');
  const command = `python3 -c '${script}'${argv ? ` ${argv}` : ''}`;
  let result;
  try {
    result = await runner.exec(command, { timeoutMs: 15_000 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `python script failed: ${message}` };
  }
  const text = result.stdout.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      ok: false,
      error: `python script returned invalid JSON: ${truncateStdout(text) || '(empty)'}`,
    };
  }
  if (!isRecord(parsed)) {
    return { ok: false, error: 'python script returned invalid output' };
  }
  return {
    ok: parsed.ok === true,
    error: typeof parsed.error === 'string' ? parsed.error : undefined,
  };
}

/**
 * Execute a computer-use action on the remote Linux desktop.
 *
 * Accessibility-tree actions (element path based, no mouse movement) are the
 * primary path; xdotool coordinate injection is the fallback for apps without
 * a tree and for press_key (AT-SPI has no input-injection API — only
 * component/action interfaces, no key synthesis).
 */
export async function performLinuxAction(
  runner: ExecRunner,
  action: Action,
): Promise<ActionResult> {
  let command: string;

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
      if (typeof elementId === 'string' && ATSPI_PATH_RE.test(elementId)) {
        // Tree element — activate it via AT-SPI (no mouse movement).
        const r = await runPythonAction(runner, PY_CLICK_SCRIPT, [elementId]);
        if (r.ok) return { ok: true, action: action.type };
        return {
          ok: false,
          action: action.type,
          error: r.error ?? 'AT-SPI click failed',
        };
      }
      // Non-tree element id — coordinate fallback.
      logDegraded('click_element: element id has no AT-SPI path; using xdotool coordinate click');
      const b = action.snapshotElement.bounds;
      const cx = Math.round(b.x + b.width / 2);
      const cy = Math.round(b.y + b.height / 2);
      command = `xdotool mousemove ${cx} ${cy} click 1`;
      break;
    }

    case 'click_point': {
      const px = action.x ?? 0;
      const py = action.y ?? 0;
      command = `xdotool mousemove ${px} ${py} click 1`;
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
      // Cap oversized payloads (SSH command-line sanity limit).
      const text =
        action.text.length > MAX_TEXT_LENGTH ? action.text.slice(0, MAX_TEXT_LENGTH) : action.text;
      const el = action.snapshotElement;
      const elementId = el?.elementId;
      const role = el?.role;
      // EditableText only exists on real input fields; static 'text' (label)
      // elements must not go down this path — they cannot hold a value.
      if (
        typeof elementId === 'string' &&
        ATSPI_PATH_RE.test(elementId) &&
        (role === 'textbox' || role === 'password text')
      ) {
        // Tree text field — replace contents via EditableText.
        const r = await runPythonAction(runner, PY_TYPE_SCRIPT, [elementId, text]);
        if (r.ok) return { ok: true, action: action.type };
        if (r.error === 'NO_EDITABLE_TEXT') {
          logDegraded('type_text: element lacks EditableText interface; using xdotool typing');
          // No EditableText interface — fall through to keyboard typing.
        } else {
          return {
            ok: false,
            action: action.type,
            error: r.error ?? 'AT-SPI type failed',
          };
        }
      } else {
        logDegraded(
          `type_text: element role '${role ?? 'none'}' is not a text field; using xdotool typing`,
        );
      }
      const escaped = escapeShellText(text);
      command = `xdotool type --delay 50 "${escaped}"`;
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
      if (!isValidKey(action.key)) {
        return {
          ok: false,
          action: action.type,
          error: `Invalid key: '${action.key}'`,
        };
      }
      // AT-SPI2 has no key-synthesis API — xdotool key remains the only path.
      logDegraded('press_key: AT-SPI has no key-synthesis API; using xdotool key');
      command = `xdotool key "${action.key}"`;
      break;
    }

    case 'scroll': {
      const direction = action.direction ?? 'down';
      const amount = action.amount ?? 1;
      const buttonMap: Record<string, number> = {
        up: 4,
        down: 5,
        left: 6,
        right: 7,
      };
      const button = buttonMap[direction] ?? 5;
      const elementId = action.snapshotElement?.elementId;
      if (typeof elementId === 'string' && ATSPI_PATH_RE.test(elementId)) {
        // Tree element — scroll via AT-SPI, fall back to wheel clicks below.
        const r = await runPythonAction(runner, PY_SCROLL_SCRIPT, [
          elementId,
          direction,
          String(amount),
        ]);
        if (r.ok) return { ok: true, action: action.type };
      }
      logDegraded('scroll: no AT-SPI scrollable; using xdotool wheel clicks');
      command = `xdotool click ${button} --repeat ${amount}`;
      break;
    }

    case 'double_click': {
      logDegraded(
        'double_click: no AT-SPI double-click API; using xdotool coordinate double click',
      );
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

  try {
    await runner.exec(command);
    return { ok: true, action: action.type };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, action: action.type, error: message };
  }
}
