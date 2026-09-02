import { describe, it, expect, vi } from 'vitest';
import { LocalLinuxProvider } from '../../src/computer-use/providers/local-linux.js';
import type { ExecRunner, ExecResult } from '../../src/computer-use/ssh-actions-common.js';
import type { Ctx, Lease } from '../../src/computer-use/types.js';

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
      role: 'push button',
      label: 'OK',
      actions: ['click'],
      enabled: true,
      bounds: { x: 10, y: 20, width: 40, height: 20 },
    },
  ],
});

const OK_STDOUT = JSON.stringify({ ok: true });

function makeLease(overrides?: Partial<Lease>): Lease {
  return {
    leaseId: 'lease-1',
    sessionPath: '/test',
    agentId: 'test-agent',
    providerId: 'linux:local',
    appId: 'xed',
    createdAt: new Date().toISOString(),
    status: 'active',
    allowedActions: [],
    providerState: { pid: 1234, windowId: '0x04000007' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

describe('LocalLinuxProvider', () => {
  it('exposes semantic accessibility-first capabilities', () => {
    const provider = new LocalLinuxProvider({ runner: createMockRunner({}).runner });
    expect(provider.capabilities).toMatchObject({
      platform: 'linux',
      elementActions: 'semantic',
      textInput: 'semantic',
      backgroundControl: 'partial',
      requiresForegroundForInput: false,
      accessibilityTree: true,
      screenshot: true,
    });
  });

  it('getStatus is available when the X11 toolchain probe succeeds', async () => {
    const { runner } = createMockRunner({
      'which xdotool': { stdout: '/usr/bin/xdotool\n/usr/bin/scrot\nOK' },
    });
    const provider = new LocalLinuxProvider({ runner });
    const status = await provider.getStatus(DEFAULT_CTX);
    expect(status.available).toBe(true);
  });

  it('getStatus reports unavailable when xdotool/scrot are missing', async () => {
    const { runner } = createMockRunner({ 'which xdotool': { stdout: '/usr/bin/xdotool' } });
    const provider = new LocalLinuxProvider({ runner });
    const status = await provider.getStatus(DEFAULT_CTX);
    expect(status.available).toBe(false);
  });

  it('listApps groups wmctrl windows by first title word', async () => {
    const wmctrlOut = [
      '0x04000007  0 host xed - /home/test/doc.txt',
      '0x04000009  0 host Firefox',
      '0x04000007  0 host xed - another file',
    ].join('\n');
    const { runner } = createMockRunner({ 'wmctrl -l': { stdout: wmctrlOut } });
    const provider = new LocalLinuxProvider({ runner });
    const apps = await provider.listApps(DEFAULT_CTX);
    expect(apps.map((a) => a.name)).toEqual(['xed', 'Firefox']);
    expect(apps.find((a) => a.name === 'xed')!.windows).toHaveLength(2);
  });

  it('createLease launches via nohup, polls wmctrl and resolves pid via xdotool', async () => {
    const wmctrlOut = '0x04000007  0 host xed - /home/test/doc.txt';
    const { runner, commands } = createMockRunner({
      nohup: { stdout: '' },
      'wmctrl -l': { stdout: wmctrlOut },
      'xdotool getwindowpid': { stdout: '1234' },
    });
    const provider = new LocalLinuxProvider({ runner });
    const lease = await provider.createLease(DEFAULT_CTX, { appName: 'xed' });
    expect(lease.providerState).toEqual({
      pid: 1234,
      windowId: '0x04000007',
      display: expect.any(String),
    });
    expect(commands.some((c) => c.startsWith('nohup'))).toBe(true);
  });

  it('createLease rejects unsafe app names', async () => {
    const provider = new LocalLinuxProvider({ runner: createMockRunner({}).runner });
    await expect(provider.createLease(DEFAULT_CTX, { appName: 'bad;rm -rf /' })).rejects.toThrow(
      'Invalid application name',
    );
  });

  it('getAppState reads the AT-SPI tree by windowId (never activates the window)', async () => {
    const { runner, commands } = createMockRunner({
      'scrot -z': { stdout: '' },
      'base64 -w0': { stdout: 'c2NyZWVuc2hvdA==' },
      'python3 -c': { stdout: TREE_STDOUT },
    });
    const provider = new LocalLinuxProvider({ runner });
    const state = await provider.getAppState(DEFAULT_CTX, makeLease());
    expect(state.mode).toBe('vision-native');
    expect(state.elements).toHaveLength(1);
    expect(state.elements[0].label).toBe('OK');
    // Read-only metadata by id — no windowactivate / activation anywhere.
    const all = commands.join('\n');
    expect(all).not.toContain('windowactivate');
    expect(all).toContain('xdotool getwindowpid 0x04000007');
  });

  it('click_element runs the AT-SPI python action script (no coordinate injection)', async () => {
    const { runner, commands } = createMockRunner({ 'python3 -c': { stdout: OK_STDOUT } });
    const provider = new LocalLinuxProvider({ runner });
    const result = await provider.performAction(DEFAULT_CTX, makeLease(), {
      type: 'click_element',
      snapshotElement: {
        elementId: '/0',
        role: 'push button',
        label: 'OK',
        bounds: { x: 0, y: 0, width: 10, height: 10 },
      },
    } as any);
    expect(result.ok).toBe(true);
    const py = commands.find((c) => c.includes('python3 -c'))!;
    // The click script walks the tree and invokes the node action by role;
    // its success marker is DO_ACTION_FAILED (only printed on failure).
    expect(py).toContain('DO_ACTION_FAILED');
    expect(py).toContain('/0');
    expect(py).not.toContain('xdotool');
  });

  it('type_text targets the element via AT-SPI setTextContents (no xdotool type)', async () => {
    const { runner, commands } = createMockRunner({ 'python3 -c': { stdout: OK_STDOUT } });
    const provider = new LocalLinuxProvider({ runner });
    const result = await provider.performAction(DEFAULT_CTX, makeLease(), {
      type: 'type_text',
      text: '你好',
      snapshotElement: {
        elementId: '/0',
        role: 'textbox',
        label: '',
        bounds: { x: 0, y: 0, width: 10, height: 10 },
      },
    } as any);
    expect(result.ok).toBe(true);
    const py = commands.find((c) => c.includes('python3 -c'))!;
    expect(py).not.toContain('xdotool type');
  });
});
