// ---------------------------------------------------------------------------
// Tests for task tools (P6-T1)
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach } from 'vitest';
import { createTaskCreateToolDefinition } from '../../../src/tools/builtins/tasks/create-definition.js';
import { createTaskGetToolDefinition } from '../../../src/tools/builtins/tasks/get-definition.js';
import { createTaskListToolDefinition } from '../../../src/tools/builtins/tasks/list-definition.js';
import { createTaskStopToolDefinition } from '../../../src/tools/builtins/tasks/stop-definition.js';
import { createTaskOutputToolDefinition } from '../../../src/tools/builtins/tasks/output-definition.js';
import { createTaskUpdateToolDefinition } from '../../../src/tools/builtins/tasks/update-definition.js';
import type { ToolExecutionContext } from '../../../src/tools/platform/tool-context.js';
import type { Orchestrator, TaskRun } from '../../../src/orchestrator/types.js';
import { extractToolText, expectToolResultContains } from '../../helpers/tool-result.js';

// ---------------------------------------------------------------------------
// In-memory orchestrator mock
// ---------------------------------------------------------------------------

class MockOrchestrator implements Orchestrator {
  private tasks = new Map<string, TaskRun>();
  private nextId = 1;
  private agents = new Map<string, any>();

  async createTask(input: { ownerAgentId: string; sessionId: string; title: string; description: string; assignToAgentId?: string; parentTaskId?: string }): Promise<TaskRun> {
    const taskId = `task-${this.nextId++}`;
    const task: TaskRun = {
      taskId,
      ownerAgentId: input.ownerAgentId,
      sessionId: input.sessionId,
      title: input.title,
      description: input.description,
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.tasks.set(taskId, task);
    return task;
  }

  async getTask(taskId: string): Promise<TaskRun | null> {
    return this.tasks.get(taskId) ?? null;
  }

  async listTasks(sessionId: string): Promise<TaskRun[]> {
    return [...this.tasks.values()].filter(t => t.sessionId === sessionId);
  }

  async updateTask(taskId: string, patch: Partial<TaskRun>): Promise<TaskRun | null> {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    Object.assign(task, patch, { updatedAt: Date.now() });
    return task;
  }

  async stopAgent(agentId: string): Promise<void> {
    this.agents.set(agentId, { status: 'stopped' });
  }

  async collectResults(parentAgentId: string): Promise<any[]> {
    return [
      { agentId: `${parentAgentId}-child-1`, status: 'completed', summary: 'Task completed successfully.' },
      { agentId: `${parentAgentId}-child-2`, status: 'failed', error: 'Something went wrong.' },
    ];
  }

  spawnChildAgent(input: any): Promise<any> { throw new Error('Not implemented'); }
  sendMessage(input: any): Promise<void> { throw new Error('Not implemented'); }
  getAgentRun(_agentId: string): any { return undefined; }
  listAgentRuns(_sessionId: string): any[] { return []; }
  routeApprovalToParent(_approval: any, _parentSessionId: string): Promise<void> { throw new Error('Not implemented'); }
  finishAgent(_agentId: string, _status: 'completed' | 'failed', _detail?: string): Promise<void> { throw new Error('Not implemented'); }
  getMessages(_agentId?: string): any[] { return []; }

  /** Expose internal state for test inspection. */
  _getTasks(): Map<string, TaskRun> { return this.tasks; }
  _isAgentStopped(agentId: string): boolean {
    return this.agents.get(agentId)?.status === 'stopped';
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeCtx(orchestrator?: Orchestrator): ToolExecutionContext {
  return {
    cwd: '/tmp',
    sessionId: 'test-session-1',
    agentId: 'test-agent',
    policyScope: { agentId: 'test' } as any,
    services: {
      orchestrator,
    } as any,
  };
}

// ===========================================================================
// task_create
// ===========================================================================

describe('task_create', () => {
  it('creates a task and returns formatted details', async () => {
    const orchestrator = new MockOrchestrator();
    const tool = createTaskCreateToolDefinition();
    const result = await tool.execute(
      { title: 'Implement login', description: 'Build login page with OAuth' },
      makeCtx(orchestrator),
    );

    expect(result.isError).toBeFalsy();
    const text = extractToolText(result);
    expect(text).toContain('Task Created');
    expect(text).toContain('Implement login');
    expect(text).toContain('Build login page with OAuth');
    expect(text).toContain('pending');
  });

  it('returns error when orchestrator is not available', async () => {
    const tool = createTaskCreateToolDefinition();
    const result = await tool.execute(
      { title: 'Test', description: 'Test' },
      makeCtx(undefined),
    );

    expect(result.isError).toBeTruthy();
    expectToolResultContains(result, 'Orchestrator not available');
  });
});

// ===========================================================================
// task_get
// ===========================================================================

describe('task_get', () => {
  let orchestrator: MockOrchestrator;
  let taskId: string;

  beforeEach(async () => {
    orchestrator = new MockOrchestrator();
    const task = await orchestrator.createTask({
      ownerAgentId: 'agent-1',
      sessionId: 'test-session-1',
      title: 'My Task',
      description: 'My description',
    });
    taskId = task.taskId;
  });

  it('retrieves a task by ID and shows status and title', async () => {
    const tool = createTaskGetToolDefinition();
    const result = await tool.execute({ taskId }, makeCtx(orchestrator));

    expect(result.isError).toBeFalsy();
    const text = extractToolText(result);
    expect(text).toContain('My Task');
    expect(text).toContain(taskId);
    expect(text).toContain('pending');
  });

  it('returns error for non-existent task', async () => {
    const tool = createTaskGetToolDefinition();
    const result = await tool.execute({ taskId: 'nonexistent-task' }, makeCtx(orchestrator));

    expect(result.isError).toBeTruthy();
    expectToolResultContains(result, 'not found');
  });

  it('does not return a task from another session', async () => {
    const orchestrator = new MockOrchestrator();
    const task = await orchestrator.createTask({
      ownerAgentId: 'agent-1',
      sessionId: 'other-session',
      title: 'Other Task',
      description: 'Hidden',
    });

    const tool = createTaskGetToolDefinition();
    const result = await tool.execute({ taskId: task.taskId }, makeCtx(orchestrator));

    expect(result.isError).toBeTruthy();
    expectToolResultContains(result, 'not found in this session');
  });
});

// ===========================================================================
// task_list
// ===========================================================================

describe('task_list', () => {
  it('lists tasks grouped by status with counts', async () => {
    const orchestrator = new MockOrchestrator();
    // Create tasks with different statuses
    const t1 = await orchestrator.createTask({ ownerAgentId: 'a1', sessionId: 'test-session-1', title: 'Task Pending', description: '' });
    await orchestrator.updateTask(t1.taskId, { status: 'pending' } as any);
    const t2 = await orchestrator.createTask({ ownerAgentId: 'a1', sessionId: 'test-session-1', title: 'Task Running', description: '' });
    await orchestrator.updateTask(t2.taskId, { status: 'running' } as any);
    const t3 = await orchestrator.createTask({ ownerAgentId: 'a1', sessionId: 'test-session-1', title: 'Task Completed', description: '' });
    await orchestrator.updateTask(t3.taskId, { status: 'completed' } as any);

    const tool = createTaskListToolDefinition();
    const result = await tool.execute({}, makeCtx(orchestrator));

    expect(result.isError).toBeFalsy();
    const text = extractToolText(result);
    expect(text).toContain('Pending (1)');
    expect(text).toContain('Running (1)');
    expect(text).toContain('Completed (1)');
    expect(text).toContain('Task Pending');
    expect(text).toContain('Task Running');
    expect(text).toContain('Task Completed');
    expect(text).toContain('Total: 3 tasks');
  });

  it('shows empty message when no tasks exist', async () => {
    const orchestrator = new MockOrchestrator();
    const tool = createTaskListToolDefinition();

    // Use a session with no tasks
    const ctx = makeCtx(orchestrator);
    ctx.sessionId = 'empty-session';
    const result = await tool.execute({}, ctx);

    expect(result.isError).toBeFalsy();
    expectToolResultContains(result, 'No tasks found');
  });
});

// ===========================================================================
// task_stop
// ===========================================================================

describe('task_stop', () => {
  it('stops the associated agent and returns confirmation', async () => {
    const orchestrator = new MockOrchestrator();
    const task = await orchestrator.createTask({
      ownerAgentId: 'agent-to-stop',
      sessionId: 'test-session-1',
      title: 'Task to Stop',
      description: '',
    });

    const tool = createTaskStopToolDefinition();
    const result = await tool.execute({ taskId: task.taskId }, makeCtx(orchestrator));

    expect(result.isError).toBeFalsy();
    const text = extractToolText(result);
    expect(text).toContain('Task Stopped');
    expect(text).toContain('Task to Stop');
    expect(orchestrator._isAgentStopped('agent-to-stop')).toBeTruthy();
    expect((await orchestrator.getTask(task.taskId))?.status).toBe('stopped');
  });

  it('returns error for non-existent task', async () => {
    const orchestrator = new MockOrchestrator();
    const tool = createTaskStopToolDefinition();
    const result = await tool.execute({ taskId: 'nonexistent' }, makeCtx(orchestrator));

    expect(result.isError).toBeTruthy();
    expectToolResultContains(result, 'not found');
  });

  it('does not update a task from another session', async () => {
    const orchestrator = new MockOrchestrator();
    const task = await orchestrator.createTask({
      ownerAgentId: 'agent-upd',
      sessionId: 'other-session',
      title: 'Old Title',
      description: 'Old description',
    });

    const tool = createTaskUpdateToolDefinition();
    const result = await tool.execute(
      { taskId: task.taskId, title: 'New Title' },
      makeCtx(orchestrator),
    );

    expect(result.isError).toBeTruthy();
    expectToolResultContains(result, 'not found in this session');
    expect((await orchestrator.getTask(task.taskId))?.title).toBe('Old Title');
  });
});

// ===========================================================================
// task_output
// ===========================================================================

describe('task_output', () => {
  it('returns resultSummary when available', async () => {
    const orchestrator = new MockOrchestrator();
    const task = await orchestrator.createTask({
      ownerAgentId: 'agent-output',
      sessionId: 'test-session-1',
      title: 'Output Task',
      description: '',
    });
    await orchestrator.updateTask(task.taskId, { resultSummary: 'This is the result summary.' } as any);

    const tool = createTaskOutputToolDefinition();
    const result = await tool.execute({ taskId: task.taskId }, makeCtx(orchestrator));

    expect(result.isError).toBeFalsy();
    const text = extractToolText(result);
    expect(text).toContain('Output Task');
    expect(text).toContain('This is the result summary.');
  });

  it('collects child agent results when no resultSummary', async () => {
    const orchestrator = new MockOrchestrator();
    const task = await orchestrator.createTask({
      ownerAgentId: 'agent-collect',
      sessionId: 'test-session-1',
      title: 'Collect Task',
      description: '',
    });

    const tool = createTaskOutputToolDefinition();
    const result = await tool.execute({ taskId: task.taskId }, makeCtx(orchestrator));

    expect(result.isError).toBeFalsy();
    const text = extractToolText(result);
    expect(text).toContain('Collect Task');
    expect(text).toContain('agent-collect-child-1');
    expect(text).toContain('Task completed successfully');
    expect(text).toContain('agent-collect-child-2');
    expect(text).toContain('Something went wrong');
  });
});

// ===========================================================================
// task_update
// ===========================================================================

describe('task_update', () => {
  it('updates task title and status', async () => {
    const orchestrator = new MockOrchestrator();
    const task = await orchestrator.createTask({
      ownerAgentId: 'agent-upd',
      sessionId: 'test-session-1',
      title: 'Old Title',
      description: 'Old description',
    });

    const tool = createTaskUpdateToolDefinition();
    const result = await tool.execute(
      { taskId: task.taskId, title: 'New Title', status: 'running' },
      makeCtx(orchestrator),
    );

    expect(result.isError).toBeFalsy();
    const text = extractToolText(result);
    expect(text).toContain('Task Updated');
    expect(text).toContain('New Title');
    expect(text).toContain('running');

    // Verify the task was actually updated
    const updated = await orchestrator.getTask(task.taskId);
    expect(updated?.title).toBe('New Title');
    expect(updated?.status).toBe('running');
  });

  it('returns error for non-existent task', async () => {
    const orchestrator = new MockOrchestrator();
    const tool = createTaskUpdateToolDefinition();
    const result = await tool.execute(
      { taskId: 'nonexistent', title: 'Nope' },
      makeCtx(orchestrator),
    );

    expect(result.isError).toBeTruthy();
    expectToolResultContains(result, 'not found');
  });
});
