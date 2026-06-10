import { describe, it, expect, vi } from 'vitest';
import { createComputerUseTool } from '../../src/tools/builtins/computer-use-tool.js';
import { computerUseError } from '../../src/computer-use/errors.js';

// ---------------------------------------------------------------------------
// Mock host factory
// ---------------------------------------------------------------------------

function createMockHost() {
  return {
    createLease: vi.fn().mockResolvedValue({
      leaseId: 'test-1',
      appId: 'firefox',
      windowId: '0x12345678',
      status: 'active',
    }),
    getAppState: vi.fn().mockResolvedValue({
      mode: 'vision-native',
      screenshot: { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
      display: { width: 1024, height: 768 },
      elements: [],
      windowTitle: 'Test Window',
      leaseId: 'test-1',
      providerId: 'ssh',
      allowedActions: ['click_element', 'type_text', 'press_key', 'scroll', 'stop'],
      snapshotId: 'snap-1',
    }),
    performAction: vi.fn().mockResolvedValue({ ok: true, action: 'click_element' }),
    stop: vi.fn().mockResolvedValue(true),
    releaseLease: vi.fn().mockResolvedValue(true),
  } as any;
}

function createTool(host = createMockHost()) {
  return createComputerUseTool(host, () => ({
    sessionPath: '/test',
    agentId: 'test-agent',
  }));
}

function extractText(result: any): string {
  const content = result?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c?.type === 'text')
      .map((c: any) => c.text)
      .join('\n');
  }
  return String(content ?? '');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createComputerUseTool', () => {
  it('open_app dispatches to host.createLease with correct target', async () => {
    const host = createMockHost();
    const tool = createTool(host);

    const result = await tool.execute('call-1', { action: 'open_app', target: 'firefox' });

    expect(host.createLease).toHaveBeenCalledWith(
      expect.objectContaining({ sessionPath: '/test', agentId: 'test-agent' }),
      { appName: 'firefox' },
    );
    expect(extractText(result)).toContain('firefox');
    expect(extractText(result)).toContain('test-1');
  });

  it('open_app normalizes known localized Windows app names before launching', async () => {
    const host = createMockHost();
    const tool = createTool(host);

    await tool.execute('call-1', { action: 'open_app', target: '记事本' });

    expect(host.createLease).toHaveBeenCalledWith(
      expect.objectContaining({ sessionPath: '/test', agentId: 'test-agent' }),
      { appName: 'notepad' },
    );
  });

  it('view_screen dispatches to host.getAppState', async () => {
    const host = createMockHost();
    const tool = createTool(host);

    const result = await tool.execute('call-1', { action: 'view_screen' });

    expect(host.getAppState).toHaveBeenCalled();
    expect(extractText(result)).toContain('1024x768');
    expect(extractText(result)).toContain('Test Window');
    expect(extractText(result)).toContain('Snapshot: snap-1');
    expect(extractText(result)).not.toContain('data:image/png;base64');
    // view_screen returns text-only state; screenshots are delivered via the
    // separate send_screenshot action (see refactor 1adbf18).
    expect(result.content.some((c: { type: string }) => c.type === 'image')).toBe(false);
  });

  it('view_screen creates a desktop lease when no active lease exists', async () => {
    const host = createMockHost();
    host.getAppState = vi.fn()
      .mockRejectedValueOnce(computerUseError('LEASE_NOT_FOUND', 'No active lease'))
      .mockResolvedValueOnce({
        mode: 'vision-native',
        screenshot: { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
        display: { width: 1024, height: 768 },
        elements: [],
        leaseId: 'desktop-1',
        providerId: 'local',
        allowedActions: [],
        snapshotId: 'snap-desktop',
      });
    const tool = createTool(host);

    const result = await tool.execute('call-1', { action: 'view_screen' });

    expect(host.createLease).toHaveBeenCalledWith(
      expect.objectContaining({ sessionPath: '/test', agentId: 'test-agent' }),
      { appId: 'desktop' },
    );
    expect(extractText(result)).toContain('desktop-1');
  });

  it('send_screenshot uploads the captured image through channel callback', async () => {
    const host = createMockHost();
    const sendImage = vi.fn().mockResolvedValue('sent');
    const tool = createComputerUseTool(host, () => ({
      sessionPath: '/test',
      agentId: 'test-agent',
    }), { sendImage });

    const result = await tool.execute('call-1', { action: 'send_screenshot' });

    expect(sendImage).toHaveBeenCalledWith({
      data: 'iVBORw0KGgo=',
      mimeType: 'image/png',
    });
    expect(extractText(result)).toContain('Screenshot sent. sent');
    expect(result.details).toMatchObject({ sent: true, snapshotId: 'snap-1' });
  });

  it('click dispatches click_element action to host.performAction', async () => {
    const host = createMockHost();
    const tool = createTool(host);

    const result = await tool.execute('call-1', { action: 'click', element_id: 'btn-1' });

    expect(host.performAction).toHaveBeenCalledWith(
      expect.anything(),
      null,
      { type: 'click_element', elementId: 'btn-1' },
    );
    expect(extractText(result)).toContain('Clicked element "btn-1"');
  });

  it('type_text dispatches type_text action to host.performAction', async () => {
    const host = createMockHost();
    const tool = createTool(host);

    const result = await tool.execute('call-1', { action: 'type_text', text: 'hello world' });

    expect(host.performAction).toHaveBeenCalledWith(
      expect.anything(),
      null,
      { type: 'type_text', text: 'hello world' },
    );
    expect(extractText(result)).toContain('Typed text: "hello world"');
  });

  it('press_key dispatches press_key action to host.performAction', async () => {
    const host = createMockHost();
    const tool = createTool(host);

    const result = await tool.execute('call-1', { action: 'press_key', key: 'Return' });

    expect(host.performAction).toHaveBeenCalledWith(
      expect.anything(),
      null,
      { type: 'press_key', key: 'Return' },
    );
    expect(extractText(result)).toContain('Pressed key "Return"');
  });

  it('scroll dispatches scroll action to host.performAction', async () => {
    const host = createMockHost();
    const tool = createTool(host);

    const result = await tool.execute('call-1', { action: 'scroll', direction: 'up', amount: 3 });

    expect(host.performAction).toHaveBeenCalledWith(
      expect.anything(),
      null,
      { type: 'scroll', direction: 'up', amount: 3 },
    );
    expect(extractText(result)).toContain('Scrolled up');
    expect(extractText(result)).toContain('3');
  });

  it('release_control calls host.stop', async () => {
    const host = createMockHost();
    const tool = createTool(host);

    const result = await tool.execute('call-1', { action: 'release_control' });

    expect(host.stop).toHaveBeenCalled();
    expect(extractText(result)).toContain('Control released');
  });

  it('click_point dispatches click_point action to host.performAction', async () => {
    const host = createMockHost();
    const tool = createTool(host);

    const result = await tool.execute('call-1', { action: 'click_point', x: 500, y: 300 });

    expect(host.performAction).toHaveBeenCalledWith(
      expect.anything(),
      null,
      { type: 'click_point', x: 500, y: 300 },
    );
    expect(extractText(result)).toContain('Clicked at (500, 300)');
  });

  it('click_point missing x returns error', async () => {
    const host = createMockHost();
    const tool = createTool(host);

    const result = await tool.execute('call-1', { action: 'click_point', y: 300 } as any);

    expect(extractText(result)).toContain('"x" and "y" coordinates are required');
  });

  it('click_point missing y returns error', async () => {
    const host = createMockHost();
    const tool = createTool(host);

    const result = await tool.execute('call-1', { action: 'click_point', x: 500 } as any);

    expect(extractText(result)).toContain('"x" and "y" coordinates are required');
  });

  it('error handling: computerUseError returns error text with code', async () => {
    const host = createMockHost();
    host.createLease = vi.fn().mockRejectedValue(
      computerUseError('DISABLED', 'Computer Use is globally disabled', {
        reason: 'config',
      }),
    );
    const tool = createTool(host);

    const result = await tool.execute('call-1', { action: 'open_app', target: 'firefox' });

    const text = extractText(result);
    expect(text).toContain('[Computer Use Error]');
    expect(text).toContain('DISABLED');
    expect(text).toContain('Computer Use is globally disabled');
  });
});
