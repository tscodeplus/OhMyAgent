import { describe, it, expect, vi } from 'vitest';
import { SSHComputerUseProvider } from '../../src/computer-use/providers/ssh-provider.js';
import { runSwiftAx, SWIFT_AX_TOOL_SOURCE } from '../../src/computer-use/ssh-actions-darwin.js';
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
        'base64 -i': { stdout: 'iVBOR', stderr: '', exitCode: 0 },
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

  it('getAppState captures the leased app window via screencapture -l when JXA resolves a window id', async () => {
    const { provider, mockPool } = createProvider({
      responses: {
        'uname -s': { stdout: 'Darwin', stderr: '', exitCode: 0 },
        // Order matters: the window-id JXA query also contains 'osascript'.
        'windowid ': { stdout: '{"id": 42}', stderr: '', exitCode: 0 },
        'screencapture -x -l': { stdout: '', stderr: '', exitCode: 0 },
        'base64 -i': { stdout: 'iVBOR', stderr: '', exitCode: 0 },
        'osascript': { stdout: 'Finder', stderr: '', exitCode: 0 },
      },
    });
    const lease = makeLease({ leaseId: 'test-lease-1' });
    const state = await provider.getAppState(DEFAULT_CTX, lease);
    const winCapture = mockPool.exec.mock.calls.find(
      (call: [string]) => call[0].includes('screencapture -x -l'),
    );
    expect(winCapture).toBeDefined();
    expect(winCapture![0]).toContain('screencapture -x -l 42');
    expect(state.screenshot).toBeDefined();
  });

  it('getAppState flags the locked screen (frontmost = loginwindow) via notice', async () => {
    const { provider } = createProvider({
      responses: {
        'uname -s': { stdout: 'Darwin', stderr: '', exitCode: 0 },
        'frontmost is true': { stdout: 'loginwindow', stderr: '', exitCode: 0 },
        'screencapture': { stdout: '', stderr: '', exitCode: 0 },
        'base64 -i': { stdout: 'iVBOR', stderr: '', exitCode: 0 },
        'osascript': { stdout: 'Finder', stderr: '', exitCode: 0 },
      },
    });
    const lease = makeLease({ leaseId: 'test-lease-1' });
    const state = await provider.getAppState(DEFAULT_CTX, lease);
    expect(state.notice).toContain('loginwindow');
  });

  it("getAppState uses 'base64 -i' on macOS", async () => {
    const { provider, mockPool } = createProvider({
      responses: {
        'uname -s': { stdout: 'Darwin', stderr: '', exitCode: 0 },
        'screencapture': { stdout: '', stderr: '', exitCode: 0 },
        'base64 -i': { stdout: 'iVBOR', stderr: '', exitCode: 0 },
        'osascript': { stdout: 'Finder', stderr: '', exitCode: 0 },
      },
    });
    const lease = makeLease({ leaseId: 'test-lease-1' });
    await provider.getAppState(DEFAULT_CTX, lease);
    // The screenshot read-back uses `base64 -i` — the Swift tool's own
    // `base64 -d` writes must not be matched here.
    const base64Call = mockPool.exec.mock.calls.find(
      (call: [string]) => call[0].includes('base64 -i'),
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
        'hitpress ': { stdout: '{"ok":true}', stderr: '', exitCode: 0 },
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
    expect(cmd).toContain('hitpress 12345 500 300');
    // The hit element must belong to the leased app (pid 12345) — never
    // press whatever the user has on top (enforced inside the Swift tool).
    expect(cmd).not.toContain('click at');
  });

  it('click_point maps hit-test API_DISABLED to a readable Accessibility error', async () => {
    const { provider, mockPool } = createProvider({
      responses: {
        'uname -s': { stdout: 'Darwin', stderr: '', exitCode: 0 },
        'hitpress ': {
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
        'hitpress ': {
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

  it('press_key Enter prefers the focused element\'s AXConfirm (Safari ignores background-posted Enter)', async () => {
    const { provider, mockPool } = createProvider({
      responses: {
        'uname -s': { stdout: 'Darwin', stderr: '', exitCode: 0 },
        'confirmfocused ': { stdout: '{"ok":true}', stderr: '', exitCode: 0 },
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
    expect(cmd).toContain('confirmfocused 12345'); // AXConfirm on the focused element
    // No CGEvent keyboard post, no foreground key-code path.
    expect(cmd).not.toContain('postkey 12345');
    expect(cmd).not.toContain('key code 36');
  });

  it('press_key Enter falls back to background CGEvent posting when no focused AXConfirm', async () => {
    const { provider, mockPool } = createProvider({
      responses: {
        'uname -s': { stdout: 'Darwin', stderr: '', exitCode: 0 },
        'confirmfocused ': { stdout: '{"ok":false,"error":"NO_CONFIRM"}', stderr: '', exitCode: 0 },
        'postkey ': { stdout: '{"ok":true}', stderr: '', exitCode: 0 },
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
    // AXConfirm was tried first, then the key posted into the leased app.
    expect(cmd).toContain('postkey 12345 36 0 1'); // targets the leased app
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
        'postkey ': { stdout: '{"ok":true}', stderr: '', exitCode: 0 },
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
    expect(cmd).toContain('postkey 12345 0 131072 1');
  });

  it('press_key resolves cross-platform combo keys ("Meta+L" -> Command key)', async () => {
    const { provider, mockPool } = createProvider({
      responses: {
        'uname -s': { stdout: 'Darwin', stderr: '', exitCode: 0 },
        'postkey ': { stdout: '{"ok":true}', stderr: '', exitCode: 0 },
      },
    });
    await provider.listApps(DEFAULT_CTX);
    const lease = makeLease();
    const result = await provider.performAction(DEFAULT_CTX, lease, {
      type: 'press_key',
      key: 'Meta+L',
    });
    expect(result.ok).toBe(true);
    const cmd = mockPool.exec.mock.lastCall?.[0] as string;
    // 'l' = keycode 37; Command = kCGEventFlagMaskCommand (0x001000 = 4096).
    // The base letter is matched lowercase — no spurious Shift flag.
    expect(cmd).toContain('postkey 12345 37 4096 1');
  });

  it('press_key combo degradation keeps the modifiers (key code ... using {command down})', async () => {
    const { provider, mockPool } = createProvider({
      responses: {
        'uname -s': { stdout: 'Darwin', stderr: '', exitCode: 0 },
        'get frontmost of': { stdout: 'true', stderr: '', exitCode: 0 },
        'postkey ': {
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
      key: 'Meta+A',
    });
    expect(result.ok).toBe(true);
    const cmd = mockPool.exec.mock.lastCall?.[0] as string;
    // 'a' = keycode 0; the System Events fallback must keep Command —
    // without it "Cmd+A" would arrive as a bare "a".
    expect(cmd).toContain('key code 0 using {command down}');
  });

  it('press_key falls back to synthesized key code when background posting fails', async () => {
    const { provider, mockPool } = createProvider({
      responses: {
        'uname -s': { stdout: 'Darwin', stderr: '', exitCode: 0 },
        'get frontmost of': { stdout: 'true', stderr: '', exitCode: 0 },
        'confirmfocused ': {
          stdout: '{"ok":false,"error":"NO_CONFIRM"}',
          stderr: '',
          exitCode: 0,
        },
        'postkey ': {
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
      if (cmd.includes('postkey ')) {
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
        'postkey ': {
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

  it('press_key degradation refuses while the user is active (HIDIdleTime < 3s)', async () => {
    // The degraded path must not yank the user's foreground while they are
    // typing/mousing — mirrors the Windows USER_ACTIVE guard.
    const { provider, mockPool } = createProvider({
      responses: {
        'uname -s': { stdout: 'Darwin', stderr: '', exitCode: 0 },
        'postkey ': {
          stdout: '{"ok":false,"error":"PERFORM_FAILED"}',
          stderr: '',
          exitCode: 0,
        },
        'get frontmost of': { stdout: 'false', stderr: '', exitCode: 0 },
        'HIDIdleTime': { stdout: '1.2', stderr: '', exitCode: 0 },
      },
    });
    await provider.listApps(DEFAULT_CTX);
    const lease = makeLease({ providerState: { pid: 4242, windowId: '0x12345678', display: ':0' } });
    const result = await provider.performAction(DEFAULT_CTX, lease, {
      type: 'press_key',
      key: 'Return',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('User is actively using the computer; retry later');
    const calls = mockPool.exec.mock.calls.map(c => c[0] as string);
    // The activation must never run once the guard refused.
    expect(calls.some(c => c.includes('set frontmost of (first process whose unix id is 4242) to true'))).toBe(false);
  });

  it('press_key degradation hands the foreground back to the previous app once the key lands', async () => {
    // Sequence-aware mock: frontmost check flips to true after the
    // activation, the previous foreground is pid 7777, and the restore
    // happens only because the target still holds the foreground.
    let frontmostChecks = 0;
    let frontmostPidQueries = 0;
    const execFn = vi.fn().mockImplementation(async (cmd: string) => {
      if (cmd.includes('uname -s')) return { stdout: 'Darwin', stderr: '', exitCode: 0 };
      if (cmd.includes('postkey ')) {
        return { stdout: '{"ok":false,"error":"PERFORM_FAILED"}', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('get frontmost of')) {
        frontmostChecks++;
        return { stdout: frontmostChecks >= 2 ? 'true' : 'false', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('whose frontmost is true')) {
        // First query: the user's app (7777) before the swap; second: the
        // leased app still holds the foreground, so the restore proceeds.
        frontmostPidQueries++;
        return { stdout: frontmostPidQueries >= 2 ? '4242' : '7777', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('HIDIdleTime')) return { stdout: '99', stderr: '', exitCode: 0 };
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
    // The key lands first, then the restore hands the user's app back.
    const keyIdx = calls.findIndex(c => c.includes('key code 36'));
    const restoreIdx = calls.findIndex(c => c.includes('unix id is 7777'));
    expect(keyIdx).toBeGreaterThan(-1);
    expect(restoreIdx).toBeGreaterThan(keyIdx);
    expect(calls[restoreIdx]).toContain('set frontmost of (first process whose unix id is 7777) to true');
  });

  it('press_key degradation never yanks the foreground when the user has switched apps', async () => {
    // The restore is guarded: if a third app holds the foreground when the
    // key lands, the swap is left alone (the user/OS switched away). The
    // frontmost check flips true only after the activation, and the
    // foreground pid query always reports a third app (8888), never the
    // leased app — so the restore must not fire.
    let frontmostChecks = 0;
    const execFn = vi.fn().mockImplementation(async (cmd: string) => {
      if (cmd.includes('uname -s')) return { stdout: 'Darwin', stderr: '', exitCode: 0 };
      if (cmd.includes('postkey ')) {
        return { stdout: '{"ok":false,"error":"PERFORM_FAILED"}', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('get frontmost of')) {
        frontmostChecks++;
        return { stdout: frontmostChecks >= 2 ? 'true' : 'false', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('whose frontmost is true')) return { stdout: '8888', stderr: '', exitCode: 0 };
      if (cmd.includes('HIDIdleTime')) return { stdout: '99', stderr: '', exitCode: 0 };
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
    // The key was delivered, and the restore guard saw a third app (8888)
    // holding the foreground — so no restore command was issued.
    expect(calls.some(c => c.includes('key code 36'))).toBe(true);
    expect(calls.some(c => c.includes('set frontmost of (first process whose unix id is 8888) to true'))).toBe(false);
  });

  it('scroll degradation posts arrow keys in the background via CGEventPostToPid', async () => {
    const { provider, mockPool } = createProvider({
      responses: {
        'uname -s': { stdout: 'Darwin', stderr: '', exitCode: 0 },
        // Order matters: the background key-posting command matches
        // 'postkey ' first; the AX scroll tool then matches 'scroll ' and
        // fails, forcing degradation.
        'postkey ': { stdout: '{"ok":true}', stderr: '', exitCode: 0 },
        'scroll ': {
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
    expect(cmd).toContain('postkey 12345 125 0 2'); // repeat 2 in the background
    // The foreground arrow-key path must not run.
    expect(cmd).not.toContain('key code 125');
  });

  it('scroll falls back to foreground arrow keys when background posting fails', async () => {
    const { provider, mockPool } = createProvider({
      responses: {
        'uname -s': { stdout: 'Darwin', stderr: '', exitCode: 0 },
        'get frontmost of': { stdout: 'true', stderr: '', exitCode: 0 },
        'scroll ': {
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
// macOS accessibility-first (AX via the Swift tool) support
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

describe('SSHComputerUseProvider macOS AX (Swift tool, accessibility-first)', () => {
  it('Swift tool reads actions via AXUIElementCopyActionNames (macOS 15 AXActions attribute regression)', () => {
    // On macOS 15.x the "AXActions" ATTRIBUTE returns -25205 on every
    // element (observed on this project's target machines); the C function
    // still works. Reading the attribute silently empties the tree.
    expect(SWIFT_AX_TOOL_SOURCE).toContain('AXUIElementCopyActionNames');
    expect(SWIFT_AX_TOOL_SOURCE).not.toContain('"AXActions" as CFString');
  });

  it('Swift tool walks AXWindows when AXChildren is empty (Safari-style apps)', () => {
    // Safari keeps AXChildren empty at the app level and exposes windows
    // only via AXWindows — without the fallback its tree comes back empty.
    expect(SWIFT_AX_TOOL_SOURCE).toContain('rootChildren');
    expect(SWIFT_AX_TOOL_SOURCE).toContain('"AXWindows" as CFString');
  });

  it('Swift tool commits the focused element via AXConfirm (Safari smart-search Enter regression)', () => {
    // Background-posted Enter (CGEventPostToPid) does not commit Safari's
    // smart search field; the AX-native commit is the focused element's
    // AXConfirm action.
    expect(SWIFT_AX_TOOL_SOURCE).toContain('confirmfocused');
    expect(SWIFT_AX_TOOL_SOURCE).toContain('"AXFocusedUIElement" as CFString');
    expect(SWIFT_AX_TOOL_SOURCE).toContain('"AXConfirm" as CFString');
  });

  it('runSwiftAx caches the compiled tool by source hash under the app-support dir', async () => {
    // The old cache wrote to /tmp and compared mtimes, so ANY invocation
    // with a different embedded source silently recompiled — overwriting a
    // manually-patched binary and regressing the AX layer (happened twice
    // during the macOS 15 regression hunt). The hash-keyed binary is
    // immutable: no mtime dance, no /tmp, atomic mv on first compile.
    const calls: string[] = [];
    const runner = {
      exec: vi.fn().mockImplementation(async (cmd: string) => {
        calls.push(cmd);
        return { stdout: '{"ok":true}', stderr: '', exitCode: 0 };
      }),
    };
    const res = await runSwiftAx(runner as any, ['probe']);
    expect(res).toEqual({ ok: true });
    const cmd = calls[0];
    expect(cmd).toContain('mkdir -p "$HOME/Library/Application Support/OhMyAgent"');
    expect(cmd).toContain('oma-ax-');
    expect(cmd).toContain('swiftc -O');
    expect(cmd).toContain('mv'); // atomic rename — concurrent first calls never interleave
    expect(cmd).not.toContain('-nt'); // the mtime-compare dance is gone
    expect(cmd).not.toContain('/tmp/oma-ax');
  });

  it('runSwiftAx surfaces COMPILE_FAILED instead of a silent null when swiftc fails', async () => {
    const runner = {
      exec: vi.fn().mockResolvedValue({
        stdout: '{"ok":false,"error":"COMPILE_FAILED"}',
        stderr: '',
        exitCode: 1,
      }),
    };
    const res = await runSwiftAx(runner as any, ['probe']);
    // A failed compile is an explicit error the caller can distinguish from
    // an empty AX tree — the old chain just broke silently.
    expect(res).toEqual({ ok: false, error: 'COMPILE_FAILED' });
  });

  it('click_element with snapshotElement issues a JXA AXPress command (never "click at")', async () => {
    const { provider, mockPool } = createProvider({
      responses: {
        'uname -s': { stdout: 'Darwin', stderr: '', exitCode: 0 },
        'press ': { stdout: '{"ok":true}', stderr: '', exitCode: 0 },
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
    expect(cmd).toContain('press 12345 /0/2/5');
    expect(cmd).toContain('/0/2/5');
    expect(cmd).not.toContain('click at');
  });

  it('click_element targets the leased app pid (never the focused app)', async () => {
    const { provider, mockPool } = createProvider({
      responses: {
        'uname -s': { stdout: 'Darwin', stderr: '', exitCode: 0 },
        'press ': { stdout: '{"ok":true}', stderr: '', exitCode: 0 },
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
    // The leased pid (12345) is passed to the Swift tool — the focused-app
    // fallback never runs.
    expect(cmd).toContain('press 12345 /0/2/5');
  });

  it('click_element without a lease pid falls back to the focused application', async () => {
    const { provider, mockPool } = createProvider({
      responses: {
        'uname -s': { stdout: 'Darwin', stderr: '', exitCode: 0 },
        'press ': { stdout: '{"ok":true}', stderr: '', exitCode: 0 },
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
    expect(cmd).toContain('press 0 /0/2/5');
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
        'press ': {
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
        'press ': {
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
        'setvalue ': { stdout: '{"ok":true}', stderr: '', exitCode: 0 },
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
    expect(cmd).toContain('setvalue 12345 /0/2/5'); // targets the leased app
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
        'scroll ': {
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
        'base64 -i': { stdout: 'iVBOR', stderr: '', exitCode: 0 },
        // JXA tree probe returns a non-JSON string like the title probe.
        'tree ': { stdout: 'Finder', stderr: '', exitCode: 0 },
        'osascript': { stdout: 'Finder', stderr: '', exitCode: 0 },
      },
    });
    const lease = makeLease({ leaseId: 'test-lease-1' });
    const state = await provider.getAppState(DEFAULT_CTX, lease);
    expect(state.elements).toEqual([]);
  });

  it('getAppState parses AX elements from Swift tool JSON output (role mapping + elementId as path)', async () => {
    const { provider } = createProvider({
      responses: {
        'uname -s': { stdout: 'Darwin', stderr: '', exitCode: 0 },
        'screencapture': { stdout: '', stderr: '', exitCode: 0 },
        'base64 -i': { stdout: 'iVBOR', stderr: '', exitCode: 0 },
        'tree ': {
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
