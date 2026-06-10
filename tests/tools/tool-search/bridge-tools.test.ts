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
