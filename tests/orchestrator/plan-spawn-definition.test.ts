import { describe, it, expect, vi } from 'vitest';
import { createPlanAndSpawnToolDefinition } from '../../src/tools/builtins/agents/plan-spawn-definition.js';
import { DEFAULT_POLICY_SCOPE } from '../../src/policy/types.js';

describe('plan_and_spawn ToolDefinition', () => {
  const childRun = {
    agentId: 'child-1',
    parentAgentId: 'parent-1',
    rootSessionId: 'session-1',
    role: 'child' as const,
    status: 'running' as const,
    createdAt: Date.now(),
    scope: { ...DEFAULT_POLICY_SCOPE, toolsProfile: 'minimal', computerUseEnabled: false },
  };

  function makeSubAgent() {
    return {
      prompt: vi.fn(async () => undefined),
      waitForIdle: vi.fn(async () => undefined),
      abort: vi.fn(),
      state: {
        messages: [
          { role: 'assistant', content: [{ type: 'text', text: 'child result' }] },
        ],
      },
    };
  }

  function makeDeps(overrides?: any) {
    return {
      agentManager: {
        get: vi.fn(() => ({
          id: 'default',
          name: 'Default',
          system_prompt: '',
          model: {},
          tools: { profile: 'advanced', add: [], deny: [] },
          channels: [],
          memory: {},
          metadata: {},
        })),
        list: vi.fn(() => [{ id: 'default' }]),
      } as any,
      orchestrator: {
        spawnChildAgent: vi.fn(async () => ({ ...childRun, agentId: `child-${Date.now()}` })),
        stopAgent: vi.fn(),
        finishAgent: vi.fn(),
        getAgentRun: vi.fn(() => childRun),
        registerRuntime: vi.fn(),
        unregisterRuntime: vi.fn(),
      } as any,
      createAgent: vi.fn(() => makeSubAgent() as any),
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as any,
      maxConcurrency: 4,
      ...overrides,
    };
  }

  it('executes a simple parallel plan successfully', async () => {
    const def = createPlanAndSpawnToolDefinition(makeDeps());
    const result = await def.execute(
      {
        task: 'Test task',
        subtasks: [
          { title: 'A', description: 'Task A' },
          { title: 'B', description: 'Task B' },
        ],
        strategy: 'parallel',
      },
      {
        cwd: process.cwd(),
        services: {} as any,
        policyScope: DEFAULT_POLICY_SCOPE,
        sessionId: 'session-1',
        agentId: 'parent-1',
      },
    );

    expect(result.isError).toBeFalsy();
    expect((result.content[0] as any).text).toContain('Test task');
    expect((result.content[0] as any).text).toContain('2/2');
  });

  it('returns error when subtasks array is empty', async () => {
    const def = createPlanAndSpawnToolDefinition(makeDeps());
    const result = await def.execute(
      { task: 'Empty', subtasks: [], strategy: 'parallel' },
      {
        cwd: process.cwd(),
        services: {} as any,
        policyScope: DEFAULT_POLICY_SCOPE,
        sessionId: 'session-1',
        agentId: 'parent-1',
      },
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain('non-empty');
  });

  it('returns error when task is missing', async () => {
    const def = createPlanAndSpawnToolDefinition(makeDeps());
    const result = await def.execute(
      { task: '', subtasks: [{ title: 'A', description: 'A' }], strategy: 'parallel' },
      {
        cwd: process.cwd(),
        services: {} as any,
        policyScope: DEFAULT_POLICY_SCOPE,
        sessionId: 'session-1',
        agentId: 'parent-1',
      },
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain('task');
  });

  it('rejects more than 20 subtasks', async () => {
    const def = createPlanAndSpawnToolDefinition(makeDeps());
    const tooMany = Array.from({ length: 21 }, (_, i) => ({
      title: `Task ${i}`,
      description: `Description ${i}`,
    }));
    const result = await def.execute(
      { task: 'Too many', subtasks: tooMany, strategy: 'parallel' },
      {
        cwd: process.cwd(),
        services: {} as any,
        policyScope: DEFAULT_POLICY_SCOPE,
        sessionId: 'session-1',
        agentId: 'parent-1',
      },
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain('20');
  });

  it('handles DAG dependency validation error gracefully', async () => {
    const def = createPlanAndSpawnToolDefinition(makeDeps());
    const result = await def.execute(
      {
        task: 'Bad deps',
        subtasks: [
          { title: 'A', description: 'A', dependsOn: ['B'] },
          { title: 'B', description: 'B', dependsOn: ['A'] },
        ],
        strategy: 'parallel',
      },
      {
        cwd: process.cwd(),
        services: {} as any,
        policyScope: DEFAULT_POLICY_SCOPE,
        sessionId: 'session-1',
        agentId: 'parent-1',
      },
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain('Cycle');
  });
});
