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
    { path: '/0', role: 'AXButton', label: 'OK', actions: ['AXPress'], enabled: true, bounds: { x: 10, y: 20, width: 40, height: 20 } },
    { path: '/1', role: 'AXTextField', label: '', actions: ['AXConfirm'], enabled: true, bounds: { x: 0, y: 0, width: 100, height: 30 } },
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

  it('getStatus is available when osascript probe succeeds', async () => {
    const { runner } = createMockRunner({ 'System Events': { stdout: 'Finder' } });
    const provider = new LocalDarwinProvider({ runner });
    const status = await provider.getStatus(DEFAULT_CTX);
    expect(status.available).toBe(true);
    expect(status.permissions).toEqual([{ name: 'macos-accessibility', granted: true }]);
  });

  it('getStatus reports unavailable when osascript fails (TCC/API disabled)', async () => {
    const { runner } = createMockRunner({ 'System Events': { error: 'kAXErrorAPIDisabled' } });
    const provider = new LocalDarwinProvider({ runner });
    const status = await provider.getStatus(DEFAULT_CTX);
    expect(status.available).toBe(false);
    expect(status.message).toContain('unavailable');
  });

  it('listApps parses osascript visible-process output', async () => {
    const { runner } = createMockRunner({
      'get name of every process': { stdout: 'Finder, TextEdit, Safari' },
    });
    const provider = new LocalDarwinProvider({ runner });
    const apps = await provider.listApps(DEFAULT_CTX);
    expect(apps.map(a => a.name)).toEqual(['Finder', 'TextEdit', 'Safari']);
  });

  it('createLease launches via `open -a` and resolves the pid via pgrep', async () => {
    const { runner, commands } = createMockRunner({
      'open -a': { stdout: '' },
      'pgrep -f -i': { stdout: '4242' },
    });
    const provider = new LocalDarwinProvider({ runner });
    const lease = await provider.createLease(DEFAULT_CTX, { appName: 'TextEdit' });
    expect(lease.providerState).toEqual({ pid: 4242 });
    expect(commands.some(c => c.startsWith('open -a'))).toBe(true);
    expect(commands.some(c => c.includes('pgrep -f -i'))).toBe(true);
  });

  it('createLease rejects unsafe app names', async () => {
    const provider = new LocalDarwinProvider({ runner: createMockRunner({}).runner });
    await expect(provider.createLease(DEFAULT_CTX, { appName: 'bad;rm -rf /' })).rejects.toThrow(
      'Invalid application name',
    );
  });

  it('getAppState parses the JXA tree into UI elements', async () => {
    const { runner, commands } = createMockRunner({
      'screencapture': { stdout: '' },
      'base64 -i': { stdout: 'c2NyZWVuc2hvdA==' },
      'osascript -l JavaScript': { stdout: TREE_STDOUT },
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
    // The tree walk must embed the leased pid, never the focused app.
    expect(commands.find(c => c.includes('osascript -l JavaScript'))).toContain('4242');
  });

  it('click_element issues an AXPress command — never a coordinate click', async () => {
    const { runner, commands } = createMockRunner({ 'osascript -l JavaScript': { stdout: OK_STDOUT } });
    const provider = new LocalDarwinProvider({ runner });
    const result = await provider.performAction(DEFAULT_CTX, makeLease(), {
      type: 'click_element',
      snapshotElement: { elementId: '/0', role: 'button', label: 'OK', bounds: { x: 0, y: 0, width: 10, height: 10 } },
    } as any);
    expect(result.ok).toBe(true);
    const jxa = commands.find(c => c.includes('osascript -l JavaScript'))!;
    expect(jxa).toContain('AXUIElementPerformAction');
    expect(jxa).not.toContain('click at');
    expect(jxa).toContain('4242'); // pid-targeted, not focused app
  });

  it('type_text sets kAXValueAttribute via base64 — no clipboard, no keystroke', async () => {
    const { runner, commands } = createMockRunner({ 'osascript -l JavaScript': { stdout: OK_STDOUT } });
    const provider = new LocalDarwinProvider({ runner });
    const result = await provider.performAction(DEFAULT_CTX, makeLease(), {
      type: 'type_text',
      text: '你好',
      snapshotElement: { elementId: '/1', role: 'textbox', label: '', bounds: { x: 0, y: 0, width: 10, height: 10 } },
    } as any);
    expect(result.ok).toBe(true);
    const jxa = commands.find(c => c.includes('osascript -l JavaScript'))!;
    expect(jxa).toContain('kAXValueAttribute');
    expect(jxa).not.toContain('keystroke');
    // base64 of '你好' — CJK survives the command line
    expect(jxa).toContain('5L2g5aW9');
  });

  it('click_element without a snapshotElement returns an error (no coordinate fallback)', async () => {
    const { runner } = createMockRunner({});
    const provider = new LocalDarwinProvider({ runner });
    const result = await provider.performAction(DEFAULT_CTX, makeLease(), { type: 'click_element' } as any);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('snapshotElement');
  });
});
