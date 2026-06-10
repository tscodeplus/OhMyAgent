/**
 * Verify web_search is available from Feishu messages and cron jobs.
 */
import { describe, it, expect } from 'vitest';
import dotenv from 'dotenv';
dotenv.config();

import { loadConfig } from '../../src/app/config.js';
import { ToolRegistryImpl } from '../../src/tools/registry.js';
import { AgentManager } from '../../src/agent/agent-manager.js';
import { createAgentFactory } from '../../src/agent/agent-factory.js';
import type { AgentConfig } from '../../src/agent/config-types.js';

const DEFAULT_AGENT: AgentConfig = {
  id: 'default',
  name: 'Default',
  system_prompt: 'You are a helpful AI assistant.',
};

describe('web_search extension availability', () => {
  const config = loadConfig();
  // Disable Tool Search for this test — we're testing tool availability, not progressive disclosure.
  config.toolSearch = { enabled: 'off', thresholdPct: 10, searchDefaultLimit: 5, maxSearchLimit: 20 };
  const toolRegistry = new ToolRegistryImpl();

  // Simulate extension registration (same as extensions/web-search/index.ts)
  beforeAll(async () => {
    const { createWebSearchTool } = await import('../../extensions/web-search/web-search-tool.js');
    toolRegistry.register(createWebSearchTool({
      providerOrder: config.webSearch.providerOrder,
      tavilyApiKey: config.webSearch.tavilyApiKey,
      exaApiKey: config.webSearch.exaApiKey,
      baiduApiKey: config.webSearch.baiduApiKey,
      timeoutMs: config.webSearch.searchTimeoutMs,
      defaultMaxResults: config.webSearch.maxResults,
    }));
  });

  const agents = config.agents ?? [DEFAULT_AGENT];
  const agentManager = new AgentManager(config, agents, toolRegistry);

  it('web_search is in ToolRegistry after extension loads', () => {
    expect(toolRegistry.has('web_search')).toBe(true);
  });

  it('default agent (standard profile) has web_search', () => {
    const cfg = agentManager.get('default')!;
    expect(agentManager.resolveTools(cfg).map((t: any) => t.name)).toContain('web_search');
  });

  it('coder agent (advanced profile) has web_search', () => {
    const cfg = agentManager.get('coder');
    if (!cfg) return; // skip when coder agent is not configured
    expect(agentManager.resolveTools(cfg).map((t: any) => t.name)).toContain('web_search');
  });

  it('designer agent (standard profile) has web_search', () => {
    const cfg = agentManager.get('designer');
    if (!cfg) return; // skip when designer agent is not configured
    expect(agentManager.resolveTools(cfg).map((t: any) => t.name)).toContain('web_search');
  });

  it('AgentFactory includes web_search for Feishu messages (with chatId)', () => {
    const factory = createAgentFactory({ config, toolRegistry, agentManager }, {});
    const agent = factory.create({ message: 'feishu msg', chatId: 'oc_test' });
    expect((agent.state as any).tools.map((t: any) => t.name)).toContain('web_search');
  });

  it('AgentFactory includes web_search for cron jobs (chatId present)', () => {
    const factory = createAgentFactory({ config, toolRegistry, agentManager }, {});
    const agent = factory.create({ message: 'cron task', sessionId: 'cron:test', chatId: 'oc_cron' });
    expect((agent.state as any).tools.map((t: any) => t.name)).toContain('web_search');
  });

  it('minimal profile agent does NOT have web_search', () => {
    const cfg = agentManager.get('default')!;
    const minimal = { ...cfg, tools: { profile: 'minimal' as const, add: [] as string[], deny: [] as string[] } };
    expect(agentManager.resolveTools(minimal).map((t: any) => t.name)).not.toContain('web_search');
  });
});
