import { describe, it, expect, vi } from 'vitest';
import { SSHComputerUseProvider } from '../../src/computer-use/providers/ssh-provider.js';
import type { ComputerUseSettings } from '../../src/computer-use/settings.js';
import type { Ctx, Lease, UIElement } from '../../src/computer-use/types.js';

// ---------------------------------------------------------------------------
// Helpers (mirror of ssh-provider.test.ts)
// ---------------------------------------------------------------------------

const BASE_SETTINGS: ComputerUseSettings = {
  enabled: true,
  provider: 'ssh',
  ssh: {
    host: 'test-host',
    user: 'test-user',
    keyPath: '/tmp/test-key',
    port: 22,
    jumpHost: '',
    display: ':0',
  },
  node: { url: '' },
  allowedApps: [],
  allowedAgents: [],
  approvalWhitelist: [],
  perPlatformProvider: { linux: '', win32: '', darwin: '' },
};

const DEFAULT_CTX: Ctx = { sessionPath: '/test', agentId: 'test-agent' };

function createMockSSHPool(
  responses: Record<string, { stdout: string; stderr: string; exitCode: number }>,
) {
  const execFn = vi.fn().mockImplementation(async (cmd: string) => {
    for (const [pattern, response] of Object.entries(responses)) {
      if (cmd.includes(pattern)) return response;
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  });

  return {
    exec: execFn,
    healthCheck: vi.fn().mockResolvedValue({
      reachable: true,
      deps: { xdotool: true, scrot: true },
    }),
    destroy: vi.fn(),
  };
}

function createProvider(options?: {
  responses?: Record<string, { stdout: string; stderr: string; exitCode: number }>;
  settings?: ComputerUseSettings;
}) {
  const mockPool = createMockSSHPool(options?.responses ?? {});
  const provider = new SSHComputerUseProvider({
    sshPool: mockPool as any,
    settings: options?.settings ?? BASE_SETTINGS,
  });

  return { provider, mockPool };
}

function makeLease(overrides?: Partial<Lease>): Lease {
  return {
    leaseId: 'test-lease-1',
    sessionPath: '/test',
    agentId: 'test-agent',
    providerId: 'ssh',
    appId: 'firefox',
    windowId: '0x12345678',
    createdAt: new Date().toISOString(),
    status: 'active',
    allowedActions: ['click_element', 'type_text', 'press_key', 'scroll', 'click_point', 'stop'],
    providerState: { pid: 12345, windowId: '0x12345678', display: ':0' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// macOS support
// ---------------------------------------------------------------------------

describe('SSHComputerUseProvider macOS support', () => {
  it('_detectRemoteOS returns darwin when uname -s outputs Darwin', async () => {
    const { provider, mockPool } = createProvider({
      responses: {
        'uname -s': { stdout: 'Darwin', stderr: '', exitCode: 0 },
      },
    });
    await provider.listApps(DEFAULT_CTX);
    const osascriptCalls = mockPool.exec.mock.calls.filter(
      (call: [string]) => call[0].includes('osascript'),
    );
    expect(osascriptCalls.length).toBeGreaterThan(0);
  });

  it('_detectRemoteOS returns linux when uname -s outputs Linux', async () => {
    const { provider, mockPool } = createProvider({
      responses: {
        'uname -s': { stdout: 'Linux', stderr: '', exitCode: 0 },
      },
    });
    await provider.listApps(DEFAULT_CTX);
    const osascriptCalls = mockPool.exec.mock.calls.filter(
      (call: [string]) => call[0].includes('osascript'),
    );
    expect(osascriptCalls).toHaveLength(0);
  });

  it('_detectRemoteOS returns linux when uname -s fails (error path)', async () => {
    const { provider, mockPool } = createProvider();
    mockPool.exec.mockRejectedValueOnce(new Error('SSH connection failed'));
    await provider.listApps(DEFAULT_CTX);
    const osascriptCalls = mockPool.exec.mock.calls.filter(
      (call: [string]) => call[0].includes('osascript'),
    );
    expect(osascriptCalls).toHaveLength(0);
  });

  it('performAction type_text on macOS neutralizes single-quote shell injection', async () => {
    // The degraded keystroke path first verifies/activates the leased app
    // (pid from the lease), then types. Sequence-aware frontmost: not
    // frontmost first, confirmed frontmost after the activation.
    let frontmostChecks = 0;
    const execFn = vi.fn().mockImplementation(async (cmd: string) => {
      if (cmd.includes('uname -s')) return { stdout: 'Darwin', stderr: '', exitCode: 0 };
      if (cmd.includes('get frontmost of')) {
        frontmostChecks++;
        return { stdout: frontmostChecks >= 2 ? 'true' : 'false', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const provider = new SSHComputerUseProvider({
      sshPool: {
        exec: execFn,
        healthCheck: vi.fn().mockResolvedValue({
          reachable: true,
          deps: { xdotool: true, scrot: true },
        }),
        destroy: vi.fn(),
      } as any,
      settings: BASE_SETTINGS,
    });
    // Force remote OS detection to darwin.
    await provider.listApps(DEFAULT_CTX);
    const lease = makeLease();

    // Malicious text trying to break out of osascript -e '...' and run rm.
    const evil = `x'; rm -rf ~; echo '`;
    const result = await provider.performAction(DEFAULT_CTX, lease, {
      type: 'type_text',
      text: evil,
    });

    expect(result.ok).toBe(true);
    const calls = execFn.mock.calls.map(c => c[0] as string);
    expect(
      calls.some(c => c.includes('set frontmost of (first process whose unix id is 12345) to true')),
    ).toBe(true);
    const cmd = calls[calls.length - 1];
    // The entire osascript script is wrapped in a single-quoted shell arg,
    // and every literal `'` in the user text is escaped as '\'' (close-quote,
    // escaped-quote, reopen-quote). The malicious `'` therefore cannot break
    // out of the quoting to start a new shell command.
    expect(cmd).toContain(
      `osascript -e 'tell application "System Events" to keystroke "x'\\''; rm -rf ~; echo '\\''"'`,
    );
    // Sanity: the dangerous quote was escaped, not left raw.
    expect(cmd).toContain(`'\\''`);
  });

  it('getAppState uses screencapture on macOS', async () => {
    const { provider, mockPool } = createProvider({
      responses: {
        'uname -s': { stdout: 'Darwin', stderr: '', exitCode: 0 },
        'screencapture': { stdout: '', stderr: '', exitCode: 0 },
        'base64': { stdout: 'iVBOR', stderr: '', exitCode: 0 },
        'osascript': { stdout: 'Finder', stderr: '', exitCode: 0 },
      },
    });
    const lease = makeLease({ leaseId: 'test-lease-1' });
    await provider.getAppState(DEFAULT_CTX, lease);
    const screencaptureCall = mockPool.exec.mock.calls.find(
      (call: [string]) => call[0].includes('screencapture'),
    );
    expect(screencaptureCall).toBeDefined();
    expect(screencaptureCall![0]).toContain('screencapture -x -T0');
  });

  it("getAppState uses 'base64 -i' on macOS", async () => {
    const { provider, mockPool } = createProvider({
      responses: {
        'uname -s': { stdout: 'Darwin', stderr: '', exitCode: 0 },
        'screencapture': { stdout: '', stderr: '', exitCode: 0 },
        'base64': { stdout: 'iVBOR', stderr: '', exitCode: 0 },
        'osascript': { stdout: 'Finder', stderr: '', exitCode: 0 },
      },
    });
    const lease = makeLease({ leaseId: 'test-lease-1' });
    await provider.getAppState(DEFAULT_CTX, lease);
    const base64Call = mockPool.exec.mock.calls.find(
      (call: [string]) => call[0].includes('base64'),
    );
    expect(base64Call).toBeDefined();
    expect(base64Call![0]).toContain('base64 -i');
  });

  it('performAction click_point on macOS generates osascript click at command', async () => {
    const { provider, mockPool } = createProvider({
      responses: {
        'uname -s': { stdout: 'Darwin', stderr: '', exitCode: 0 },
      },
    });
    const lease = makeLease();
    const result = await provider.performAction(DEFAULT_CTX, lease, {
      type: 'click_point',
      x: 500,
      y: 300,
    });
    expect(result.ok).toBe(true);
    const cmd = mockPool.exec.mock.lastCall?.[0];
    expect(cmd).toContain('osascript');
    expect(cmd).toContain('click at {500, 300}');
  });

  it('click_point with a lease pid hits-tests the AX tree instead of clicking (no cursor move)', async () => {
    const { provider, mockPool } = createProvider({
      responses: {
        'uname -s': { stdout: 'Darwin', stderr: '', exitCode: 0 },
        'osascript -l JavaScript': { stdout: '{"ok":true}', stderr: '', exitCode: 0 },
      },
    });
    await provider.listApps(DEFAULT_CTX);
    const lease = makeLease();
    const result = await provider.performAction(DEFAULT_CTX, lease, {
      type: 'click_point',
      x: 500,
      y: 300,
    });
    expect(result.ok).toBe(true);
    const cmd = mockPool.exec.mock.lastCall?.[0] as string;
    expect(cmd).toContain('AXUIElementCopyElementAtPosition');
    expect(cmd).toContain('AXUIElementGetPid');
    expect(cmd).toContain('var sys = $.AXUIElementCreateSystemWide()');
    expect(cmd).toContain('AXUIElementPerformAction(target, "AXPress")');
    // The hit element must belong to the leased app (pid 12345) — never
    // press whatever the user has on top.
    expect(cmd).toContain('pidRef[0] !== 12345');
    expect(cmd).not.toContain('click at');
  });

  it('click_point maps hit-test API_DISABLED to a readable Accessibility error', async () => {
    const { provider, mockPool } = createProvider({
      responses: {
        'uname -s': { stdout: 'Darwin', stderr: '', exitCode: 0 },
        'osascript -l JavaScript': {
          stdout: '{"ok":false,"error":"API_DISABLED"}',
          stderr: '',
          exitCode: 0,
        },
      },
    });
    await provider.listApps(DEFAULT_CTX);
    const lease = makeLease();
    const result = await provider.performAction(DEFAULT_CTX, lease, {
      type: 'click_point',
      x: 100,
      y: 100,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('accessibility API is disabled');
    // Never degrade into a cursor-moving click when the API is disabled.
    expect(mockPool.exec.mock.calls.some(c => (c[0] as string).includes('click at'))).toBe(false);
  });

  it('click_point degrades to the synthesized click when the hit element is foreign', async () => {
    const { provider, mockPool } = createProvider({
      responses: {
        'uname -s': { stdout: 'Darwin', stderr: '', exitCode: 0 },
        'osascript -l JavaScript': {
          stdout: '{"ok":false,"error":"FOREIGN_ELEMENT"}',
          stderr: '',
          exitCode: 0,
        },
      },
    });
    await provider.listApps(DEFAULT_CTX);
    const lease = makeLease();
    const result = await provider.performAction(DEFAULT_CTX, lease, {
      type: 'click_point',
      x: 80,
      y: 90,
    });
    expect(result.ok).toBe(true);
    expect(mockPool.exec.mock.lastCall?.[0]).toContain('click at {80, 90}');
  });

  it('performAction type_text on macOS generates osascript keystroke command', async () => {
    const { provider, mockPool } = createProvider({
      responses: {
        'uname -s': { stdout: 'Darwin', stderr: '', exitCode: 0 },
        'get frontmost of': { stdout: 'true', stderr: '', exitCode: 0 },
      },
    });
    const lease = makeLease();
    const result = await provider.performAction(DEFAULT_CTX, lease, {
      type: 'type_text',
      text: 'hello world',
    });
    expect(result.ok).toBe(true);
    const cmd = mockPool.exec.mock.lastCall?.[0];
    expect(cmd).toContain('osascript');
    expect(cmd).toContain('keystroke "hello world"');
  });

  it('press_key with a lease pid posts the key in the background via CGEventPostToPid', async () => {
    const { provider, mockPool } = createProvider({
      responses: {
        'uname -s': { stdout: 'Darwin', stderr: '', exitCode: 0 },
        'CGEventPostToPid': { stdout: '{"ok":true}', stderr: '', exitCode: 0 },
      },
    });
    await provider.listApps(DEFAULT_CTX);
    const lease = makeLease();
    const result = await provider.performAction(DEFAULT_CTX, lease, {
      type: 'press_key',
      key: 'Return',
    });
    expect(result.ok).toBe(true);
    const cmd = mockPool.exec.mock.lastCall?.[0] as string;
    expect(cmd).toContain('osascript -l JavaScript');
    expect(cmd).toContain('CGEventPostToPid');
    expect(cmd).toContain('CGEventCreateKeyboardEvent($(), 36');
    expect(cmd).toContain('var pid = 12345'); // targets the leased app
    // The foreground key-code path must not run.
    expect(cmd).not.toContain('key code 36');
  });

  it('press_key without a lease pid degrades to synthesized key code', async () => {
    const { provider, mockPool } = createProvider({
      responses: {
        'uname -s': { stdout: 'Darwin', stderr: '', exitCode: 0 },
      },
    });
    await provider.listApps(DEFAULT_CTX);
    const lease = makeLease({ providerState: { windowId: '0x12345678', display: ':0' } });
    const result = await provider.performAction(DEFAULT_CTX, lease, {
      type: 'press_key',
      key: 'Return',
    });
    expect(result.ok).toBe(true);
    const cmd = mockPool.exec.mock.lastCall?.[0] as string;
    expect(cmd).toContain('key code 36');
    expect(cmd).not.toContain('CGEventPostToPid');
  });

  it('press_key uses the Shift flag for uppercase characters', async () => {
    const { provider, mockPool } = createProvider({
      responses: {
        'uname -s': { stdout: 'Darwin', stderr: '', exitCode: 0 },
        'CGEventPostToPid': { stdout: '{"ok":true}', stderr: '', exitCode: 0 },
      },
    });
    await provider.listApps(DEFAULT_CTX);
    const lease = makeLease();
    const result = await provider.performAction(DEFAULT_CTX, lease, {
      type: 'press_key',
      key: 'A',
    });
    expect(result.ok).toBe(true);
    const cmd = mockPool.exec.mock.lastCall?.[0] as string;
    // 'a' = keycode 0; uppercase adds kCGEventFlagMaskShift (0x020000 = 131072).
    expect(cmd).toContain('CGEventCreateKeyboardEvent($(), 0');
    expect(cmd).toContain('var flags = 131072');
  });

  it('press_key falls back to synthesized key code when background posting fails', async () => {
    const { provider, mockPool } = createProvider({
      responses: {
        'uname -s': { stdout: 'Darwin', stderr: '', exitCode: 0 },
        'get frontmost of': { stdout: 'true', stderr: '', exitCode: 0 },
        'osascript -l JavaScript': {
          stdout: '{"ok":false,"error":"PERFORM_FAILED"}',
          stderr: '',
          exitCode: 0,
        },
      },
    });
    await provider.listApps(DEFAULT_CTX);
    const lease = makeLease();
    const result = await provider.performAction(DEFAULT_CTX, lease, {
      type: 'press_key',
      key: 'Return',
    });
    expect(result.ok).toBe(true);
    const cmd = mockPool.exec.mock.lastCall?.[0] as string;
    expect(cmd).toContain('key code 36');
  });

  it('press_key degradation activates the leased app when not frontmost, then posts the key', async () => {
    // Same sequence-aware mock as the type_text degradation test: the key
    // code must only be posted once the leased app is confirmed frontmost.
    let frontmostChecks = 0;
    const execFn = vi.fn().mockImplementation(async (cmd: string) => {
      if (cmd.includes('uname -s')) return { stdout: 'Darwin', stderr: '', exitCode: 0 };
      if (cmd.includes('osascript -l JavaScript')) {
        return { stdout: '{"ok":false,"error":"PERFORM_FAILED"}', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('get frontmost of')) {
        frontmostChecks++;
        return { stdout: frontmostChecks >= 2 ? 'true' : 'false', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const provider = new SSHComputerUseProvider({
      sshPool: {
        exec: execFn,
        healthCheck: vi.fn().mockResolvedValue({
          reachable: true,
          deps: { xdotool: true, scrot: true },
        }),
        destroy: vi.fn(),
      } as any,
      settings: BASE_SETTINGS,
    });
    await provider.listApps(DEFAULT_CTX);
    const lease = makeLease({ providerState: { pid: 4242, windowId: '0x12345678', display: ':0' } });
    const result = await provider.performAction(DEFAULT_CTX, lease, {
      type: 'press_key',
      key: 'Return',
    });
    expect(result.ok).toBe(true);
    const calls = execFn.mock.calls.map(c => c[0] as string);
    expect(
      calls.some(c => c.includes('set frontmost of (first process whose unix id is 4242) to true')),
    ).toBe(true);
    expect(calls[calls.length - 1]).toContain('key code 36');
  });

  it('press_key degradation fails when the leased app cannot be brought frontmost', async () => {
    const { provider } = createProvider({
      responses: {
        'uname -s': { stdout: 'Darwin', stderr: '', exitCode: 0 },
        'osascript -l JavaScript': {
          stdout: '{"ok":false,"error":"PERFORM_FAILED"}',
          stderr: '',
          exitCode: 0,
        },
        'get frontmost of': { stdout: 'false', stderr: '', exitCode: 0 },
      },
    });
    await provider.listApps(DEFAULT_CTX);
    const lease = makeLease({ providerState: { pid: 4242, windowId: '0x12345678', display: ':0' } });
    const result = await provider.performAction(DEFAULT_CTX, lease, {
      type: 'press_key',
      key: 'Return',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Could not foreground target app');
  });

  it('scroll degradation posts arrow keys in the background via CGEventPostToPid', async () => {
    const { provider, mockPool } = createProvider({
      responses: {
        'uname -s': { stdout: 'Darwin', stderr: '', exitCode: 0 },
        // Order matters: the background key-posting JXA contains
        // 'CGEventPostToPid' and matches first; the AX scroll JXA then
        // matches 'osascript -l JavaScript' and fails, forcing degradation.
        'CGEventPostToPid': { stdout: '{"ok":true}', stderr: '', exitCode: 0 },
        'osascript -l JavaScript': {
          stdout: '{"ok":false,"error":"NO_SCROLLABLE"}',
          stderr: '',
          exitCode: 0,
        },
      },
    });
    await provider.listApps(DEFAULT_CTX);
    const lease = makeLease();
    const result = await provider.performAction(DEFAULT_CTX, lease, {
      type: 'scroll',
      direction: 'down',
      amount: 2,
      snapshotElement: makeElement(),
    });
    expect(result.ok).toBe(true);
    const cmd = mockPool.exec.mock.lastCall?.[0] as string;
    expect(cmd).toContain('CGEventPostToPid');
    expect(cmd).toContain('CGEventCreateKeyboardEvent($(), 125');
    // repeat = 2 posts the key twice inside the script.
    expect(cmd).toContain('for (var n = 0; n < 2; n++)');
    // The foreground arrow-key path must not run.
    expect(cmd).not.toContain('key code 125');
  });

  it('scroll falls back to foreground arrow keys when background posting fails', async () => {
    const { provider, mockPool } = createProvider({
      responses: {
        'uname -s': { stdout: 'Darwin', stderr: '', exitCode: 0 },
        'get frontmost of': { stdout: 'true', stderr: '', exitCode: 0 },
        'osascript -l JavaScript': {
          stdout: '{"ok":false,"error":"NO_SCROLLABLE"}',
          stderr: '',
          exitCode: 0,
        },
      },
    });
    await provider.listApps(DEFAULT_CTX);
    const lease = makeLease();
    const result = await provider.performAction(DEFAULT_CTX, lease, {
      type: 'scroll',
      direction: 'up',
      amount: 3,
      snapshotElement: makeElement(),
    });
    expect(result.ok).toBe(true);
    const cmd = mockPool.exec.mock.lastCall?.[0] as string;
    expect(cmd).toContain('key code 126');
    const matches = cmd!.match(/key code 126/g);
    expect(matches).toHaveLength(3);
  });

  it('listApps on macOS uses osascript process listing', async () => {
    const { provider } = createProvider({
      responses: {
        'uname -s': { stdout: 'Darwin', stderr: '', exitCode: 0 },
        'osascript': { stdout: 'Finder, Safari, Terminal', stderr: '', exitCode: 0 },
      },
    });
    const apps = await provider.listApps(DEFAULT_CTX);
    expect(apps).toHaveLength(3);
    expect(apps[0].name).toBe('Finder');
    expect(apps[1].name).toBe('Safari');
    expect(apps[2].name).toBe('Terminal');
  });

  it('OS detection result is cached (uname -s called only once across multiple _detectRemoteOS calls)', async () => {
    const { provider, mockPool } = createProvider({
      responses: {
        'uname -s': { stdout: 'Darwin', stderr: '', exitCode: 0 },
        'osascript': { stdout: 'Finder', stderr: '', exitCode: 0 },
      },
    });
    // First call triggers _detectRemoteOS
    await provider.listApps(DEFAULT_CTX);
    // Second call should use cached value
    await provider.listApps(DEFAULT_CTX);
    const unameCalls = mockPool.exec.mock.calls.filter(
      (call: [string]) => call[0].includes('uname -s'),
    );
    expect(unameCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// macOS accessibility-first (AX via JXA) support
// ---------------------------------------------------------------------------

function makeElement(overrides?: Partial<UIElement>): UIElement {
  return {
    elementId: '/0/2/5',
    role: 'button',
    label: 'OK',
    bounds: { x: 10, y: 20, width: 100, height: 30 },
    enabled: true,
    ...overrides,
  };
}

describe('SSHComputerUseProvider macOS AX (accessibility-first)', () => {
  it('click_element with snapshotElement issues a JXA AXPress command (never "click at")', async () => {
    const { provider, mockPool } = createProvider({
      responses: {
        'uname -s': { stdout: 'Darwin', stderr: '', exitCode: 0 },
        'osascript -l JavaScript': { stdout: '{"ok":true}', stderr: '', exitCode: 0 },
      },
    });
    await provider.listApps(DEFAULT_CTX);
    const lease = makeLease();
    const result = await provider.performAction(DEFAULT_CTX, lease, {
      type: 'click_element',
      snapshotElement: makeElement(),
    });
    expect(result.ok).toBe(true);
    const cmd = mockPool.exec.mock.lastCall?.[0] as string;
    expect(cmd).toContain('osascript -l JavaScript');
    expect(cmd).toContain('/0/2/5');
    expect(cmd).toContain('AXPress');
    expect(cmd).not.toContain('click at');
  });

  it('click_element targets the leased app pid (never the focused app)', async () => {
    const { provider, mockPool } = createProvider({
      responses: {
        'uname -s': { stdout: 'Darwin', stderr: '', exitCode: 0 },
        'osascript -l JavaScript': { stdout: '{"ok":true}', stderr: '', exitCode: 0 },
      },
    });
    await provider.listApps(DEFAULT_CTX);
    // Lease pid 12345 (makeLease default) must be embedded in the JXA script.
    const lease = makeLease({ providerState: { pid: 12345, windowId: '0x12345678', display: ':0' } });
    const result = await provider.performAction(DEFAULT_CTX, lease, {
      type: 'click_element',
      snapshotElement: makeElement(),
    });
    expect(result.ok).toBe(true);
    const cmd = mockPool.exec.mock.lastCall?.[0] as string;
    expect(cmd).toContain('var pid = 12345');
    expect(cmd).toContain('AXUIElementCreateApplication(12345)');
    expect(cmd).not.toContain('kAXFocusedApplicationAttribute');
  });

  it('click_element without a lease pid falls back to the focused application', async () => {
    const { provider, mockPool } = createProvider({
      responses: {
        'uname -s': { stdout: 'Darwin', stderr: '', exitCode: 0 },
        'osascript -l JavaScript': { stdout: '{"ok":true}', stderr: '', exitCode: 0 },
      },
    });
    await provider.listApps(DEFAULT_CTX);
    const lease = makeLease({ providerState: { windowId: '0x12345678', display: ':0' } });
    const result = await provider.performAction(DEFAULT_CTX, lease, {
      type: 'click_element',
      snapshotElement: makeElement(),
    });
    expect(result.ok).toBe(true);
    const cmd = mockPool.exec.mock.lastCall?.[0] as string;
    expect(cmd).toContain('var pid = 0');
    expect(cmd).not.toContain('AXUIElementCreateApplication');
  });

  it('click_element without snapshotElement still returns an error (no coordinate fallback for element clicks)', async () => {
    const { provider } = createProvider({
      responses: {
        'uname -s': { stdout: 'Darwin', stderr: '', exitCode: 0 },
      },
    });
    await provider.listApps(DEFAULT_CTX);
    const lease = makeLease();
    const result = await provider.performAction(DEFAULT_CTX, lease, {
      type: 'click_element',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('No snapshotElement');
  });

  it('click_element maps JXA API_DISABLED to a readable Accessibility permission error', async () => {
    const { provider, mockPool } = createProvider({
      responses: {
        'uname -s': { stdout: 'Darwin', stderr: '', exitCode: 0 },
        'osascript -l JavaScript': {
          stdout: '{"ok":false,"error":"API_DISABLED"}',
          stderr: '',
          exitCode: 0,
        },
      },
    });
    await provider.listApps(DEFAULT_CTX);
    const lease = makeLease();
    const result = await provider.performAction(DEFAULT_CTX, lease, {
      type: 'click_element',
      snapshotElement: makeElement(),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Accessibility');
    const cmd = mockPool.exec.mock.lastCall?.[0] as string;
    expect(cmd).not.toContain('click at');
  });

  it('click_element maps JXA NO_ACTION to a failure result', async () => {
    const { provider } = createProvider({
      responses: {
        'uname -s': { stdout: 'Darwin', stderr: '', exitCode: 0 },
        'osascript -l JavaScript': {
          stdout: '{"ok":false,"error":"NO_ACTION"}',
          stderr: '',
          exitCode: 0,
        },
      },
    });
    await provider.listApps(DEFAULT_CTX);
    const lease = makeLease();
    const result = await provider.performAction(DEFAULT_CTX, lease, {
      type: 'click_element',
      snapshotElement: makeElement(),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('NO_ACTION');
  });

  it('type_text with a textbox snapshotElement sets kAXValueAttribute (no keystroke)', async () => {
    const { provider, mockPool } = createProvider({
      responses: {
        'uname -s': { stdout: 'Darwin', stderr: '', exitCode: 0 },
        'osascript -l JavaScript': { stdout: '{"ok":true}', stderr: '', exitCode: 0 },
      },
    });
    await provider.listApps(DEFAULT_CTX);
    const lease = makeLease();
    const result = await provider.performAction(DEFAULT_CTX, lease, {
      type: 'type_text',
      text: 'hello world',
      snapshotElement: makeElement({ role: 'textbox' }),
    });
    expect(result.ok).toBe(true);
    const cmd = mockPool.exec.mock.lastCall?.[0] as string;
    expect(cmd).toContain('osascript -l JavaScript');
    expect(cmd).toContain('kAXValueAttribute');
    expect(cmd).toContain('var pid = 12345'); // targets the leased app
    expect(cmd).not.toContain('keystroke');
  });

  it('type_text with a non-text element degrades to keystroke', async () => {
    const { provider, mockPool } = createProvider({
      responses: {
        'uname -s': { stdout: 'Darwin', stderr: '', exitCode: 0 },
        'get frontmost of': { stdout: 'true', stderr: '', exitCode: 0 },
      },
    });
    await provider.listApps(DEFAULT_CTX);
    const lease = makeLease();
    const result = await provider.performAction(DEFAULT_CTX, lease, {
      type: 'type_text',
      text: 'hello',
      snapshotElement: makeElement({ role: 'button' }),
    });
    expect(result.ok).toBe(true);
    const cmd = mockPool.exec.mock.lastCall?.[0] as string;
    expect(cmd).toContain('keystroke "hello"');
  });

  it('type_text degradation activates the leased app and verifies frontmost before keystroke', async () => {
    // Frontmost check reports false first, true after the activation — the
    // degraded keystroke must only run once the leased app is confirmed
    // frontmost (else the text would land in the user's app).
    let frontmostChecks = 0;
    const execFn = vi.fn().mockImplementation(async (cmd: string) => {
      if (cmd.includes('uname -s')) return { stdout: 'Darwin', stderr: '', exitCode: 0 };
      if (cmd.includes('get frontmost of')) {
        frontmostChecks++;
        return { stdout: frontmostChecks >= 2 ? 'true' : 'false', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const provider = new SSHComputerUseProvider({
      sshPool: {
        exec: execFn,
        healthCheck: vi.fn().mockResolvedValue({
          reachable: true,
          deps: { xdotool: true, scrot: true },
        }),
        destroy: vi.fn(),
      } as any,
      settings: BASE_SETTINGS,
    });
    await provider.listApps(DEFAULT_CTX);
    const lease = makeLease({ providerState: { pid: 4242, windowId: '0x12345678', display: ':0' } });
    const result = await provider.performAction(DEFAULT_CTX, lease, {
      type: 'type_text',
      text: 'abc',
      snapshotElement: makeElement({ role: 'button' }),
    });
    expect(result.ok).toBe(true);
    const calls = execFn.mock.calls.map(c => c[0] as string);
    expect(
      calls.some(c => c.includes('set frontmost of (first process whose unix id is 4242) to true')),
    ).toBe(true);
    expect(calls[calls.length - 1]).toContain('keystroke "abc"');
  });

  it('type_text degradation fails when the leased app cannot be brought frontmost', async () => {
    const { provider } = createProvider({
      responses: {
        'uname -s': { stdout: 'Darwin', stderr: '', exitCode: 0 },
        'get frontmost of': { stdout: 'false', stderr: '', exitCode: 0 },
      },
    });
    await provider.listApps(DEFAULT_CTX);
    const lease = makeLease({ providerState: { pid: 4242, windowId: '0x12345678', display: ':0' } });
    const result = await provider.performAction(DEFAULT_CTX, lease, {
      type: 'type_text',
      text: 'abc',
      snapshotElement: makeElement({ role: 'button' }),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Could not foreground target app');
  });

  it('type_text truncates oversized payloads (64KB cap)', async () => {
    const { provider, mockPool } = createProvider({
      responses: {
        'uname -s': { stdout: 'Darwin', stderr: '', exitCode: 0 },
        'get frontmost of': { stdout: 'true', stderr: '', exitCode: 0 },
      },
    });
    await provider.listApps(DEFAULT_CTX);
    const lease = makeLease();
    const huge = 'a'.repeat(80 * 1024);
    const result = await provider.performAction(DEFAULT_CTX, lease, {
      type: 'type_text',
      text: huge,
      snapshotElement: makeElement({ role: 'button' }),
    });
    expect(result.ok).toBe(true);
    const cmd = mockPool.exec.mock.lastCall?.[0] as string;
    // Keystroke command must not carry the full 80KB payload.
    expect(cmd.length).toBeLessThan(70_000);
  });

  it('createLease on macOS extracts the pid via pgrep (no wmctrl/xdotool)', async () => {
    const { provider, mockPool } = createProvider({
      responses: {
        'uname -s': { stdout: 'Darwin', stderr: '', exitCode: 0 },
        "command -v -- 'firefox'": { stdout: '/Applications/Firefox.app/Contents/MacOS/firefox', stderr: '', exitCode: 0 },
        "nohup 'firefox'": { stdout: '', stderr: '', exitCode: 0 },
        'pgrep -f -i': { stdout: '12345', stderr: '', exitCode: 0 },
      },
    });

    const lease = await provider.createLease(DEFAULT_CTX, { appName: 'firefox' });

    expect(lease.providerState).toEqual({
      pid: 12345,
      windowId: undefined,
      display: ':0',
    });
    // macOS must not run Linux-only window tooling.
    const allCmds = mockPool.exec.mock.calls.map((call: [string]) => call[0]).join('\n');
    expect(allCmds).not.toContain('wmctrl');
    expect(allCmds).not.toContain('xdotool');
    expect(allCmds).toContain('pgrep -f -i');
  });

  it('scroll with snapshotElement prefers AX scroll action; falls back to arrow keys on JXA failure', async () => {
    const { provider, mockPool } = createProvider({
      responses: {
        'uname -s': { stdout: 'Darwin', stderr: '', exitCode: 0 },
        // JXA scroll fails -> degraded arrow keys
        'get frontmost of': { stdout: 'true', stderr: '', exitCode: 0 },
        'osascript -l JavaScript': {
          stdout: '{"ok":false,"error":"NO_SCROLLABLE"}',
          stderr: '',
          exitCode: 0,
        },
      },
    });
    await provider.listApps(DEFAULT_CTX);
    const lease = makeLease();
    const result = await provider.performAction(DEFAULT_CTX, lease, {
      type: 'scroll',
      direction: 'down',
      amount: 2,
      snapshotElement: makeElement(),
    });
    expect(result.ok).toBe(true);
    const cmd = mockPool.exec.mock.lastCall?.[0] as string;
    expect(cmd).toContain('key code 125');
    const matches = cmd!.match(/key code 125/g);
    expect(matches).toHaveLength(2);
  });

  it('getAppState tolerates non-JSON osascript output (AX tree unavailable) and returns empty elements', async () => {
    const { provider } = createProvider({
      responses: {
        'uname -s': { stdout: 'Darwin', stderr: '', exitCode: 0 },
        'screencapture': { stdout: '', stderr: '', exitCode: 0 },
        'base64': { stdout: 'iVBOR', stderr: '', exitCode: 0 },
        // JXA tree probe returns a non-JSON string like the title probe.
        'osascript -l JavaScript': { stdout: 'Finder', stderr: '', exitCode: 0 },
        'osascript': { stdout: 'Finder', stderr: '', exitCode: 0 },
      },
    });
    const lease = makeLease({ leaseId: 'test-lease-1' });
    const state = await provider.getAppState(DEFAULT_CTX, lease);
    expect(state.elements).toEqual([]);
  });

  it('getAppState parses AX elements from JXA JSON output (role mapping + elementId as path)', async () => {
    const { provider } = createProvider({
      responses: {
        'uname -s': { stdout: 'Darwin', stderr: '', exitCode: 0 },
        'screencapture': { stdout: '', stderr: '', exitCode: 0 },
        'base64': { stdout: 'iVBOR', stderr: '', exitCode: 0 },
        'osascript -l JavaScript': {
          stdout: JSON.stringify({
            ok: true,
            elements: [
              {
                path: '/0',
                role: 'AXButton',
                label: 'OK',
                description: '',
                actions: ['AXPress'],
                enabled: true,
                bounds: { x: 10, y: 20, width: 100, height: 30 },
              },
              {
                path: '/0/1',
                role: 'AXTextField',
                label: '',
                description: '',
                actions: ['AXPress', 'AXSetValue'],
                enabled: true,
                bounds: { x: 10, y: 60, width: 200, height: 22 },
              },
            ],
            truncated: false,
          }),
          stderr: '',
          exitCode: 0,
        },
        'osascript': { stdout: 'Finder', stderr: '', exitCode: 0 },
      },
    });
    const lease = makeLease({ leaseId: 'test-lease-1' });
    const state = await provider.getAppState(DEFAULT_CTX, lease);
    expect(state.elements).toHaveLength(2);
    expect(state.elements[0].elementId).toBe('/0');
    expect(state.elements[0].role).toBe('button');
    expect(state.elements[0].actions).toEqual(['AXPress']);
    expect(state.elements[0].bounds).toEqual({ x: 10, y: 20, width: 100, height: 30 });
    expect(state.elements[1].elementId).toBe('/0/1');
    expect(state.elements[1].role).toBe('textbox');
  });
});
