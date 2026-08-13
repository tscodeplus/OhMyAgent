import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LocalWindowsProvider } from '../../src/computer-use/providers/local-windows.js';
import type { Ctx, Lease } from '../../src/computer-use/types.js';

// ---------------------------------------------------------------------------
// Mock the UIA client: record every request so tests can assert that
// click_element never carries coordinates and no input injection occurs.
// ---------------------------------------------------------------------------

const { requests, MOCK_RESPONSES } = vi.hoisted(() => {
  const requests: Array<{ cmd: string; payload: Record<string, unknown> }> = [];
  const MOCK_RESPONSES: Record<
    string,
    { ok: boolean; result?: unknown; error?: { code: string; message: string } }
  > = {};
  return { requests, MOCK_RESPONSES };
});

vi.mock('../../src/computer-use/win-uia/uia-client.js', () => {
  return {
    UiaClient: class {
      request(cmd: string, payload: Record<string, unknown> = {}) {
        requests.push({ cmd, payload });
        return Promise.resolve(MOCK_RESPONSES[cmd] ?? { ok: true, result: {} });
      }
    },
  };
});

const DEFAULT_CTX: Ctx = { sessionPath: '/test', agentId: 'test-agent' };

function makeLease(overrides?: Partial<Lease>): Lease {
  return {
    leaseId: 'win-test',
    sessionPath: '/test',
    agentId: 'test-agent',
    providerId: 'windows:local',
    appId: 'notepad',
    windowId: '524318',
    createdAt: new Date().toISOString(),
    status: 'active',
    allowedActions: ['click_element', 'click_point', 'type_text', 'press_key', 'scroll', 'stop'],
    providerState: { hwnd: 524318, windowTitle: 'Notepad', targetApp: 'notepad' },
    ...overrides,
  };
}

describe('LocalWindowsProvider', () => {
  beforeEach(() => {
    requests.length = 0;
    for (const k of Object.keys(MOCK_RESPONSES)) delete MOCK_RESPONSES[k];
  });

  it('advertises semantic element actions (no input injection)', () => {
    const provider = new LocalWindowsProvider();
    expect(provider.capabilities.accessibilityTree).toBe(true);
    expect(provider.capabilities.elementActions).toBe('semantic');
    expect(provider.capabilities.textInput).toBe('semantic');
    expect(provider.capabilities.backgroundControl).toBe('full');
    expect(provider.capabilities.requiresForegroundForInput).toBe(false);
  });

  it('getAppState maps a single get-app-state round trip', async () => {
    MOCK_RESPONSES['get-app-state'] = {
      ok: true,
      result: {
        hwnd: 524318,
        gen: 3,
        windowTitle: 'Untitled - Notepad',
        display: { width: 1920, height: 1080 },
        elements: [
          {
            elementId: 'win-524318:3:7',
            role: 'button',
            label: 'Save',
            bounds: { x: 10, y: 20, width: 80, height: 30 },
            enabled: true,
            actions: ['Invoke'],
          },
          {
            elementId: 'win-524318:3:9',
            role: 'textbox',
            label: 'Editor',
            bounds: { x: 0, y: 60, width: 500, height: 400 },
            enabled: true,
            sensitive: false,
          },
        ],
        screenshot: 'aGVsbG8=',
        truncated: false,
      },
    };
    const provider = new LocalWindowsProvider();
    const state = await provider.getAppState(DEFAULT_CTX, makeLease());

    expect(requests).toHaveLength(1);
    expect(requests[0].cmd).toBe('get-app-state');
    expect(requests[0].payload.hwnd).toBe(524318);

    expect(state.mode).toBe('vision-native');
    expect(state.windowTitle).toBe('Untitled - Notepad');
    expect(state.display).toEqual({ width: 1920, height: 1080 });
    expect(state.elements).toHaveLength(2);
    expect(state.elements[0]).toMatchObject({
      elementId: 'win-524318:3:7',
      role: 'button',
      label: 'Save',
      bounds: { x: 10, y: 20, width: 80, height: 30 },
      enabled: true,
      actions: ['Invoke'],
    });
    expect(state.elements[1].role).toBe('textbox');
    expect(state.screenshot).toBeDefined();
  });

  it('click_element sends only the elementId — never coordinates', async () => {
    MOCK_RESPONSES['click-element'] = { ok: true, result: { clicked: true } };
    const provider = new LocalWindowsProvider();
    const lease = makeLease();

    const result = await provider.performAction(DEFAULT_CTX, lease, {
      type: 'click_element',
      elementId: 'win-524318:3:7',
      snapshotElement: {
        elementId: 'win-524318:3:7',
        role: 'button',
        bounds: { x: 10, y: 20, width: 80, height: 30 },
        enabled: true,
      },
    });

    expect(result.ok).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0].cmd).toBe('click-element');
    expect(requests[0].payload).toEqual({ elementId: 'win-524318:3:7' });
    expect(requests[0].payload).not.toHaveProperty('x');
    expect(requests[0].payload).not.toHaveProperty('y');
  });

  it('type_text sends text with the element id (no clipboard involvement)', async () => {
    MOCK_RESPONSES['type-text'] = { ok: true, result: { typed: true } };
    const provider = new LocalWindowsProvider();

    const result = await provider.performAction(DEFAULT_CTX, makeLease(), {
      type: 'type_text',
      elementId: 'win-524318:3:9',
      text: '你好 world',
    });

    expect(result.ok).toBe(true);
    expect(requests[0].cmd).toBe('type-text');
    expect(requests[0].payload).toEqual({ elementId: 'win-524318:3:9', text: '你好 world' });
  });

  it('click_point sends coordinates plus the lease window hwnd (PostMessage chain target)', async () => {
    MOCK_RESPONSES['click-point'] = { ok: true, result: { clicked: true } };
    const provider = new LocalWindowsProvider();

    const result = await provider.performAction(DEFAULT_CTX, makeLease(), {
      type: 'click_point',
      x: 500,
      y: 300,
    });

    expect(result.ok).toBe(true);
    expect(requests[0].cmd).toBe('click-point');
    expect(requests[0].payload).toEqual({ x: 500, y: 300, hwnd: 524318 });
  });

  it('double_click posts a single double-click command with the lease hwnd', async () => {
    MOCK_RESPONSES['double-click'] = { ok: true, result: { clicked: true } };
    const provider = new LocalWindowsProvider();

    const result = await provider.performAction(DEFAULT_CTX, makeLease(), {
      type: 'double_click',
      x: 100,
      y: 200,
    });

    expect(result.ok).toBe(true);
    expect(requests[0].cmd).toBe('double-click');
    expect(requests[0].payload).toEqual({ x: 100, y: 200, hwnd: 524318 });
  });

  it('press_key targets the lease window hwnd', async () => {
    MOCK_RESPONSES['press-key'] = { ok: true, result: { key: 'Enter' } };
    const provider = new LocalWindowsProvider();

    const result = await provider.performAction(DEFAULT_CTX, makeLease(), {
      type: 'press_key',
      key: 'Enter',
    });

    expect(result.ok).toBe(true);
    expect(requests[0].cmd).toBe('press-key');
    expect(requests[0].payload).toEqual({ hwnd: 524318, key: 'Enter' });
  });

  it('maps server ELEMENT_STALE_TREE to an action failure', async () => {
    MOCK_RESPONSES['click-element'] = {
      ok: false,
      error: { code: 'ELEMENT_STALE_TREE', message: 'Stale element' },
    };
    const provider = new LocalWindowsProvider();

    const result = await provider.performAction(DEFAULT_CTX, makeLease(), {
      type: 'click_element',
      elementId: 'win-524318:9:1',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Stale');
  });

  it('createLease launches without focus and skips the foreground read', async () => {
    MOCK_RESPONSES['launch-app'] = { ok: true, result: { pid: 4242, hwnd: 524318 } };
    const provider = new LocalWindowsProvider();

    const lease = await provider.createLease(DEFAULT_CTX, { appName: 'notepad' });

    // With focus-free launch the foreground after launch is the caller's own
    // window - reading it would store a wrong title/rect on the lease.
    expect(requests.map(r => r.cmd)).toEqual(['launch-app']);
    expect(requests[0].payload).toEqual({ name: 'notepad' });
    expect(lease.providerState).toMatchObject({ hwnd: 524318, targetApp: 'notepad' });
  });

  it('createLease falls back to the foreground window when launch yields none', async () => {
    MOCK_RESPONSES['launch-app'] = { ok: true, result: { pid: 4242, hwnd: 0 } };
    MOCK_RESPONSES['get-foreground'] = {
      ok: true,
      result: { hwnd: 524318, title: 'Notepad', windowRect: { x: 0, y: 0, width: 800, height: 600 } },
    };
    const provider = new LocalWindowsProvider();

    const lease = await provider.createLease(DEFAULT_CTX, { appName: 'notepad' });

    expect(requests.map(r => r.cmd)).toEqual(['launch-app', 'get-foreground']);
    expect(lease.providerState).toMatchObject({ hwnd: 524318, windowTitle: 'Notepad' });
  });

  it('activateOnly uses focus-app and its returned window title', async () => {
    MOCK_RESPONSES['focus-app'] = { ok: true, result: { pid: 4242, hwnd: 524318, title: 'Notepad' } };
    const provider = new LocalWindowsProvider();

    const lease = await provider.createLease(DEFAULT_CTX, { appName: 'notepad', activateOnly: true });

    expect(requests.map(r => r.cmd)).toEqual(['focus-app']);
    expect(lease.providerState).toMatchObject({ hwnd: 524318, windowTitle: 'Notepad' });
  });

  it('getStatus reports unavailable when the server is unreachable', async () => {
    MOCK_RESPONSES['ping'] = { ok: false, error: { code: 'SERVER_CRASHED', message: 'no server' } };
    const provider = new LocalWindowsProvider();
    const status = await provider.getStatus(DEFAULT_CTX);
    expect(status.available).toBe(false);
  });
});
