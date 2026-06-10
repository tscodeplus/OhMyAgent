import { describe, expect, it, vi } from 'vitest';
import { createSpawnAgentToolDefinition } from '../../src/tools/builtins/agents/spawn-definition.js';
import { DEFAULT_POLICY_SCOPE } from '../../src/policy/types.js';
import type { AgentRun, Orchestrator } from '../../src/orchestrator/types.js';

describe('spawn_agent ToolDefinition orchestrator path', () => {
  it('passes parent context to orchestrator and marks child run completed', async () => {
    const childRun: AgentRun = {
      agentId: 'child-1',
      parentAgentId: 'parent-1',
      rootSessionId: 'session-1',
      role: 'child',
      status: 'running',
      createdAt: Date.now(),
      scope: { ...DEFAULT_POLICY_SCOPE, toolsProfile: 'minimal', computerUseEnabled: false },
    };

    const orchestrator = {
      spawnChildAgent: vi.fn(async () => childRun),
      stopAgent: vi.fn(),
      finishAgent: vi.fn(),
      getAgentRun: vi.fn(() => childRun),
      registerRuntime: vi.fn(),
      unregisterRuntime: vi.fn(),
    } as unknown as Orchestrator;

    const subAgent = {
      prompt: vi.fn(async () => undefined),
      waitForIdle: vi.fn(async () => undefined),
      abort: vi.fn(),
      state: {
        messages: [
          { role: 'assistant', content: [{ type: 'text', text: 'child result' }] },
        ],
      },
    };
    const createAgent = vi.fn(() => subAgent as any);

    const def = createSpawnAgentToolDefinition({
      agentManager: {
        get: vi.fn(() => ({
          id: 'coder',
          name: 'Coder',
          system_prompt: 'code',
          model: {},
          tools: { profile: 'advanced', add: [], deny: [] },
          channels: [],
          memory: {},
          metadata: {},
        })),
        list: vi.fn(() => [{ id: 'coder' }]),
      } as any,
      logger: { error: vi.fn() } as any,
      orchestrator,
      createAgent,
    });

    const result = await def.execute(
      { persona: 'coder', task: 'do work', toolsProfile: 'minimal' },
      {
        cwd: process.cwd(),
        services: {} as any,
        policyScope: DEFAULT_POLICY_SCOPE,
        sessionId: 'session-1',
        agentId: 'parent-1',
      },
    );

    expect(orchestrator.spawnChildAgent).toHaveBeenCalledWith(expect.objectContaining({
      parentAgentId: 'parent-1',
      sessionId: 'session-1',
      prompt: 'do work',
    }));
    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'coder' }),
      'do work',
      expect.objectContaining({
        sessionId: 'session-1',
        agentId: 'child-1',
        policyScope: childRun.scope,
      }),
    );
    expect(orchestrator.finishAgent).toHaveBeenCalledWith('child-1', 'completed', 'child result');
    expect(result.content[0]?.type).toBe('text');
    expect((result.content[0] as any).text).toContain('child result');
  });

  it('returns error BEFORE creating AgentRun when persona is not found', async () => {
    const orchestrator = {
      spawnChildAgent: vi.fn(),
      stopAgent: vi.fn(),
      finishAgent: vi.fn(),
      getAgentRun: vi.fn(),
      registerRuntime: vi.fn(),
      unregisterRuntime: vi.fn(),
    } as unknown as Orchestrator;

    const def = createSpawnAgentToolDefinition({
      agentManager: {
        get: vi.fn((id: string) => id === 'default' ? { id: 'default', name: 'Default', system_prompt: '', model: {}, tools: { profile: 'standard', add: [], deny: [] }, channels: [], memory: {}, metadata: {} } : undefined),
        list: vi.fn(() => [{ id: 'default' }]),
      } as any,
      logger: { error: vi.fn() } as any,
      orchestrator,
      createAgent: vi.fn(),
    });

    const result = await def.execute(
      { persona: 'nonexistent-agent', task: 'do something' },
      {
        cwd: process.cwd(),
        services: {} as any,
        policyScope: DEFAULT_POLICY_SCOPE,
        sessionId: 'session-1',
        agentId: 'parent-1',
      },
    );

    // 不应创建 AgentRun
    expect(orchestrator.spawnChildAgent).not.toHaveBeenCalled();
    // 不应调用 stopAgent（因为没有 AgentRun 需要清理）
    expect(orchestrator.stopAgent).not.toHaveBeenCalled();
    // 应返回错误
    expect(result.isError).toBe(true);
    // 错误信息应包含可用 Agent 列表
    const errorText = (result.content[0] as any).text;
    expect(errorText).toContain('nonexistent-agent');
    expect(errorText).toContain('default');
  });

  it('falls back to parent agent ID when persona is omitted', async () => {
    const childRun: AgentRun = {
      agentId: 'child-2',
      parentAgentId: 'parent-1',
      rootSessionId: 'session-1',
      role: 'child',
      status: 'running',
      createdAt: Date.now(),
      scope: { ...DEFAULT_POLICY_SCOPE, toolsProfile: 'minimal', computerUseEnabled: false },
    };

    const orchestrator = {
      spawnChildAgent: vi.fn(async () => childRun),
      stopAgent: vi.fn(),
      finishAgent: vi.fn(),
      getAgentRun: vi.fn(() => childRun),
      registerRuntime: vi.fn(),
      unregisterRuntime: vi.fn(),
    } as unknown as Orchestrator;

    const subAgent = {
      prompt: vi.fn(async () => undefined),
      waitForIdle: vi.fn(async () => undefined),
      abort: vi.fn(),
      state: { messages: [] },
    };

    const def = createSpawnAgentToolDefinition({
      agentManager: {
        // 当 persona=undefined 时，应 fallback 到 parentAgentId='parent-1'
        get: vi.fn((id: string) => {
          if (id === 'parent-1') return { id: 'parent-1', name: 'Parent', system_prompt: '', model: {}, tools: { profile: 'standard', add: [], deny: [] }, channels: [], memory: {}, metadata: {} };
          return undefined;
        }),
        list: vi.fn(() => [{ id: 'parent-1' }]),
      } as any,
      logger: { error: vi.fn() } as any,
      orchestrator,
      createAgent: vi.fn(() => subAgent as any),
    });

    // 不传 persona
    const result = await def.execute(
      { task: 'do work' },
      {
        cwd: process.cwd(),
        services: {} as any,
        policyScope: DEFAULT_POLICY_SCOPE,
        sessionId: 'session-1',
        agentId: 'parent-1',
      },
    );

    // 应成功创建 AgentRun
    expect(orchestrator.spawnChildAgent).toHaveBeenCalled();
    expect(result.isError).toBeFalsy();
  });
});
