import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SSHComputerUseProvider } from '../../src/computer-use/providers/ssh-provider.js';
import type { ComputerUseSettings } from '../../src/computer-use/settings.js';
import type { Ctx, Lease } from '../../src/computer-use/types.js';

// ---------------------------------------------------------------------------
// Helpers
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
// Tests
// ---------------------------------------------------------------------------

describe('SSHComputerUseProvider', () => {
  it('getStatus returns available when healthCheck passes', async () => {
    const { provider } = createProvider();

    const status = await provider.getStatus(DEFAULT_CTX);

    expect(status.providerId).toBe('ssh');
    expect(status.available).toBe(true);
  });

  it('listApps parses wmctrl output into AppInfo array', async () => {
    const wmctrlOut = [
      '0x01000001  0 12345 firefox Firefox - Mozilla',
      '0x01000002  0 12346 gnome-terminal',
      '0x01000003  0 12347 code Visual Studio Code',
    ].join('\n');

    const { provider } = createProvider({
      responses: {
        'wmctrl -l': { stdout: wmctrlOut, stderr: '', exitCode: 0 },
      },
    });

    const apps = await provider.listApps(DEFAULT_CTX);

    expect(apps).toHaveLength(3);
    expect(apps[0].name).toBe('firefox');
    expect(apps[1].name).toBe('gnome-terminal');
    expect(apps[2].name).toBe('code');
    // appId derived from lowercase name
    expect(apps[0].appId).toBe('app.firefox');
    expect(apps[0].running).toBe(true);
    expect(apps[0].windows).toHaveLength(1);
    expect(apps[0].windows[0].windowId).toBe('0x01000001');
  });

  it('createLease with appName returns a Lease with pid and windowId', async () => {
    const { provider, mockPool } = createProvider({
      responses: {
        "command -v -- 'firefox'": { stdout: '/usr/bin/firefox', stderr: '', exitCode: 0 },
        "nohup 'firefox'": { stdout: '', stderr: '', exitCode: 0 },
        'wmctrl -l': {
          stdout: '0x12345678  12345 firefox Firefox - Mozilla',
          stderr: '',
          exitCode: 0,
        },
        'xdotool getwindowpid 0x12345678': { stdout: '12345', stderr: '', exitCode: 0 },
      },
    });

    const lease = await provider.createLease(DEFAULT_CTX, { appName: 'firefox' });

    expect(lease.appId).toBe('firefox');
    expect(lease.windowId).toBe('0x12345678');
    expect(lease.providerState).toEqual({
      pid: 12345,
      windowId: '0x12345678',
      display: ':0',
    });

    // Verify the commands were issued in the expected order
    const calls = mockPool.exec.mock.calls;
    expect(calls[0][0]).toContain("command -v -- 'firefox'");
    expect(calls[1][0]).toContain("nohup 'firefox'");
  });

  it('createLease rejects unsafe appName values before executing SSH commands', async () => {
    const { provider, mockPool } = createProvider();

    await expect(
      provider.createLease(DEFAULT_CTX, { appName: 'firefox;rm -rf /' }),
    ).rejects.toThrow('Invalid application name');

    expect(mockPool.exec).not.toHaveBeenCalled();
  });

  it('getAppState returns AppState with screenshot, display info, and window title', async () => {
    const { provider } = createProvider({
      responses: {
        'xdotool windowactivate': { stdout: '', stderr: '', exitCode: 0 },
        'scrot -z': { stdout: '', stderr: '', exitCode: 0 },
        'base64 -w0': {
          stdout: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk',
          stderr: '',
          exitCode: 0,
        },
        'xdotool getactivewindow getwindowname': {
          stdout: 'Firefox - Mozilla',
          stderr: '',
          exitCode: 0,
        },
        'xdotool getactivewindow getwindowgeometry --shell': {
          stdout: 'WIDTH=1024\nHEIGHT=768\nX=0\nY=0\nSCREEN=0',
          stderr: '',
          exitCode: 0,
        },
        'xdotool getdisplaygeometry': { stdout: '1920 1080', stderr: '', exitCode: 0 },
        'python3 -c': { stdout: 'ATSPI_OK', stderr: '', exitCode: 0 },
      },
    });

    const lease = makeLease({ leaseId: 'test-lease-1' });
    const state = await provider.getAppState(DEFAULT_CTX, lease);

    expect(state.mode).toBe('vision-native');
    expect(state.screenshot).toBeDefined();
    expect(state.screenshot!.type).toBe('image');
    expect(state.screenshot!.mimeType).toBe('image/png');
    expect(state.screenshot!.data).toContain('iVBORw0KGgo');
    expect(state.display.width).toBe(1024);
    expect(state.display.height).toBe(768);
    expect(state.display.originalWidth).toBe(1920);
    expect(state.display.originalHeight).toBe(1080);
    expect(state.windowTitle).toBe('Firefox - Mozilla');
  });

  it('performAction click_element constructs correct xdotool mousemove command', async () => {
    const { provider, mockPool } = createProvider();
    const lease = makeLease();

    const result = await provider.performAction(DEFAULT_CTX, lease, {
      type: 'click_element',
      elementId: 'btn-1',
      snapshotElement: {
        elementId: 'btn-1',
        role: 'button',
        bounds: { x: 100, y: 200, width: 80, height: 30 },
        enabled: true,
      },
    });

    expect(result.ok).toBe(true);
    expect(result.action).toBe('click_element');

    const cmd = mockPool.exec.mock.lastCall?.[0];
    expect(cmd).toContain('xdotool mousemove 140 215 click 1');
  });

  it('performAction type_text escapes special characters', async () => {
    const { provider, mockPool } = createProvider();
    const lease = makeLease();

    // Text containing: $, ", \, and `
    const text = 'echo $HOME && say "hello" from back\\tick`';

    const result = await provider.performAction(DEFAULT_CTX, lease, {
      type: 'type_text',
      text,
    });

    expect(result.ok).toBe(true);
    expect(result.action).toBe('type_text');

    const cmd = mockPool.exec.mock.lastCall?.[0];
    // Expect all special chars to be escaped
    expect(cmd).toContain('\\$HOME');
    expect(cmd).toContain('\\"hello\\"');
    expect(cmd).toContain('back\\\\tick');
    expect(cmd).toContain('\\`');
    // Should start with xdotool type
    expect(cmd).toMatch(/^xdotool type --delay 50 "/);
  });

  it('performAction press_key with valid key uses xdotool key', async () => {
    const { provider, mockPool } = createProvider();
    const lease = makeLease();

    const result = await provider.performAction(DEFAULT_CTX, lease, {
      type: 'press_key',
      key: 'Return',
    });

    expect(result.ok).toBe(true);
    expect(result.action).toBe('press_key');

    const cmd = mockPool.exec.mock.lastCall?.[0];
    expect(cmd).toBe('xdotool key "Return"');
  });

  it('performAction scroll constructs correct xdotool click command', async () => {
    const { provider, mockPool } = createProvider();
    const lease = makeLease();

    const result = await provider.performAction(DEFAULT_CTX, lease, {
      type: 'scroll',
      direction: 'up',
      amount: 3,
    });

    expect(result.ok).toBe(true);
    expect(result.action).toBe('scroll');

    const cmd = mockPool.exec.mock.lastCall?.[0];
    expect(cmd).toBe('xdotool click 4 --repeat 3');
  });

  it('releaseLease removes the remote screenshot file', async () => {
    const { provider, mockPool } = createProvider();
    const lease = makeLease({ leaseId: 'test-lease-1' });

    await provider.releaseLease(DEFAULT_CTX, lease);

    const cmd = mockPool.exec.mock.lastCall?.[0];
    expect(cmd).toContain('rm -f /tmp/cua_test-lease-1.png');
  });

  // ---------------------------------------------------------------------------
  // macOS support
  // ---------------------------------------------------------------------------

  describe('macOS support', () => {
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
      const { provider, mockPool } = createProvider({
        responses: {
          'uname -s': { stdout: 'Darwin', stderr: '', exitCode: 0 },
        },
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
      const cmd = mockPool.exec.mock.lastCall?.[0] as string;
      // The entire osascript script is wrapped in a single-quoted shell arg,
      // and every literal `'` in the user text is escaped as '\'' (close-quote,
      // escaped-quote, reopen-quote). The malicious `'` therefore cannot break
      // out of the quoting to start a new shell command.
      const expected =
        `osascript -e 'tell application "System Events" to keystroke "x'\\''; rm -rf ~; echo '\\''"'`;
      expect(cmd).toBe(expected);
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

    it('performAction type_text on macOS generates osascript keystroke command', async () => {
      const { provider, mockPool } = createProvider({
        responses: {
          'uname -s': { stdout: 'Darwin', stderr: '', exitCode: 0 },
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

    it('performAction press_key on macOS generates key code 36 for Enter', async () => {
      const { provider, mockPool } = createProvider({
        responses: {
          'uname -s': { stdout: 'Darwin', stderr: '', exitCode: 0 },
        },
      });
      const lease = makeLease();
      const result = await provider.performAction(DEFAULT_CTX, lease, {
        type: 'press_key',
        key: 'Return',
      });
      expect(result.ok).toBe(true);
      const cmd = mockPool.exec.mock.lastCall?.[0];
      expect(cmd).toContain('key code 36');
    });

    it('performAction scroll on macOS generates repeated arrow key code commands', async () => {
      const { provider, mockPool } = createProvider({
        responses: {
          'uname -s': { stdout: 'Darwin', stderr: '', exitCode: 0 },
        },
      });
      const lease = makeLease();
      const result = await provider.performAction(DEFAULT_CTX, lease, {
        type: 'scroll',
        direction: 'up',
        amount: 3,
      });
      expect(result.ok).toBe(true);
      const cmd = mockPool.exec.mock.lastCall?.[0];
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
});
