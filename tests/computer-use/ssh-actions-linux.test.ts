import { describe, it, expect, vi } from 'vitest';
import {
  readLinuxAccessibilityTree,
  performLinuxAction,
} from '../../src/computer-use/ssh-actions-linux.js';
import type { SSHPool } from '../../src/computer-use/transports/ssh-pool.js';
import type { UIElement } from '../../src/computer-use/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Response = { stdout: string; stderr: string; exitCode: number };

/** Substring-matched SSH pool mock (same style as ssh-provider.test.ts). */
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

const TREE_JSON = JSON.stringify({
  ok: true,
  truncated: false,
  elements: [
    {
      path: '/0/2',
      role: 'push button',
      label: 'OK',
      description: 'Confirm',
      actions: ['click'],
      bounds: { x: 10, y: 20, width: 30, height: 40 },
      enabled: true,
    },
    {
      path: '/0/3',
      role: 'text entry',
      label: 'Name',
      description: '',
      actions: [],
      bounds: { x: 1, y: 2, width: 3, height: 4 },
      enabled: false,
    },
    {
      path: '/0/4',
      role: 'check box',
      label: 'Accept',
      actions: ['toggle'],
      bounds: { x: 5, y: 6, width: 7, height: 8 },
      enabled: true,
    },
    {
      path: '/0/5',
      role: 'radio button',
      label: 'One',
      actions: [],
      bounds: { x: 1, y: 1, width: 1, height: 1 },
      enabled: true,
    },
    {
      path: '/0/6',
      role: 'page tab',
      label: 'Tab',
      actions: ['activate'],
      bounds: { x: 1, y: 1, width: 1, height: 1 },
      enabled: true,
    },
    {
      path: '/0/7',
      role: 'label',
      label: 'Static',
      actions: [],
      bounds: { x: 1, y: 1, width: 1, height: 1 },
      enabled: true,
    },
    {
      path: '/0/8',
      role: 'tree',
      label: 'Tree',
      actions: [],
      bounds: { x: 1, y: 1, width: 1, height: 1 },
      enabled: true,
    },
  ],
});

function snapshotElement(overrides: Partial<UIElement> = {}): UIElement {
  return {
    elementId: '/0/2/5',
    role: 'button',
    bounds: { x: 100, y: 200, width: 80, height: 30 },
    enabled: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// readLinuxAccessibilityTree
// ---------------------------------------------------------------------------

describe('readLinuxAccessibilityTree', () => {
  it('parses AT-SPI JSON and maps roles/paths/actions/bounds', async () => {
    const { pool, execMock } = createMockSSHPool({
      python3: { stdout: TREE_JSON, stderr: '', exitCode: 0 },
    });

    const elements = await readLinuxAccessibilityTree(pool);

    expect(execMock).toHaveBeenCalledTimes(1);
    const cmd = execMock.mock.calls[0][0] as string;
    expect(cmd).toContain('python3');
    expect(cmd).toContain('python3 -c');

    expect(elements).toHaveLength(7);
    expect(elements[0]).toEqual({
      elementId: '/0/2',
      role: 'button', // push button -> button
      label: 'OK',
      description: 'Confirm',
      bounds: { x: 10, y: 20, width: 30, height: 40 },
      enabled: true,
      actions: ['click'],
    });
    // Role mapping table.
    expect(elements[1].role).toBe('textbox'); // text entry -> textbox
    expect(elements[1].enabled).toBe(false);
    expect(elements[1].actions).toBeUndefined(); // empty actions are omitted
    expect(elements[2].role).toBe('checkbox'); // check box -> checkbox
    expect(elements[3].role).toBe('radiobutton'); // radio button -> radiobutton
    expect(elements[4].role).toBe('tabitem'); // page tab -> tabitem
    expect(elements[5].role).toBe('text'); // label -> text
    expect(elements[6].role).toBe('tree'); // unmapped roles pass through
    // DFS path preserved as elementId.
    expect(elements.map((e) => e.elementId)).toEqual([
      '/0/2',
      '/0/3',
      '/0/4',
      '/0/5',
      '/0/6',
      '/0/7',
      '/0/8',
    ]);
  });

  it('returns [] for non-JSON output (legacy pyatspi probe)', async () => {
    const { pool } = createMockSSHPool({
      'python3 -c': { stdout: 'ATSPI_OK', stderr: '', exitCode: 0 },
    });

    const elements = await readLinuxAccessibilityTree(pool);

    expect(elements).toEqual([]);
  });

  it('returns [] for {"ok":false} output and for missing elements', async () => {
    const { pool } = createMockSSHPool({
      python3: { stdout: '{"ok":false,"error":"NO_DBUS"}', stderr: '', exitCode: 0 },
    });

    expect(await readLinuxAccessibilityTree(pool)).toEqual([]);

    const { pool: pool2 } = createMockSSHPool({
      python3: { stdout: 'not json at all', stderr: '', exitCode: 0 },
    });
    expect(await readLinuxAccessibilityTree(pool2)).toEqual([]);
  });

  it('never throws when exec fails', async () => {
    const execFn = vi.fn().mockRejectedValue(new Error('SSH command exited with code 1'));
    const pool = { exec: execFn } as unknown as SSHPool;

    const elements = await readLinuxAccessibilityTree(pool);

    expect(elements).toEqual([]);
  });

  it('passes appNameOrPid through as a shell-quoted argv', async () => {
    const { pool, execMock } = createMockSSHPool({
      python3: { stdout: TREE_JSON, stderr: '', exitCode: 0 },
    });

    await readLinuxAccessibilityTree(pool, 12345);
    expect(execMock.mock.calls[0][0] as string).toContain("'12345'");

    await readLinuxAccessibilityTree(pool, 'firefox');
    expect(execMock.mock.calls[1][0] as string).toContain("'firefox'");
  });
});

// ---------------------------------------------------------------------------
// performLinuxAction
// ---------------------------------------------------------------------------

describe('performLinuxAction', () => {
  it('click_element with tree path invokes python AT-SPI action (no mouse movement)', async () => {
    const { pool, execMock } = createMockSSHPool({
      python3: { stdout: '{"ok":true}', stderr: '', exitCode: 0 },
    });

    const result = await performLinuxAction(pool, {
      type: 'click_element',
      elementId: '/0/2/5',
      snapshotElement: snapshotElement(),
    });

    expect(result).toEqual({ ok: true, action: 'click_element' });
    const cmd = execMock.mock.lastCall?.[0] as string;
    expect(cmd).toContain('python3');
    expect(cmd).toContain("'/0/2/5'");
    expect(cmd).not.toContain('xdotool mousemove');
    expect(cmd).not.toContain('xdotool');
  });

  it('click_element returns ok:false with the python error when no action exists', async () => {
    const { pool, execMock } = createMockSSHPool({
      python3: { stdout: '{"ok":false,"error":"NO_ACTION"}', stderr: '', exitCode: 0 },
    });

    const result = await performLinuxAction(pool, {
      type: 'click_element',
      elementId: '/0/2/5',
      snapshotElement: snapshotElement(),
    });

    expect(result).toEqual({ ok: false, action: 'click_element', error: 'NO_ACTION' });
    expect(execMock.mock.lastCall?.[0] as string).toContain('python3');
  });

  it('click_element reports python failures as readable errors instead of throwing', async () => {
    const { pool } = createMockSSHPool({
      python3: { stdout: 'boom', stderr: '', exitCode: 0 },
    });

    const result = await performLinuxAction(pool, {
      type: 'click_element',
      elementId: '/0/2/5',
      snapshotElement: snapshotElement(),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('invalid JSON');

    const execFn = vi.fn().mockRejectedValue(new Error('SSH command exited with code 1'));
    const failingPool = { exec: execFn } as unknown as SSHPool;
    const result2 = await performLinuxAction(failingPool, {
      type: 'click_element',
      elementId: '/0/2/5',
      snapshotElement: snapshotElement(),
    });
    expect(result2.ok).toBe(false);
    expect(result2.error).toContain('python script failed');
  });

  it('click_element without snapshotElement returns an error', async () => {
    const { pool } = createMockSSHPool({});

    const result = await performLinuxAction(pool, {
      type: 'click_element',
      elementId: '/0/2/5',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('No snapshotElement');
  });

  it('click_element with non-path element id falls back to xdotool coordinates', async () => {
    const { pool, execMock } = createMockSSHPool({});

    const result = await performLinuxAction(pool, {
      type: 'click_element',
      elementId: 'btn-1',
      snapshotElement: snapshotElement({ elementId: 'btn-1' }),
    });

    expect(result).toEqual({ ok: true, action: 'click_element' });
    expect(execMock.mock.lastCall?.[0]).toBe('xdotool mousemove 140 215 click 1');
  });

  it('click_point keeps the xdotool coordinate click', async () => {
    const { pool, execMock } = createMockSSHPool({});

    const result = await performLinuxAction(pool, {
      type: 'click_point',
      x: 50,
      y: 60,
    });

    expect(result).toEqual({ ok: true, action: 'click_point' });
    expect(execMock.mock.lastCall?.[0]).toBe('xdotool mousemove 50 60 click 1');
  });

  it('type_text with textbox element uses AT-SPI set_text_contents', async () => {
    const { pool, execMock } = createMockSSHPool({
      python3: { stdout: '{"ok":true}', stderr: '', exitCode: 0 },
    });

    const result = await performLinuxAction(pool, {
      type: 'type_text',
      text: 'hello world',
      snapshotElement: snapshotElement({ role: 'textbox' }),
    });

    expect(result).toEqual({ ok: true, action: 'type_text' });
    const cmd = execMock.mock.lastCall?.[0] as string;
    expect(cmd).toContain('python3');
    expect(cmd).toContain("'/0/2/5'");
    expect(cmd).toContain('set_text_contents');
    expect(cmd).toContain("'hello world'");
    expect(cmd).not.toContain('xdotool');
  });

  it('type_text falls back to xdotool type when EditableText is missing', async () => {
    const { pool, execMock } = createMockSSHPool({
      python3: { stdout: '{"ok":false,"error":"NO_EDITABLE_TEXT"}', stderr: '', exitCode: 0 },
    });

    const result = await performLinuxAction(pool, {
      type: 'type_text',
      text: 'hi',
      snapshotElement: snapshotElement({ role: 'textbox' }),
    });

    expect(result).toEqual({ ok: true, action: 'type_text' });
    const cmd = execMock.mock.lastCall?.[0] as string;
    expect(cmd).toMatch(/^xdotool type --delay 50 "/);
    expect(cmd).toContain('hi');
  });

  it('type_text keeps xdotool typing when no element is provided', async () => {
    const { pool, execMock } = createMockSSHPool({});

    const result = await performLinuxAction(pool, { type: 'type_text', text: 'a$b' });

    expect(result).toEqual({ ok: true, action: 'type_text' });
    const cmd = execMock.mock.lastCall?.[0] as string;
    expect(cmd).toMatch(/^xdotool type --delay 50 "/);
    expect(cmd).toContain('\\$b');
  });

  it('press_key keeps xdotool key (AT-SPI has no key-synthesis API)', async () => {
    const { pool, execMock } = createMockSSHPool({});

    const result = await performLinuxAction(pool, { type: 'press_key', key: 'Return' });

    expect(result).toEqual({ ok: true, action: 'press_key' });
    expect(execMock.mock.lastCall?.[0]).toBe('xdotool key "Return"');
  });

  it('scroll without an element keeps the xdotool wheel click', async () => {
    const { pool, execMock } = createMockSSHPool({});

    const result = await performLinuxAction(pool, {
      type: 'scroll',
      direction: 'down',
      amount: 2,
    });

    expect(result).toEqual({ ok: true, action: 'scroll' });
    expect(execMock.mock.lastCall?.[0]).toBe('xdotool click 5 --repeat 2');
  });

  it('scroll with a tree element tries AT-SPI first and falls back to xdotool', async () => {
    const { pool, execMock } = createMockSSHPool({
      python3: { stdout: '{"ok":false,"error":"SCROLL_FAILED"}', stderr: '', exitCode: 0 },
    });

    const result = await performLinuxAction(pool, {
      type: 'scroll',
      direction: 'up',
      amount: 3,
      snapshotElement: snapshotElement({ role: 'list item', elementId: '/0/9' }),
    });

    expect(result).toEqual({ ok: true, action: 'scroll' });
    const calls = execMock.mock.calls;
    expect(calls[0][0] as string).toContain('python3');
    expect(calls[0][0] as string).toContain("'/0/9'");
    expect(calls[0][0] as string).toContain("'up'");
    expect(calls[1][0] as string).toBe('xdotool click 4 --repeat 3');
  });

  it('double_click keeps the xdotool coordinate double click', async () => {
    const { pool, execMock } = createMockSSHPool({});

    const result = await performLinuxAction(pool, {
      type: 'double_click',
      snapshotElement: snapshotElement(),
    });

    expect(result).toEqual({ ok: true, action: 'double_click' });
    expect(execMock.mock.lastCall?.[0]).toBe('xdotool mousemove 140 215 click --repeat 2 1');
  });
});
