// ---------------------------------------------------------------------------
// Bridge tools tests
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { Type } from 'typebox';
import {
  createBridgeTools,
  TOOL_SEARCH_NAME,
  TOOL_DESCRIBE_NAME,
  TOOL_CALL_NAME,
} from '../../../src/tools/tool-search/bridge-tools.js';
import type { AgentTool } from '../../../src/pi-mono/agent/types.js';
import type { ToolSearchConfig } from '../../../src/tools/tool-search/config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultConfig(overrides: Partial<ToolSearchConfig> = {}): ToolSearchConfig {
  return {
    enabled: 'on',
    thresholdPct: 10,
    searchDefaultLimit: 5,
    maxSearchLimit: 20,
    ...overrides,
  };
}

function realTool(name: string, description: string = '', resultText: string = `result from ${name}`): AgentTool {
  return {
    name,
    label: name,
    description: description || `Tool: ${name}`,
    parameters: Type.Object({ repo: Type.String() }),
    execute: async () => ({ content: [{ type: 'text', text: resultText }], details: {} }),
  };
}

function makeBridgeTools(
  deferredTools: AgentTool[] = [],
  allTools: AgentTool[] = [],
  activated: boolean = true,
) {
  const deferredCatalog = new Map<string, AgentTool>();
  for (const t of deferredTools) {
    deferredCatalog.set(t.name, t);
  }
  return createBridgeTools({
    deferredCatalog,
    allTools: allTools.length > 0 ? allTools : deferredTools,
    config: defaultConfig(),
    activated,
  });
}

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

describe('bridge tools structure', () => {
  it('creates exactly 3 bridge tools', () => {
    const tools = makeBridgeTools();
    expect(tools).toHaveLength(3);
  });

  it('bridge tools have the correct names', () => {
    const tools = makeBridgeTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain(TOOL_SEARCH_NAME);
    expect(names).toContain(TOOL_DESCRIBE_NAME);
    expect(names).toContain(TOOL_CALL_NAME);
  });

  it('all bridge tools have execute defined', () => {
    const tools = makeBridgeTools();
    for (const t of tools) {
      expect(typeof t.execute).toBe('function');
      expect(t.parameters).toBeDefined();
      expect(t.description).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// tool_search
// ---------------------------------------------------------------------------

describe('tool_search', () => {
  function findSearch(tools: AgentTool[]): AgentTool {
    return tools.find((t) => t.name === TOOL_SEARCH_NAME)!;
  }

  it('returns results for a matching query', async () => {
    const deferred = [
      realTool('github_create_issue', 'Open a new issue in a GitHub repository'),
      realTool('slack_send_message', 'Post a message into a Slack channel'),
    ];
    const bridge = makeBridgeTools(deferred, deferred, true);
    const tool = findSearch(bridge);

    const result = await tool.execute('call1', { query: 'github issue' });
    const text = (result.content[0]! as { type: 'text'; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.matches.length).toBeGreaterThan(0);
    expect(parsed.matches[0].name).toBe('github_create_issue');
  });

  it('returns error when query is empty (matches Hermes behavior)', async () => {
    const deferred = [
      realTool('tool_a'),
      realTool('tool_b'),
    ];
    const bridge = makeBridgeTools(deferred, deferred, true);
    const tool = findSearch(bridge);

    const result = await tool.execute('call1', { query: '' } as any);
    const text = (result.content[0]! as { type: 'text'; text: string }).text;
    expect(text).toContain('query is required');
  });

  it('returns empty matches for irrelevant query', async () => {
    const deferred = [realTool('tool_a')];
    const bridge = makeBridgeTools(deferred, deferred, true);
    const tool = findSearch(bridge);

    const result = await tool.execute('call1', { query: 'xyzzy_nonexistent' });
    const text = (result.content[0]! as { type: 'text'; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.matches).toEqual([]);
  });

  it('respects limit parameter', async () => {
    const deferred = Array.from({ length: 10 }, (_, i) =>
      realTool(`search_tool_${i}`, `search result tool number ${i}`),
    );
    const bridge = makeBridgeTools(deferred, deferred, true);
    const tool = findSearch(bridge);

    const result = await tool.execute('call1', { query: 'search tool', limit: 3 });
    const text = (result.content[0]! as { type: 'text'; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.matches.length).toBeLessThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// tool_describe
// ---------------------------------------------------------------------------

describe('tool_describe', () => {
  function findDescribe(tools: AgentTool[]): AgentTool {
    return tools.find((t) => t.name === TOOL_DESCRIBE_NAME)!;
  }

  it('returns full schema for a deferrable tool', async () => {
    const deferred = [realTool('cron_create', 'Create a cron job')];
    const bridge = makeBridgeTools(deferred, deferred, true);
    const tool = findDescribe(bridge);

    const result = await tool.execute('call1', { name: 'cron_create' });
    const text = (result.content[0]! as { type: 'text'; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.name).toBe('cron_create');
    expect(parsed.description).toBe('Create a cron job');
    expect(parsed.parameters).toBeDefined();
  });

  it('returns error for a core tool name', async () => {
    const bridge = makeBridgeTools([], [realTool('file_read', 'Read a file')], true);
    const tool = findDescribe(bridge);

    const result = await tool.execute('call1', { name: 'file_read' });
    const text = (result.content[0]! as { type: 'text'; text: string }).text;
    expect(text).toContain('not a deferrable tool');
  });

  it('returns error for non-existent tool', async () => {
    const bridge = makeBridgeTools([], [], true);
    const tool = findDescribe(bridge);

    const result = await tool.execute('call1', { name: 'nonexistent' });
    const text = (result.content[0]! as { type: 'text'; text: string }).text;
    expect(text).toContain('not currently available');
  });

  it('returns error for empty name', async () => {
    const bridge = makeBridgeTools([], [], true);
    const tool = findDescribe(bridge);

    const result = await tool.execute('call1', { name: '' });
    const text = (result.content[0]! as { type: 'text'; text: string }).text;
    expect(text).toContain('name is required');
  });
});

// ---------------------------------------------------------------------------
// tool_call
// ---------------------------------------------------------------------------

describe('tool_call', () => {
  function findCall(tools: AgentTool[]): AgentTool {
    return tools.find((t) => t.name === TOOL_CALL_NAME)!;
  }

  it('delegates to the real tool and returns its result', async () => {
    const deferred = [realTool('cron_create', 'Create cron', 'cron created ok')];
    const bridge = makeBridgeTools(deferred, deferred, true);
    const tool = findCall(bridge);

    const result = await tool.execute('call1', {
      name: 'cron_create',
      arguments: { repo: 'a/b' },
    });
    const text = (result.content[0]! as { type: 'text'; text: string }).text;
    expect(text).toBe('cron created ok');
  });

  it('returns error for core tool name', async () => {
    const bridge = makeBridgeTools([], [realTool('file_read')], true);
    const tool = findCall(bridge);

    const result = await tool.execute('call1', {
      name: 'file_read',
      arguments: {},
    });
    const text = (result.content[0]! as { type: 'text'; text: string }).text;
    expect(text).toContain('not a deferrable tool');
  });

  it('returns error when tool_call tries to invoke itself', async () => {
    const bridge = makeBridgeTools([], [], true);
    const tool = findCall(bridge);

    const result = await tool.execute('call1', {
      name: TOOL_CALL_NAME,
      arguments: {},
    });
    const text = (result.content[0]! as { type: 'text'; text: string }).text;
    expect(text).toContain('cannot invoke itself');
  });

  it('returns error for tool not in deferred catalog', async () => {
    const deferred = [realTool('mcp_github_tool')];
    const bridge = makeBridgeTools(deferred, deferred, true);
    const tool = findCall(bridge);

    const result = await tool.execute('call1', {
      name: 'mcp_nonexistent',
      arguments: {},
    });
    const text = (result.content[0]! as { type: 'text'; text: string }).text;
    expect(text).toContain('not available');
  });

  it('returns error for empty name', async () => {
    const bridge = makeBridgeTools([], [], true);
    const tool = findCall(bridge);

    const result = await tool.execute('call1', {
      name: '',
      arguments: {},
    });
    const text = (result.content[0]! as { type: 'text'; text: string }).text;
    expect(text).toContain('requires a "name"');
  });
});

// ---------------------------------------------------------------------------
// Dynamic description (unlocked tools) — 方案B
// ---------------------------------------------------------------------------

describe('tool_search dynamic description', () => {
  function findSearch(bridge: AgentTool[]): AgentTool {
    return bridge.find((t) => t.name === TOOL_SEARCH_NAME)!;
  }

  function findCall(bridge: AgentTool[]): AgentTool {
    return bridge.find((t) => t.name === TOOL_CALL_NAME)!;
  }

  it('keeps the original description byte-identical before any unlock', () => {
    const search = findSearch(makeBridgeTools([realTool('computer_use')]));
    expect(search.description).toContain('Search BEFORE using generic tools');
    expect(search.description).not.toContain('Unlocked');
    // 与静态时代逐字节一致(不破坏 prompt 缓存的关键)
    expect(search.description).toContain(
      'on-demand tools available: computer_use',
    );
  });

  it('switches to "call directly" description after invoke unlocks a tool', async () => {
    const bridge = makeBridgeTools([realTool('computer_use')]);
    const search = findSearch(bridge);
    const result = await search.execute!(
      '1',
      { query: 'computer use', invoke: true, arguments: { repo: 'x' } },
      undefined,
      undefined,
    );
    const text = (result.content[0]! as { type: 'text'; text: string }).text;
    expect(text).toContain('[invoked computer_use]');

    expect(search.description).toContain('Unlocked');
    expect(search.description).toContain('computer_use');
    expect(search.description).not.toContain('Search BEFORE');
  });

  it('lists remaining on-demand tools excluding the unlocked one', async () => {
    const bridge = makeBridgeTools([
      realTool('computer_use'),
      realTool('memory_rebuild_persona'),
    ]);
    const search = findSearch(bridge);
    await search.execute!(
      '1',
      { query: 'computer use', invoke: true, arguments: { repo: 'x' } },
      undefined,
      undefined,
    );
    // unlocked 工具出现在"直接调用"列表
    expect(search.description).toContain('Unlocked — call directly');
    // 未解锁工具仍列在 on-demand 目录里
    expect(search.description).toContain('memory_rebuild_persona');
  });

  it('reports no remaining tools when all are unlocked', async () => {
    const bridge = makeBridgeTools([realTool('only_tool')]);
    const search = findSearch(bridge);
    await search.execute!(
      '1',
      { query: 'only_tool', invoke: true, arguments: { repo: 'x' } },
      undefined,
      undefined,
    );
    expect(search.description).toContain('all on-demand tools are unlocked');
  });

  it('rejects re-invoking an already-unlocked tool via tool_search', async () => {
    const bridge = makeBridgeTools([realTool('computer_use')]);
    const search = findSearch(bridge);
    // 第一次 invoke 解锁并执行
    const first = await search.execute!(
      '1',
      { query: 'computer use', invoke: true, arguments: { repo: 'x' } },
      undefined,
      undefined,
    );
    expect((first.content[0]! as { type: 'text'; text: string }).text).toContain(
      '[invoked computer_use]',
    );
    // 第二次 invoke 同一工具 → 拒绝执行,返回行为矫正错误
    const second = await search.execute!(
      '2',
      { query: 'computer use', invoke: true, arguments: { repo: 'x' } },
      undefined,
      undefined,
    );
    const text = (second.content[0]! as { type: 'text'; text: string }).text;
    expect(text).toContain('[ERROR]');
    expect(text).toContain('UNLOCKED');
    expect(text).toContain('Call');
    expect(text).not.toContain('[invoked');
  });

  it('tool_call also registers the unlock', async () => {
    const bridge = makeBridgeTools([realTool('cron_create')]);
    const search = findSearch(bridge);
    const call = findCall(bridge);
    await call.execute('call1', {
      name: 'cron_create',
      arguments: { repo: 'a/b' },
    });
    expect(search.description).toContain('Unlocked');
    expect(search.description).toContain('cron_create');
  });

  it('keeps the short static description when not activated', () => {
    const search = findSearch(makeBridgeTools([realTool('a')], [], false));
    expect(search.description).toBe(
      'Search available tools by name using exact match, substring, or regex pattern.',
    );
  });

  it('tool_describe notes when a tool is already unlocked', async () => {
    const bridge = makeBridgeTools([realTool('cron_create')]);
    const search = findSearch(bridge);
    const describe = bridge.find((t) => t.name === TOOL_DESCRIBE_NAME)!;
    await search.execute!(
      '1',
      { query: 'cron', invoke: true, arguments: { repo: 'x' } },
      undefined,
      undefined,
    );
    const result = await describe.execute('d1', { name: 'cron_create' });
    const text = (result.content[0]! as { type: 'text'; text: string }).text;
    expect(text).toContain('UNLOCKED');
    expect(text).toContain('Call it directly');
  });
});
