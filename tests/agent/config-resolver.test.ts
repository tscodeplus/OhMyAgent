import { describe, it, expect } from 'vitest';
import { resolveAgentConfig, resolveAllAgents } from '../../src/agent/config-resolver.js';
import type { AgentConfig } from '../../src/agent/config-types.js';
import type { AppConfig } from '../../src/app/types.js';

function makeBaseConfig(overrides?: Partial<AppConfig>): AppConfig {
  return {
    feishu: {
      appId: 'app-id',
      appSecret: 'app-secret',
      verificationToken: '',
      encryptKey: '',
      wsEnabled: true,
    },
    piAi: {
      provider: 'test',
      model: 'test-model',
      reasoningModel: 'test-reasoner',
      apiKey: 'test-key',
    },
    embedding: {
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'emb-key',
      model: 'test-emb',
      dimension: 1024,
    },
    database: { path: './data/test.db' },
    tools: {
      shellEnabled: true,
      defaultTimeoutMs: 60000,
      maxOutputLength: 12000,
      shellApprovalWhitelist: [],
      shellApprovalMode: 'balanced',
      fileRead: {
        allowedRoots: [],
        deniedPatterns: [],
        allowPathTraversal: false,
        allowHomeReference: false,
      },
      toolsProfile: 'standard',
    },
    memory: {
      autoRecall: false,
      autoRecallFrequency: 'first',
      autoCapture: false,
      recallTopK: 3,
      captureMaxChars: 500,
      summarizeInterval: 20,
      outputLanguage: 'Auto',
    },
    fallbackModels: [],
    rateLimit: {
      webhookMaxRequests: 100,
      webhookWindowMs: 60000,
    },
    toolSearch: { enabled: 'off' as const },
    smart_agent_team: {
      enabled: false,
      max_children: 4,
    },
    ...overrides,
  };
}

function makeAgentConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    id: 'default',
    name: 'Default',
    description: '',
    system_prompt: 'You are helpful.',
    tools: { profile: 'advanced', add: [], deny: [] },
    ...overrides,
  };
}

// ============================================================================
// P0: spawn.enabled gate + max_parallel unification
// ============================================================================

describe('P0: resolveSpawn — spawn.enabled gate', () => {
  it('agent with spawn.enabled=true gets enabled: true', () => {
    const global = makeBaseConfig();
    const agent = makeAgentConfig({ spawn: { enabled: true } });
    const resolved = resolveAgentConfig(global, agent);
    expect(resolved.spawn.enabled).toBe(true);
  });

  it('agent with spawn.enabled=false gets enabled: false', () => {
    const global = makeBaseConfig();
    const agent = makeAgentConfig({ spawn: { enabled: false } });
    const resolved = resolveAgentConfig(global, agent);
    expect(resolved.spawn.enabled).toBe(false);
  });

  it('agent with no spawn block defaults to false when smart_agent_team is disabled', () => {
    const global = makeBaseConfig({ smart_agent_team: { enabled: false, max_children: 4 } });
    const agent = makeAgentConfig();
    // Ensure agent has no spawn property at all
    delete (agent as any).spawn;
    const resolved = resolveAgentConfig(global, agent);
    expect(resolved.spawn.enabled).toBe(false);
  });

  it('agent with no spawn block defaults to TRUE when smart_agent_team is enabled (migration)', () => {
    const global = makeBaseConfig({ smart_agent_team: { enabled: true, max_children: 4 } });
    const agent = makeAgentConfig();
    delete (agent as any).spawn;
    const resolved = resolveAgentConfig(global, agent);
    expect(resolved.spawn.enabled).toBe(true);
  });

  it('agent with explicit empty spawn block defaults enabled to false regardless of global', () => {
    const global = makeBaseConfig({ smart_agent_team: { enabled: true, max_children: 4 } });
    const agent = makeAgentConfig({ spawn: {} });
    const resolved = resolveAgentConfig(global, agent);
    expect(resolved.spawn.enabled).toBe(false);
  });
});

// ============================================================================
// P0: max_parallel unification
// ============================================================================

describe('P0: resolveSpawn — max_parallel unification', () => {
  it('respects agent-level spawn.max_parallel', () => {
    const global = makeBaseConfig({ smart_agent_team: { enabled: true, max_children: 4 } });
    const agent = makeAgentConfig({ spawn: { enabled: true, max_parallel: 2 } });
    const resolved = resolveAgentConfig(global, agent);
    expect(resolved.spawn.max_parallel).toBe(2);
  });

  it('falls back to smart_agent_team.max_children when agent max_parallel is unset', () => {
    const global = makeBaseConfig({ smart_agent_team: { enabled: true, max_children: 6 } });
    const agent = makeAgentConfig({ spawn: { enabled: true } });
    const resolved = resolveAgentConfig(global, agent);
    expect(resolved.spawn.max_parallel).toBe(6);
  });

  it('falls back to default 4 when neither agent nor global specifies', () => {
    const global = makeBaseConfig();
    // @ts-expect-error: deliberately remove smart_agent_team entirely
    delete (global as any).smart_agent_team;
    const agent = makeAgentConfig({ spawn: { enabled: true } });
    const resolved = resolveAgentConfig(global, agent);
    expect(resolved.spawn.max_parallel).toBe(4);
  });

  it('uses agent max_parallel even when smart_agent_team is absent', () => {
    const global = makeBaseConfig();
    // @ts-expect-error: deliberately remove smart_agent_team entirely
    delete (global as any).smart_agent_team;
    const agent = makeAgentConfig({ spawn: { enabled: true, max_parallel: 3 } });
    const resolved = resolveAgentConfig(global, agent);
    expect(resolved.spawn.max_parallel).toBe(3);
  });
});

// ============================================================================
// P0: resolveAllAgents consistency
// ============================================================================

describe('P0: resolveAllAgents', () => {
  it('applies migration to all agents consistently', () => {
    const global = makeBaseConfig({ smart_agent_team: { enabled: true, max_children: 5 } });
    const agent1 = makeAgentConfig({ id: 'agent1', spawn: { enabled: false } });
    const agent2 = makeAgentConfig({ id: 'agent2' });
    delete (agent2 as any).spawn;
    const agent3 = makeAgentConfig({ id: 'agent3', spawn: { enabled: true, max_parallel: 3 } });

    const resolved = resolveAllAgents(global, [agent1, agent2, agent3]);

    // agent1: explicit opt-out
    expect(resolved.get('agent1')!.spawn.enabled).toBe(false);
    expect(resolved.get('agent1')!.spawn.max_parallel).toBe(5);

    // agent2: no spawn block → migration → enabled=true
    expect(resolved.get('agent2')!.spawn.enabled).toBe(true);
    expect(resolved.get('agent2')!.spawn.max_parallel).toBe(5);

    // agent3: explicit opt-in with custom max_parallel
    expect(resolved.get('agent3')!.spawn.enabled).toBe(true);
    expect(resolved.get('agent3')!.spawn.max_parallel).toBe(3);
  });
});
