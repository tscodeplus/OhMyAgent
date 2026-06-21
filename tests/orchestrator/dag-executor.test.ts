import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DAGExecutor } from '../../src/orchestrator/dag-executor.js';
import type { PlanAndSpawnInput, SubTaskDef } from '../../src/orchestrator/dag-types.js';
import { DEFAULT_POLICY_SCOPE } from '../../src/policy/types.js';

function makeSubAgent() {
  return {
    prompt: vi.fn(async () => undefined),
    waitForIdle: vi.fn(async () => undefined),
    abort: vi.fn(),
    state: {
      messages: [
        { role: 'assistant', content: [{ type: 'text', text: 'result from child agent' }] },
      ],
    },
  };
}

function makeExecutorDeps(overrides?: Partial<{
  agentManager: any;
  createAgent: any;
  orchestrator: any;
  logger: any;
  maxConcurrency: number;
}>) {
  const childRun = {
    agentId: 'child-1',
    parentAgentId: 'parent-1',
    rootSessionId: 'session-1',
    role: 'child' as const,
    status: 'running' as const,
    createdAt: Date.now(),
    scope: { ...DEFAULT_POLICY_SCOPE, toolsProfile: 'minimal', computerUseEnabled: false },
  };

  return {
    agentManager: overrides?.agentManager ?? {
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
    createAgent: overrides?.createAgent ?? vi.fn(() => makeSubAgent() as any),
    orchestrator: overrides?.orchestrator ?? {
      spawnChildAgent: vi.fn(async () => ({ ...childRun, agentId: `child-${Date.now()}` })),
      stopAgent: vi.fn(),
      finishAgent: vi.fn(),
      getAgentRun: vi.fn(() => childRun),
      registerRuntime: vi.fn(),
      unregisterRuntime: vi.fn(),
    } as any,
    logger: overrides?.logger ?? {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    } as any,
    maxConcurrency: overrides?.maxConcurrency ?? 4,
  };
}

function makeSimpleInput(overrides?: Partial<PlanAndSpawnInput>): PlanAndSpawnInput {
  return {
    task: 'Test plan',
    subtasks: [
      { title: 'Task A', description: 'Do task A' },
      { title: 'Task B', description: 'Do task B' },
    ],
    strategy: 'parallel',
    ...overrides,
  };
}

// ============================================================================
// Graph Validation
// ============================================================================

describe('P4: DAGExecutor — validateGraph', () => {
  it('accepts a valid DAG with no dependencies', async () => {
    const executor = new DAGExecutor(makeExecutorDeps());
    const input = makeSimpleInput();
    const result = await executor.execute(input);
    expect(result.totalSubtasks).toBe(2);
    expect(result.completed).toBe(2);
    expect(result.failed).toBe(0);
  });

  it('accepts a DAG with linear dependencies', async () => {
    const executor = new DAGExecutor(makeExecutorDeps());
    const input = makeSimpleInput({
      subtasks: [
        { title: 'Task A', description: 'First' },
        { title: 'Task B', description: 'Second', dependsOn: ['Task A'] },
      ],
      strategy: 'sequential',
    });
    const result = await executor.execute(input);
    expect(result.completed).toBe(2);
  });

  it('rejects missing dependency reference', async () => {
    const executor = new DAGExecutor(makeExecutorDeps());
    const input = makeSimpleInput({
      subtasks: [
        { title: 'Task A', description: 'First', dependsOn: ['NonexistentTask'] },
      ],
    });
    await expect(executor.execute(input)).rejects.toThrow('depends on unknown');
  });

  it('rejects duplicate subtask titles', async () => {
    const executor = new DAGExecutor(makeExecutorDeps());
    const input = makeSimpleInput({
      subtasks: [
        { title: 'Same', description: 'First' },
        { title: 'Same', description: 'Second' },
      ],
    });
    await expect(executor.execute(input)).rejects.toThrow('Duplicate');
  });

  it('rejects cycles (A → B → A)', async () => {
    const executor = new DAGExecutor(makeExecutorDeps());
    const input = makeSimpleInput({
      subtasks: [
        { title: 'Task A', description: 'First', dependsOn: ['Task B'] },
        { title: 'Task B', description: 'Second', dependsOn: ['Task A'] },
      ],
    });
    await expect(executor.execute(input)).rejects.toThrow('Cycle');
  });

  it('rejects self-dependency', async () => {
    const executor = new DAGExecutor(makeExecutorDeps());
    const input = makeSimpleInput({
      subtasks: [
        { title: 'Task A', description: 'Self-ref', dependsOn: ['Task A'] },
      ],
    });
    await expect(executor.execute(input)).rejects.toThrow('Cycle');
  });

  it('rejects pipeline strategy', async () => {
    const executor = new DAGExecutor(makeExecutorDeps());
    const input = makeSimpleInput({ strategy: 'pipeline' as any });
    await expect(executor.execute(input)).rejects.toThrow('not yet implemented');
  });
});

// ============================================================================
// Parallel Execution
// ============================================================================

describe('P4: DAGExecutor — parallel execution', () => {
  it('executes all independent tasks concurrently', async () => {
    const subAgent = makeSubAgent();
    const createAgent = vi.fn(() => subAgent as any);
    const executor = new DAGExecutor(makeExecutorDeps({ createAgent }));

    const input = makeSimpleInput({
      subtasks: [
        { title: 'A', description: 'Task A' },
        { title: 'B', description: 'Task B' },
        { title: 'C', description: 'Task C' },
      ],
      strategy: 'parallel',
    });

    const result = await executor.execute(input);
    expect(result.completed).toBe(3);
    expect(result.failed).toBe(0);
    expect(createAgent).toHaveBeenCalledTimes(3);
  });

  it('blocks downstream tasks on upstream failure in parallel mode', async () => {
    const failingAgent = {
      prompt: vi.fn(async () => { throw new Error('Task A failed!'); }),
      waitForIdle: vi.fn(async () => undefined),
      abort: vi.fn(),
      state: { messages: [] },
    };
    const normalAgent = makeSubAgent();

    const createAgent = vi.fn()
      .mockReturnValueOnce(failingAgent as any)  // Task A fails
      .mockReturnValue(normalAgent as any);       // Task B should be blocked

    const executor = new DAGExecutor(makeExecutorDeps({ createAgent }));

    const input = makeSimpleInput({
      subtasks: [
        { title: 'A', description: 'Will fail' },
        { title: 'B', description: 'Should be blocked', dependsOn: ['A'] },
      ],
      strategy: 'parallel',
    });

    const result = await executor.execute(input);
    expect(result.failed).toBe(1);
    expect(result.blocked).toBe(1);
  });
});

// ============================================================================
// Sequential Execution
// ============================================================================

describe('P4: DAGExecutor — sequential execution', () => {
  it('executes tasks one at a time in order', async () => {
    const subAgent = makeSubAgent();
    const createAgent = vi.fn(() => subAgent as any);
    const executor = new DAGExecutor(makeExecutorDeps({ createAgent }));

    const input = makeSimpleInput({
      subtasks: [
        { title: 'A', description: 'First' },
        { title: 'B', description: 'Second' },
        { title: 'C', description: 'Third' },
      ],
      strategy: 'sequential',
    });

    const result = await executor.execute(input);
    expect(result.completed).toBe(3);
    expect(createAgent).toHaveBeenCalledTimes(3);
  });

  it('stops on first failure in sequential mode', async () => {
    const failingAgent = {
      prompt: vi.fn(async () => { throw new Error('Failed!'); }),
      waitForIdle: vi.fn(async () => undefined),
      abort: vi.fn(),
      state: { messages: [] },
    };
    const createAgent = vi.fn().mockReturnValue(failingAgent as any);

    const executor = new DAGExecutor(makeExecutorDeps({ createAgent }));

    const input = makeSimpleInput({
      subtasks: [
        { title: 'A', description: 'Will fail' },
        { title: 'B', description: 'Should be blocked' },
      ],
      strategy: 'sequential',
    });

    const result = await executor.execute(input);
    expect(result.failed).toBe(1);
    expect(result.blocked).toBe(1);
    expect(createAgent).toHaveBeenCalledTimes(1); // only Task A spawned
  });
});

// ============================================================================
// Result Summary
// ============================================================================

describe('P4: DAGExecutor — result summary', () => {
  it('returns combined summary with task title', async () => {
    const executor = new DAGExecutor(makeExecutorDeps());
    const input = makeSimpleInput({
      task: 'My custom task',
      subtasks: [
        { title: 'Step 1', description: 'First step' },
        { title: 'Step 2', description: 'Second step' },
      ],
      strategy: 'parallel',
    });

    const result = await executor.execute(input);
    expect(result.task).toBe('My custom task');
    expect(result.strategy).toBe('parallel');
    expect(result.combinedSummary).toContain('My custom task');
    expect(result.combinedSummary).toContain('Step 1');
    expect(result.combinedSummary).toContain('Step 2');
    expect(result.combinedSummary).toContain('2/2');
  });
});

// ============================================================================
// maxConcurrency Enforcement
// ============================================================================

describe('P4: DAGExecutor — maxConcurrency enforcement', () => {
  it('respects maxConcurrency by chunking parallel tasks', async () => {
    // Track how many agents are alive concurrently
    let concurrent = 0;
    let maxConcurrent = 0;

    const slowAgent = {
      prompt: vi.fn(async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        // Simulate work
        await new Promise(r => setTimeout(r, 50));
        concurrent--;
      }),
      waitForIdle: vi.fn(async () => undefined),
      abort: vi.fn(),
      state: {
        messages: [
          { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
        ],
      },
    };

    const createAgent = vi.fn(() => slowAgent as any);

    const executor = new DAGExecutor(makeExecutorDeps({
      createAgent,
      maxConcurrency: 2, // only 2 at a time
    }));

    const input = makeSimpleInput({
      subtasks: [
        { title: 'A', description: 'Task A' },
        { title: 'B', description: 'Task B' },
        { title: 'C', description: 'Task C' },
        { title: 'D', description: 'Task D' },
      ],
      strategy: 'parallel',
    });

    const result = await executor.execute(input);
    expect(result.completed).toBe(4);
    // maxConcurrent should never exceed 2 (one chunk at a time)
    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  it('uses agent-level maxConcurrency when specified', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;

    const slowAgent = {
      prompt: vi.fn(async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise(r => setTimeout(r, 30));
        concurrent--;
      }),
      waitForIdle: vi.fn(async () => undefined),
      abort: vi.fn(),
      state: { messages: [{ role: 'assistant', content: [{ type: 'text', text: 'ok' }] }] },
    };

    const createAgent = vi.fn(() => slowAgent as any);

    const executor = new DAGExecutor(makeExecutorDeps({
      createAgent,
      maxConcurrency: 4, // deps default
    }));

    const input = makeSimpleInput({
      subtasks: [
        { title: 'A', description: 'A' },
        { title: 'B', description: 'B' },
        { title: 'C', description: 'C' },
      ],
      strategy: 'parallel',
      maxConcurrency: 1, // override to 1
    });

    const result = await executor.execute(input);
    expect(result.completed).toBe(3);
    expect(maxConcurrent).toBe(1);
  });
});
