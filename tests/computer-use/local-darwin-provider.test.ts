import { describe, it, expect, vi } from 'vitest';
import { LocalDarwinProvider } from '../../src/computer-use/providers/local-darwin.js';
import type { ExecRunner, ExecResult } from '../../src/computer-use/ssh-actions-common.js';
import type { Ctx, Lease, UIElement } from '../../src/computer-use/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_CTX: Ctx = { sessionPath: '/test', agentId: 'test-agent' };

function createMockRunner(
  responses: Record<string, { stdout?: string; stderr?: string; error?: string }>,
): { runner: ExecRunner; commands: string[] } {
  const commands: string[] = [];
  const execFn = vi.fn().mockImplementation(async (cmd: string) => {
    commands.push(cmd);
    for (const [pattern, response] of Object.entries(responses)) {
      if (cmd.includes(pattern)) {
        if (response.error) throw new Error(response.error);
        const result: ExecResult = {
          stdout: response.stdout ?? '',
          stderr: response.stderr ?? '',
          exitCode: 0,
        };
        return result;
      }
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  });
  return {
    runner: { exec: execFn } as unknown as ExecRunner,
    commands,
  };
}

const TREE_STDOUT = JSON.stringify({
  ok: true,
  elements: [
    {
      path: '/0',
      role: 'AXButton',
      label: 'OK',
      actions: ['AXPress'],
      enabled: true,
      bounds: { x: 10, y: 20, width: 40, height: 20 },
    },
    {
      path: '/1',
      role: 'AXTextField',
      label: '',
      actions: ['AXConfirm'],
      enabled: true,
      bounds: { x: 0, y: 0, width: 100, height: 30 },
    },
  ],
});

const OK_STDOUT = JSON.stringify({ ok: true });

function makeLease(overrides?: Partial<Lease>): Lease {
  return {
    leaseId: 'lease-1',
    sessionPath: '/test',
    agentId: 'test-agent',
    providerId: 'darwin:local',
    appId: 'TextEdit',
    createdAt: new Date().toISOString(),
    status: 'active',
    allowedActions: [],
    providerState: { pid: 4242 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

describe('LocalDarwinProvider', () => {
  it('exposes semantic accessibility-first capabilities', () => {
    const provider = new LocalDarwinProvider({ runner: createMockRunner({}).runner });
    expect(provider.capabilities).toMatchObject({
      platform: 'darwin',
      elementActions: 'semantic',
      textInput: 'semantic',
      backgroundControl: 'partial',
      requiresForegroundForInput: false,
      accessibilityTree: true,
      screenshot: true,
    });
  });

  it('getStatus is available when the AX probe succeeds', async () => {
    const { runner } = createMockRunner({ ' probe': { stdout: '{"ok":true}' } });
    const provider = new LocalDarwinProvider({ runner });
    const status = await provider.getStatus(DEFAULT_CTX);
    expect(status.available).toBe(true);
    expect(status.permissions).toEqual([{ name: 'macos-accessibility', granted: true }]);
  });

  it('getStatus reports unavailable when the AX probe is denied (no Accessibility permission)', async () => {
    const { runner } = createMockRunner({ ' probe': { stdout: '{"ok":false}' } });
    const provider = new LocalDarwinProvider({ runner });
    const status = await provider.getStatus(DEFAULT_CTX);
    expect(status.available).toBe(false);
    expect(status.message).toContain('Accessibility');
  });

  it('listApps parses osascript visible-process output', async () => {
    const { runner } = createMockRunner({
      'get name of every process': { stdout: 'Finder, TextEdit, Safari' },
    });
    const provider = new LocalDarwinProvider({ runner });
    const apps = await provider.listApps(DEFAULT_CTX);
    expect(apps.map((a) => a.name)).toEqual(['Finder', 'TextEdit', 'Safari']);
  });

  it('createLease launches via `open -g -a` (no foreground steal) and resolves the pid by exact process name', async () => {
    const { runner, commands } = createMockRunner({
      'open -g -a': { stdout: '' },
      'whose name is "TextEdit"': { stdout: '4242' },
    });
    const provider = new LocalDarwinProvider({ runner });
    const lease = await provider.createLease(DEFAULT_CTX, { appName: 'TextEdit' });
    expect(lease.providerState).toEqual({ pid: 4242 });
    // -g = --background: the window appears but the app is not activated.
    // Flag order matters: `open -a -g` misparses `-g` as the `-a` app name.
    expect(commands.some((c) => c.startsWith("open -g -a 'TextEdit'"))).toBe(true);
    // Exact process-name match via System Events — pgrep -f would also match
    // helper processes whose paths contain the app name.
    expect(
      commands.some((c) => c.includes('unix id of first process whose name is "TextEdit"')),
    ).toBe(true);
    expect(commands.some((c) => c.includes('pgrep -f -i'))).toBe(false);
  });

  it('createLease falls back to pgrep -x when System Events is denied (no AX permission)', async () => {
    const { runner, commands } = createMockRunner({
      'open -g -a': { stdout: '' },
      'whose name is "TextEdit"': { error: 'kAXErrorAPIDisabled' },
      'pgrep -ix': { stdout: '4242' },
    });
    const provider = new LocalDarwinProvider({ runner });
    const lease = await provider.createLease(DEFAULT_CTX, { appName: 'TextEdit' });
    expect(lease.providerState).toEqual({ pid: 4242 });
    expect(commands.some((c) => c.includes("pgrep -ix 'TextEdit'"))).toBe(true);
  });

  it('createLease rejects unsafe app names', async () => {
    const provider = new LocalDarwinProvider({ runner: createMockRunner({}).runner });
    await expect(provider.createLease(DEFAULT_CTX, { appName: 'bad;rm -rf /' })).rejects.toThrow(
      'Invalid application name',
    );
  });

  it('createLease accepts app names with spaces (Microsoft Edge)', async () => {
    const { runner, commands } = createMockRunner({
      'open -g -a': { stdout: '' },
      'whose name is "Microsoft Edge"': { stdout: '4242' },
    });
    const provider = new LocalDarwinProvider({ runner });
    const lease = await provider.createLease(DEFAULT_CTX, { appName: 'Microsoft Edge' });
    expect(lease.providerState).toEqual({ pid: 4242 });
    expect(commands.some((c) => c.startsWith("open -g -a 'Microsoft Edge'"))).toBe(true);
  });

  it('getAppState parses the JXA tree into UI elements', async () => {
    const { runner, commands } = createMockRunner({
      screencapture: { stdout: '' },
      'base64 -i': { stdout: 'c2NyZWVuc2hvdA==' },
      'tree ': { stdout: TREE_STDOUT },
    });
    const provider = new LocalDarwinProvider({ runner });
    const state = await provider.getAppState(DEFAULT_CTX, makeLease());
    expect(state.mode).toBe('vision-native');
    expect(state.screenshot).toBeDefined();
    expect(state.elements).toHaveLength(2);
    const first: UIElement = state.elements[0];
    expect(first.role).toBe('button');
    expect(first.label).toBe('OK');
    expect(first.elementId).toBe('/0');
    // The tree walk must target the leased pid, never the focused app.
    expect(commands.some((c) => c.includes('tree 4242'))).toBe(true);
  });

  it('getAppState captures the leased app window (screencapture -l) when a window id resolves', async () => {
    const { runner, commands } = createMockRunner({
      // Order matters: the window-id command contains 'windowid ' and the
      // first matching pattern wins.
      'windowid ': { stdout: '{"id": 777}' },
      'screencapture -x -l': { stdout: '' },
      'base64 -i': { stdout: 'c2NyZWVuc2hvdA==' },
      'tree ': { stdout: TREE_STDOUT },
      osascript: { stdout: 'Finder' },
    });
    const provider = new LocalDarwinProvider({ runner });
    const state = await provider.getAppState(DEFAULT_CTX, makeLease());
    expect(state.screenshot).toBeDefined();
    // The background-launched app is not frontmost — the capture must target
    // the leased app's window, not the full screen (which shows the desktop).
    expect(commands.some((c) => c.includes('screencapture -x -l 777'))).toBe(true);
    expect(commands.some((c) => c.includes('screencapture -x -T0'))).toBe(false);
  });

  it('getAppState falls back to a full-screen capture when no window id resolves', async () => {
    const { runner, commands } = createMockRunner({
      // Window query returns a tree JSON (non-matching) → no id.
      'tree ': { stdout: TREE_STDOUT },
      'screencapture -x -T0': { stdout: '' },
      'base64 -i': { stdout: 'c2NyZWVuc2hvdA==' },
      osascript: { stdout: 'Finder' },
    });
    const provider = new LocalDarwinProvider({ runner });
    const state = await provider.getAppState(DEFAULT_CTX, makeLease());
    expect(state.screenshot).toBeDefined();
    expect(commands.some((c) => c.includes('screencapture -x -T0'))).toBe(true);
  });

  it('getAppState reports a locked screen (frontmost = loginwindow) via notice', async () => {
    const { runner } = createMockRunner({
      'frontmost is true': { stdout: 'loginwindow' },
      'screencapture -x -T0': { stdout: '' },
      'base64 -i': { stdout: 'c2NyZWVuc2hvdA==' },
      'tree ': { stdout: TREE_STDOUT },
      osascript: { stdout: 'Finder' },
    });
    const provider = new LocalDarwinProvider({ runner });
    const state = await provider.getAppState(DEFAULT_CTX, makeLease());
    expect(state.notice).toContain('loginwindow');
    expect(state.notice).toContain('unlock');
  });

  it('click_element issues an AXPress command — never a coordinate click', async () => {
    const { runner, commands } = createMockRunner({ 'press ': { stdout: OK_STDOUT } });
    const provider = new LocalDarwinProvider({ runner });
    const result = await provider.performAction(DEFAULT_CTX, makeLease(), {
      type: 'click_element',
      snapshotElement: {
        elementId: '/0',
        role: 'button',
        label: 'OK',
        bounds: { x: 0, y: 0, width: 10, height: 10 },
      },
    } as any);
    expect(result.ok).toBe(true);
    const press = commands.find((c) => c.includes('press 4242 /0'))!;
    expect(press).toContain('press 4242 /0');
    expect(press).not.toContain('click at');
  });

  it('type_text sets kAXValueAttribute via base64 — no clipboard, no keystroke', async () => {
    const { runner, commands } = createMockRunner({ 'setvalue ': { stdout: OK_STDOUT } });
    const provider = new LocalDarwinProvider({ runner });
    const result = await provider.performAction(DEFAULT_CTX, makeLease(), {
      type: 'type_text',
      text: '你好',
      snapshotElement: {
        elementId: '/1',
        role: 'textbox',
        label: '',
        bounds: { x: 0, y: 0, width: 10, height: 10 },
      },
    } as any);
    expect(result.ok).toBe(true);
    const setvalue = commands.find((c) => c.includes('setvalue 4242 /1'))!;
    expect(setvalue).toContain('setvalue 4242 /1');
    expect(setvalue).not.toContain('keystroke');
    // base64 of '你好' — CJK survives the command line
    expect(setvalue).toContain('5L2g5aW9');
  });

  it('click_element without a snapshotElement returns an error (no coordinate fallback)', async () => {
    const { runner } = createMockRunner({});
    const provider = new LocalDarwinProvider({ runner });
    const result = await provider.performAction(DEFAULT_CTX, makeLease(), {
      type: 'click_element',
    } as any);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('snapshotElement');
  });

  it('type_text remembers the target so a following Enter AXConfirms it (background apps keep window focus)', async () => {
    // Background-launched apps keep the AXWindow as the focused element —
    // confirmfocused fails with NO_CONFIRM while the address bar itself
    // offers AXConfirm. The provider tracks the last type_text element and
    // press_key Enter commits it via confirmpath.
    const { runner, commands } = createMockRunner({
      'setvalue ': { stdout: OK_STDOUT },
      'confirmfocused ': { stdout: '{"ok":false,"error":"NO_CONFIRM"}' },
      'confirmpath ': { stdout: OK_STDOUT },
    });
    const provider = new LocalDarwinProvider({ runner });
    const lease = makeLease();
    const typed = await provider.performAction(DEFAULT_CTX, lease, {
      type: 'type_text',
      text: 'https://example.com',
      snapshotElement: {
        elementId: '/1',
        role: 'textbox',
        label: '',
        bounds: { x: 0, y: 0, width: 10, height: 10 },
      },
    } as any);
    expect(typed.ok).toBe(true);
    const entered = await provider.performAction(DEFAULT_CTX, lease, {
      type: 'press_key',
      key: 'Return',
    } as any);
    expect(entered.ok).toBe(true);
    const confirmCmd = commands.find((c) => c.includes('confirmpath 4242 /1'))!;
    expect(confirmCmd).toContain('confirmpath 4242 /1'); // commits the typed-into element
    expect(commands.some((c) => c.includes('postkey'))).toBe(false);
  });
});
