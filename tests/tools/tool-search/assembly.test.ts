// ---------------------------------------------------------------------------
// Assembly tests
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { Type } from 'typebox';
import { assembleTools } from '../../../src/tools/tool-search/assemble.js';
import { TOOL_SEARCH_NAME, TOOL_DESCRIBE_NAME, TOOL_CALL_NAME } from '../../../src/tools/tool-search/bridge-tools.js';
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

function agentTool(name: string): AgentTool {
  return {
    name,
    label: name,
    description: `Tool: ${name}`,
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: 'text', text: 'ok' }], details: {} }),
  };
}

// ---------------------------------------------------------------------------
// Passthrough (no activation)
// ---------------------------------------------------------------------------

describe('assembleTools — passthrough', () => {
  it('returns tools unchanged when all are core', () => {
    const tools = [
      agentTool('file_read'),
      agentTool('shell'),
      agentTool('web_search'),
    ];
    const result = assembleTools(tools, defaultConfig(), 200_000);
    expect(result.activated).toBe(false);
    expect(result.tools.map((t) => t.name).sort()).toEqual(['file_read', 'shell', 'web_search']);
  });

  it('returns tools unchanged when below threshold (auto mode)', () => {
    // One deferrable tool is way below any threshold
    const tools = [
      agentTool('file_read'),
      agentTool('computer_use'), // deferrable
    ];
    const cfg = defaultConfig({ enabled: 'auto', thresholdPct: 50 });
    const result = assembleTools(tools, cfg, 200_000);
    expect(result.activated).toBe(false);
    expect(result.deferredCount).toBe(1);
    expect(result.deferredTokens).toBeGreaterThan(0);
  });

  it('returns tools unchanged when enabled is off', () => {
    const tools = [
      agentTool('file_read'),
      agentTool('computer_use'),
      agentTool('lsp'),
    ];
    const cfg = defaultConfig({ enabled: 'off' });
    const result = assembleTools(tools, cfg, 200_000);
    expect(result.activated).toBe(false);
    expect(result.tools.map((t) => t.name)).toEqual(['file_read', 'computer_use', 'lsp']);
  });

  it('handles empty input', () => {
    const result = assembleTools([], defaultConfig(), 200_000);
    expect(result.activated).toBe(false);
    expect(result.tools).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

describe('assembleTools — activated', () => {
  it('flags deferrable tools as deferred (kept in array, hidden from prompt)', () => {
    const tools = [
      agentTool('file_read'),       // core
      agentTool('shell'),           // core
      agentTool('computer_use'),    // deferrable
      agentTool('image_generation'),// deferrable
      agentTool('cron_create'),     // deferrable
    ];
    const result = assembleTools(tools, defaultConfig({ enabled: 'on' }), 200_000);
    expect(result.activated).toBe(true);
    expect(result.deferredCount).toBe(3);

    const names = result.tools.map((t) => t.name);
    // Core tools present and NOT deferred
    expect(names).toContain('file_read');
    expect(names).toContain('shell');
    expect(result.tools.find((t) => t.name === 'file_read')?.deferred).toBeUndefined();
    // Deferrable tools STILL present in the array (resolvable by name) but flagged
    expect(names).toContain('computer_use');
    expect(names).toContain('image_generation');
    expect(names).toContain('cron_create');
    for (const n of ['computer_use', 'image_generation', 'cron_create']) {
      expect(result.tools.find((t) => t.name === n)?.deferred).toBe(true);
    }
    // tool_search bridge present (search+invoke in one), not deferred
    expect(names).toContain(TOOL_SEARCH_NAME);
    expect(result.tools.find((t) => t.name === TOOL_SEARCH_NAME)?.deferred).toBeUndefined();
    expect(names).not.toContain(TOOL_DESCRIBE_NAME);
    expect(names).not.toContain(TOOL_CALL_NAME);
  });

  it('deferredCatalog contains all deferrable tools (flagged)', () => {
    const tools = [
      agentTool('file_read'),
      agentTool('computer_use'),
      agentTool('lsp'),
    ];
    const result = assembleTools(tools, defaultConfig({ enabled: 'on' }), 200_000);
    expect(result.deferredCatalog.has('computer_use')).toBe(true);
    expect(result.deferredCatalog.has('lsp')).toBe(true);
    expect(result.deferredCatalog.has('file_read')).toBe(false);
    expect(result.deferredCatalog.get('computer_use')?.deferred).toBe(true);
  });

  it('catalog and array reference the SAME flagged tool object', () => {
    const tools = [agentTool('file_read'), agentTool('computer_use')];
    const result = assembleTools(tools, defaultConfig({ enabled: 'on' }), 200_000);
    const fromArray = result.tools.find((t) => t.name === 'computer_use');
    const fromCatalog = result.deferredCatalog.get('computer_use');
    expect(fromArray).toBe(fromCatalog);
  });

  it('removes standalone tool_search when bridge version takes over', () => {
    const tools = [
      agentTool('file_read'),
      agentTool('tool_search'),    // standalone core tool_search
      agentTool('computer_use'),   // deferrable → triggers activation
    ];
    const result = assembleTools(tools, defaultConfig({ enabled: 'on' }), 200_000);
    expect(result.activated).toBe(true);

    const names = result.tools.map((t) => t.name);
    // Bridge tool_search present (added by createBridgeTools)
    expect(names.filter((n) => n === 'tool_search')).toHaveLength(1);
  });

  it('forceVisible keeps named tools out of deferral (visible + not flagged)', () => {
    const tools = [
      agentTool('file_read'),         // core
      agentTool('feishu_send_media'), // deferrable, but force-visible (extraTool)
      agentTool('computer_use'),      // deferrable → triggers activation
    ];
    const result = assembleTools(
      tools,
      defaultConfig({ enabled: 'on' }),
      200_000,
      new Set(['feishu_send_media']),
    );
    expect(result.activated).toBe(true);
    // Forced-visible tool is present, NOT flagged, NOT in deferred catalog
    const forced = result.tools.find((t) => t.name === 'feishu_send_media');
    expect(forced).toBeDefined();
    expect(forced?.deferred).toBeUndefined();
    expect(result.deferredCatalog.has('feishu_send_media')).toBe(false);
    // computer_use still deferred
    expect(result.deferredCatalog.has('computer_use')).toBe(true);
    expect(result.deferredCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe('assembleTools — idempotent', () => {
  it('does not double-add bridge tools on re-assembly with original input', () => {
    const tools = [
      agentTool('file_read'),
      agentTool('computer_use'),
    ];
    // First assembly
    const first = assembleTools(tools, defaultConfig({ enabled: 'on' }), 200_000);
    expect(first.activated).toBe(true);

    // Second assembly with the SAME original tools → idempotent
    const second = assembleTools(tools, defaultConfig({ enabled: 'on' }), 200_000);
    expect(second.activated).toBe(true);

    // tool_search bridge should appear exactly once
    const bridgeNames = second.tools
      .map((t) => t.name)
      .filter((n) => n === TOOL_SEARCH_NAME);
    expect(bridgeNames).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('assembleTools — edge cases', () => {
  it('activated is false when no deferrable tools even with enabled:on', () => {
    const tools = [
      agentTool('file_read'),
      agentTool('shell'),
    ];
    const result = assembleTools(tools, defaultConfig({ enabled: 'on' }), 200_000);
    expect(result.activated).toBe(false);
  });

  it('computes deferredTokens even when not activated', () => {
    const tools = [
      agentTool('file_read'),
      agentTool('computer_use'),
    ];
    const cfg = defaultConfig({ enabled: 'auto', thresholdPct: 100 });
    const result = assembleTools(tools, cfg, 200_000);
    expect(result.activated).toBe(false);
    expect(result.deferredTokens).toBeGreaterThan(0);
  });

  it('sets thresholdTokens correctly', () => {
    const tools = [
      agentTool('file_read'),
      agentTool('computer_use'),
    ];
    const result = assembleTools(tools, defaultConfig({ enabled: 'on' }), 200_000);
    expect(result.thresholdTokens).toBe(Math.floor(200_000 * 0.1));
  });

  it('auto mode with small context activates with many deferrable tools', () => {
    // Create enough tools to exceed the small-context threshold
    // 65K context, 1% threshold = 656 tokens
    // Each tool serializes to ~80 chars / 4 = 20 tokens
    // 50 tools × 20 = 1000 tokens > 656 → should activate
    const coreTools = [agentTool('file_read'), agentTool('shell')];
    const deferrableTools = Array.from({ length: 50 }, (_, i) =>
      agentTool(`mcp_tool_${i}`),
    );
    const tools = [...coreTools, ...deferrableTools];
    const cfg = defaultConfig({ enabled: 'auto', thresholdPct: 1 });
    const result = assembleTools(tools, cfg, 65_536);
    expect(result.activated).toBe(true);
  });
});
