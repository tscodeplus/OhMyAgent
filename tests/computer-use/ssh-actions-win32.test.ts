import { describe, it, expect, vi } from 'vitest';
import {
  readWin32WindowState,
  performWin32Action,
  parseWin32WindowId,
} from '../../src/computer-use/ssh-actions-win32.js';
import {
  buildWinUiaOnceScript,
  buildWinUiaOnceRunCommand,
  buildWinUiaOnceWriteCommands,
} from '../../src/computer-use/win-uia/win-uia-scripts.js';
import type { SSHPool } from '../../src/computer-use/transports/ssh-pool.js';
import type { UIElement } from '../../src/computer-use/types.js';

// ---------------------------------------------------------------------------
// Helpers (createMockSSHPool pattern, mirror of ssh-actions-linux.test.ts)
// ---------------------------------------------------------------------------

type Response = { stdout: string; stderr: string; exitCode: number };

function createMockSSHPool(responses: Record<string, Response>) {
  const execFn = vi.fn().mockImplementation(async (cmd: string) => {
    for (const [pattern, response] of Object.entries(responses)) {
      if (cmd.includes(pattern)) return response;
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  });
  const pool = {
    exec: execFn,
    healthCheck: vi.fn().mockResolvedValue({
      reachable: true,
      deps: { xdotool: true, scrot: true },
    }),
    destroy: vi.fn(),
  };
  return { pool: pool as unknown as SSHPool, execMock: execFn };
}

/** Decode the base64 chunks written by buildWinUiaOnceWriteCommands. */
function decodeWrittenScripts(calls: ReadonlyArray<readonly unknown[]>): string {
  const all = calls.map((call) => call[0] as string).join('\n');
  const b64s = [...all.matchAll(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/g)].map((m) => m[1]);
  return b64s.map((b) => Buffer.from(b, 'base64').toString('utf8')).join('');
}

function snapshotElement(overrides: Partial<UIElement> = {}): UIElement {
  return {
    elementId: 'win-12345:1:5',
    role: 'button',
    label: 'OK',
    bounds: { x: 100, y: 200, width: 80, height: 30 },
    enabled: true,
    ...overrides,
  };
}

const STATE_JSON = JSON.stringify({
  ok: true,
  result: {
    hwnd: 12345,
    gen: 1,
    windowTitle: 'Notepad',
    windowRect: { x: 0, y: 0, width: 1024, height: 768 },
    display: { width: 1920, height: 1080 },
    elements: [
      {
        elementId: 'win-12345:1:0',
        role: 'button',
        label: 'OK',
        bounds: { x: 10, y: 20, width: 30, height: 40 },
        enabled: true,
        focused: false,
        sensitive: false,
        actions: ['Invoke'],
      },
      {
        elementId: 'win-12345:1:1',
        role: 'textbox',
        label: 'Name',
        bounds: { x: 1, y: 2, width: 3, height: 4 },
        enabled: false,
        focused: true,
        sensitive: false,
        actions: ['Value'],
      },
    ],
    screenshot: 'iVBORw0KGgo',
    truncated: false,
  },
});

// ---------------------------------------------------------------------------
// One-shot script template
// ---------------------------------------------------------------------------

describe('buildWinUiaOnceScript (stateless UIA)', () => {
  it('is pure ASCII with no handshake marker and no command loop', () => {
    const script = buildWinUiaOnceScript('get-app-state', { screenshot: true });
    expect(script).toMatch(/^[\x00-\x7F]*$/);
    expect(script).not.toContain('CUAREADY');
    expect(script).not.toContain('while ($true)');
    expect(script).toContain('[Console]::OutputEncoding');
    expect(script).toContain("OE 'SERVER_ERROR' $_.Exception.Message");
  });

  it('emits a single JSON line protocol (OK / OE with error code+message)', () => {
    const script = buildWinUiaOnceScript('click-element', { elementId: 'win-12345:1:5' });
    expect(script).toContain('function OK($r) { OJ @{ok=$true;result=$r} }');
    expect(script).toContain(
      'function OE($code,$msg) { OJ @{ok=$false;error=@{code=$code;message=$msg}} }',
    );
  });

  it('loads UIA patterns and locates elements by DFS index (ElByIdx)', () => {
    const script = buildWinUiaOnceScript('click-element', { elementId: 'win-12345:1:5' });
    expect(script).toContain('InvokePattern');
    expect(script).toContain('ValuePattern');
    expect(script).toContain('ScrollPattern');
    expect(script).toContain('ElByIdx');
    // elementId payload embedded verbatim (sanitized digits/colons only)
    expect(script).toContain("elementId='win-12345:1:5'");
  });

  it('semantic branches never inject input (no SetCursorPos/mouse_event/SendKeys/Clipboard)', () => {
    // press-key is excluded: its SendKeys fallback (for apps whose UIA
    // elements have no native hwnd, e.g. Chrome/Edge) is asserted separately.
    for (const cmd of ['get-app-state', 'click-element', 'type-text', 'scroll']) {
      const script = buildWinUiaOnceScript(cmd as never, {
        elementId: 'win-1:1:0',
        key: 'Return',
        text: 'x',
      });
      expect(script, cmd).not.toContain('SetCursorPos');
      expect(script, cmd).not.toContain('mouse_event');
      expect(script, cmd).not.toContain('SendKeys');
      expect(script, cmd).not.toContain('Clipboard');
      expect(script, cmd).not.toContain('SendInput');
    }
  });

  it('click-point uses the PostMessage chain — never SetCursorPos/mouse_event', () => {
    const script = buildWinUiaOnceScript('click-point', { x: 100, y: 200 });
    expect(script).not.toContain('SetCursorPos');
    expect(script).not.toContain('mouse_event');
    expect(script).toContain('ChildWindowFromPointEx');
    expect(script).toContain('0x08000000'); // WS_EX_NOACTIVATE guard
    expect(script).toContain('PostClick $hwnd $R.x $R.y 1');
    expect(script).toContain('x=100');
    expect(script).toContain('y=200');
  });

  it('double-click posts a two-press PostMessage chain (WM_LBUTTONDBLCLK)', () => {
    const script = buildWinUiaOnceScript('double-click', { x: 100, y: 200 });
    expect(script).not.toContain('SetCursorPos');
    expect(script).not.toContain('mouse_event');
    expect(script).toContain('PostClick $hwnd $R.x $R.y 2');
    expect(script).toContain('0x0203'); // WM_LBUTTONDBLCLK
  });

  it('press-key uses PostMessage to the window (no foreground requirement)', () => {
    const script = buildWinUiaOnceScript('press-key', { key: 'Return', hwnd: 4340 });
    expect(script).toContain('PostMessage');
    expect(script).toContain('hwnd=4340');
  });

  it('type-text embeds the text as base64 and sets ValuePattern', () => {
    const script = buildWinUiaOnceScript('type-text', { elementId: 'win-12345:1:1', text: 'hi' });
    expect(script).toContain('[Convert]::FromBase64String');
    expect(script).toContain('GetCurrentPattern($pv).SetValue($text)');
    expect(script).toContain(`textB64='${Buffer.from('hi', 'utf8').toString('base64')}'`);
  });

  it('rejects unsafe payload values', () => {
    expect(() => buildWinUiaOnceScript('click-element', { elementId: 'evil' } as never)).toThrow();
    expect(() => buildWinUiaOnceScript('press-key', { key: 'a b' })).toThrow();
    expect(() => buildWinUiaOnceScript('click-point', { x: 'NaN' } as never)).toThrow();
    expect(() => buildWinUiaOnceScript('unknown-cmd' as never, {})).toThrow();
  });
});

describe('one-shot script execution (two-stage write + run)', () => {
  it('write commands are chunked base64 and the run command executes the fixed temp path', () => {
    const script = buildWinUiaOnceScript('get-app-state', { screenshot: true });
    const writes = buildWinUiaOnceWriteCommands(script);
    expect(writes.length).toBeGreaterThanOrEqual(1);
    expect(writes[0]).toContain('WriteAllText');
    expect(writes[0]).toContain('win-uia-once.ps1');
    for (const w of writes) {
      // every command stays far below the cmd.exe 8191-char limit
      expect(w.length).toBeLessThan(8191);
    }
    const run = buildWinUiaOnceRunCommand();
    expect(run).toContain('-ExecutionPolicy Bypass');
    expect(run).toContain('win-uia-once.ps1');
    // round-trip: the written bytes decode back to the exact script
    const decoded = decodeWrittenScripts(writes.map((w) => [w] as unknown[]));
    expect(decoded).toBe(script);
  });
});

// ---------------------------------------------------------------------------
// readWin32WindowState
// ---------------------------------------------------------------------------

describe('readWin32WindowState', () => {
  it('parses the UIA tree JSON, window info and screenshot', async () => {
    const { pool, execMock } = createMockSSHPool({
      AppendAllText: { stdout: '', stderr: '', exitCode: 0 },
      WriteAllText: { stdout: '', stderr: '', exitCode: 0 },
      'win-uia-once.ps1': { stdout: STATE_JSON, stderr: '', exitCode: 0 },
    });

    const state = await readWin32WindowState(pool, 'lease-1', '0x3039'); // 0x3039 = 12345

    expect(state.windowTitle).toBe('Notepad');
    expect(state.width).toBe(1024);
    expect(state.height).toBe(768);
    expect(state.screenWidth).toBe(1920);
    expect(state.screenHeight).toBe(1080);
    expect(state.screenshotBase64).toBe('iVBORw0KGgo');
    expect(state.elements).toHaveLength(2);
    expect(state.elements[0]).toEqual({
      elementId: 'win-12345:1:0',
      role: 'button',
      label: 'OK',
      bounds: { x: 10, y: 20, width: 30, height: 40 },
      enabled: true,
      focused: false,
      sensitive: false,
      actions: ['Invoke'],
    });
    expect(state.elements[1].role).toBe('textbox');

    // The run command must carry the leased hwnd (parsed from the windowId).
    const written = decodeWrittenScripts(execMock.mock.calls);
    expect(written).toContain("cmd='get-app-state'");
    expect(written).toContain('hwnd=12345');
  });

  it('falls back to the foreground window when no windowId is given', async () => {
    const { pool, execMock } = createMockSSHPool({
      AppendAllText: { stdout: '', stderr: '', exitCode: 0 },
      WriteAllText: { stdout: '', stderr: '', exitCode: 0 },
      'win-uia-once.ps1': { stdout: STATE_JSON, stderr: '', exitCode: 0 },
    });

    await readWin32WindowState(pool, 'lease-1');
    const written = decodeWrittenScripts(execMock.mock.calls);
    expect(written).toContain('hwnd=0'); // script resolves GetForegroundWindow
  });

  it('degrades to defaults when the UIA script fails', async () => {
    const { pool } = createMockSSHPool({
      AppendAllText: { stdout: '', stderr: '', exitCode: 0 },
      WriteAllText: { stdout: '', stderr: '', exitCode: 0 },
      'win-uia-once.ps1': {
        stdout: '{"ok":false,"error":{"code":"SERVER_ERROR","message":"boom"}}',
        stderr: '',
        exitCode: 0,
      },
    });

    const state = await readWin32WindowState(pool, 'lease-1');
    expect(state.elements).toEqual([]);
    expect(state.windowTitle).toBe('');
  });
});

// ---------------------------------------------------------------------------
// performWin32Action
// ---------------------------------------------------------------------------

describe('performWin32Action (UIA stateless)', () => {
  const okRun: Response = { stdout: '{"ok":true,"result":{}}', stderr: '', exitCode: 0 };

  it('click_element with a UIA element id runs the click-element branch (no coordinates)', async () => {
    const { pool, execMock } = createMockSSHPool({
      AppendAllText: { stdout: '', stderr: '', exitCode: 0 },
      WriteAllText: { stdout: '', stderr: '', exitCode: 0 },
      'win-uia-once.ps1': okRun,
    });

    const result = await performWin32Action(pool, {
      type: 'click_element',
      snapshotElement: snapshotElement(),
    });

    expect(result).toEqual({ ok: true, action: 'click_element' });
    const written = decodeWrittenScripts(execMock.mock.calls);
    expect(written).toContain("cmd='click-element'");
    expect(written).toContain("elementId='win-12345:1:5'"); // located by DFS index
    expect(written).toContain('ElByIdx');
    // The executed command lines (writes + run) never mention input injection.
    const raw = execMock.mock.calls.map((call: [string]) => call[0] as string).join('\n');
    expect(raw).not.toContain('SetCursorPos');
    expect(raw).not.toContain('mouse_event');
    expect(raw).not.toContain('Clipboard');
    expect(raw).not.toContain('SendKeys');
  });

  it('click_element maps ELEMENT_STALE_TREE to a readable error', async () => {
    const { pool } = createMockSSHPool({
      AppendAllText: { stdout: '', stderr: '', exitCode: 0 },
      WriteAllText: { stdout: '', stderr: '', exitCode: 0 },
      'win-uia-once.ps1': {
        stdout: '{"ok":false,"error":{"code":"ELEMENT_STALE_TREE","message":"Stale element"}}',
        stderr: '',
        exitCode: 0,
      },
    });

    const result = await performWin32Action(pool, {
      type: 'click_element',
      snapshotElement: snapshotElement(),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('stale accessibility tree');
  });

  it('click_element with a non-UIA element id falls back to coordinate click', async () => {
    const { pool, execMock } = createMockSSHPool({
      AppendAllText: { stdout: '', stderr: '', exitCode: 0 },
      WriteAllText: { stdout: '', stderr: '', exitCode: 0 },
      'win-uia-once.ps1': okRun,
    });

    const result = await performWin32Action(pool, {
      type: 'click_element',
      snapshotElement: snapshotElement({ elementId: 'el-1' }),
    });

    expect(result.ok).toBe(true);
    const written = decodeWrittenScripts(execMock.mock.calls);
    expect(written).toContain("cmd='click-point'");
    expect(written).toContain('x=140'); // bounds center
    expect(written).toContain('y=215');
  });

  it('type_text targets the snapshot element via ValuePattern (no clipboard)', async () => {
    const { pool, execMock } = createMockSSHPool({
      AppendAllText: { stdout: '', stderr: '', exitCode: 0 },
      WriteAllText: { stdout: '', stderr: '', exitCode: 0 },
      'win-uia-once.ps1': okRun,
    });

    const result = await performWin32Action(pool, {
      type: 'type_text',
      text: 'hello',
      snapshotElement: snapshotElement({ role: 'textbox' }),
    });

    expect(result).toEqual({ ok: true, action: 'type_text' });
    const written = decodeWrittenScripts(execMock.mock.calls);
    expect(written).toContain("cmd='type-text'");
    expect(written).toContain('GetCurrentPattern($pv).SetValue($text)');
    expect(written).not.toContain('Clipboard');
    expect(written).not.toContain('SendKeys');
  });

  it("type_text without an element targets the window's focused element (no top-level WM_SETTEXT)", async () => {
    const { pool, execMock } = createMockSSHPool({
      AppendAllText: { stdout: '', stderr: '', exitCode: 0 },
      WriteAllText: { stdout: '', stderr: '', exitCode: 0 },
      'win-uia-once.ps1': okRun,
    });

    const result = await performWin32Action(pool, { type: 'type_text', text: 'hi' }, '0x10f4');

    expect(result.ok).toBe(true);
    const written = decodeWrittenScripts(execMock.mock.calls);
    expect(written).toContain("cmd='type-text'");
    expect(written).toContain('hwnd=4340');
    expect(written).toContain('FocEl');
    expect(written).toContain('HasKeyboardFocus');
    // WM_SETTEXT is only allowed on the focused element's native window,
    // never on the top-level window (that would just rewrite the title).
    expect(written).toContain('SendMessage');
    expect(written).not.toContain('$ok=SM $hwnd $text');
  });

  it('press_key posts to the focused element, with a foreground-guarded SendKeys fallback', async () => {
    const { pool, execMock } = createMockSSHPool({
      AppendAllText: { stdout: '', stderr: '', exitCode: 0 },
      WriteAllText: { stdout: '', stderr: '', exitCode: 0 },
      'win-uia-once.ps1': okRun,
    });

    const result = await performWin32Action(pool, { type: 'press_key', key: 'Return' }, '0x10f4');

    expect(result).toEqual({ ok: true, action: 'press_key' });
    const written = decodeWrittenScripts(execMock.mock.calls);
    expect(written).toContain("cmd='press-key'");
    expect(written).toContain('hwnd=4340');
    expect(written).toContain('PostMessage');
    // SendKeys fallback is foreground-guarded so keys never land elsewhere,
    // refuses while the user is active, and restores the foreground after.
    expect(written).toContain('SendKeys');
    expect(written).toContain('SetForegroundWindow');
    expect(written).toContain('Could not foreground target window');
    expect(written).toContain("'USER_ACTIVE'");
    expect(written).toContain('RestoreFg $prevFg $hwnd');
  });

  it('emits userActiveMs only when explicitly provided (default lives in the script)', () => {
    const with0 = buildWinUiaOnceScript('press-key', { hwnd: 4340, key: 'Enter', userActiveMs: 0 });
    expect(with0).toContain('userActiveMs=0');
    const defaulted = buildWinUiaOnceScript('press-key', { hwnd: 4340, key: 'Enter' });
    expect(defaulted).not.toContain('userActiveMs=');
  });

  it('press_key rejects invalid keys', async () => {
    const { pool } = createMockSSHPool({});
    const result = await performWin32Action(pool, { type: 'press_key', key: 'Shift+X' });
    expect(result.ok).toBe(false);
  });

  it('scroll uses ScrollPattern with element + direction/amount payload', async () => {
    const { pool, execMock } = createMockSSHPool({
      AppendAllText: { stdout: '', stderr: '', exitCode: 0 },
      WriteAllText: { stdout: '', stderr: '', exitCode: 0 },
      'win-uia-once.ps1': okRun,
    });

    const result = await performWin32Action(pool, {
      type: 'scroll',
      direction: 'down',
      amount: 2,
      snapshotElement: snapshotElement({ elementId: 'win-12345:1:9' }),
    });

    expect(result).toEqual({ ok: true, action: 'scroll' });
    const written = decodeWrittenScripts(execMock.mock.calls);
    expect(written).toContain("cmd='scroll'");
    expect(written).toContain("elementId='win-12345:1:9'");
    expect(written).toContain("direction='down'");
    expect(written).toContain('amount=2');
    expect(written).toContain('ScrollPattern');
  });

  it('double_click maps to the UIA element click when an element is present', async () => {
    const { pool, execMock } = createMockSSHPool({
      AppendAllText: { stdout: '', stderr: '', exitCode: 0 },
      WriteAllText: { stdout: '', stderr: '', exitCode: 0 },
      'win-uia-once.ps1': okRun,
    });

    const result = await performWin32Action(pool, {
      type: 'double_click',
      snapshotElement: snapshotElement(),
    });

    expect(result.ok).toBe(true);
    const written = decodeWrittenScripts(execMock.mock.calls);
    expect(written).toContain("cmd='click-element'");
  });

  it('double_click without an element posts a single double-click chain command', async () => {
    const { pool, execMock } = createMockSSHPool({
      AppendAllText: { stdout: '', stderr: '', exitCode: 0 },
      WriteAllText: { stdout: '', stderr: '', exitCode: 0 },
      'win-uia-once.ps1': okRun,
    });

    const result = await performWin32Action(pool, {
      type: 'double_click',
      x: 300,
      y: 400,
    });

    expect(result.ok).toBe(true);
    const written = decodeWrittenScripts(execMock.mock.calls);
    expect(written).toContain("cmd='double-click'");
    expect(written).toContain('x=300');
    expect(written).toContain('y=400');
    expect(written).toContain('PostClick $hwnd $R.x $R.y 2');
  });

  it('returns an error for click_element without a snapshotElement', async () => {
    const { pool } = createMockSSHPool({});
    const result = await performWin32Action(pool, { type: 'click_element' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('No snapshotElement');
  });

  it('returns an error for type_text without text', async () => {
    const { pool } = createMockSSHPool({});
    const result = await performWin32Action(pool, { type: 'type_text' });
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseWin32WindowId
// ---------------------------------------------------------------------------

describe('parseWin32WindowId', () => {
  it('parses hex (0x…), decimal and negative 64-bit handles', () => {
    expect(parseWin32WindowId('0x3039')).toBe(12345);
    expect(parseWin32WindowId('12345')).toBe(12345);
    expect(parseWin32WindowId('-1404003184')).toBe(-1404003184);
  });

  it('returns 0 for unknown / pid-… / empty window ids', () => {
    expect(parseWin32WindowId(undefined)).toBe(0);
    expect(parseWin32WindowId('')).toBe(0);
    expect(parseWin32WindowId('pid-12345')).toBe(0);
    expect(parseWin32WindowId('0x0')).toBe(0);
    expect(parseWin32WindowId('not-a-handle')).toBe(0);
  });
});
