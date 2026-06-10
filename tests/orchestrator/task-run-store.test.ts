import { describe, it, expect } from 'vitest';
import { InMemoryTaskRunStore } from '../../src/orchestrator/task-run-store.js';
import type { CreateTaskRunInput } from '../../src/orchestrator/types.js';

function makeInput(overrides?: Partial<CreateTaskRunInput>): CreateTaskRunInput {
  return {
    ownerAgentId: 'agent-owner-1',
    title: 'Test Task',
    description: 'A task for testing',
    sessionId: 'session-test-1',
    ...overrides,
  };
}

describe('InMemoryTaskRunStore', () => {
  it('create stores a TaskRun and returns it', () => {
    const store = new InMemoryTaskRunStore();
    const input = makeInput();
    const task = store.create(input);

    expect(task.taskId).toBeDefined();
    expect(task.taskId).toMatch(/^task-/);
    expect(task.ownerAgentId).toBe(input.ownerAgentId);
    expect(task.sessionId).toBe(input.sessionId);
    expect(task.title).toBe('Test Task');
    expect(task.description).toBe('A task for testing');
    expect(task.status).toBe('pending');
    expect(task.createdAt).toBeGreaterThan(0);
    expect(task.updatedAt).toBeGreaterThan(0);
  });

  it('create accepts optional parentTaskId', () => {
    const store = new InMemoryTaskRunStore();
    const task = store.create(makeInput({ parentTaskId: 'parent-task-1' }));
    expect(task.parentTaskId).toBe('parent-task-1');
  });

  it('get returns undefined for unknown taskId', () => {
    const store = new InMemoryTaskRunStore();
    expect(store.get('nonexistent')).toBeUndefined();
  });

  it('get returns the stored TaskRun', () => {
    const store = new InMemoryTaskRunStore();
    const created = store.create(makeInput());
    const retrieved = store.get(created.taskId);

    expect(retrieved).toBeDefined();
    expect(retrieved!.taskId).toBe(created.taskId);
    expect(retrieved!.title).toBe('Test Task');
  });

  it('update patches fields and updates updatedAt', () => {
    const store = new InMemoryTaskRunStore();
    const task = store.create(makeInput());
    const originalUpdatedAt = task.updatedAt;

    // Small delay to ensure timestamp changes
    const updated = store.update(task.taskId, { status: 'running' });
    expect(updated).toBeDefined();
    expect(updated!.status).toBe('running');
    expect(updated!.updatedAt).toBeGreaterThanOrEqual(originalUpdatedAt);
  });

  it('update returns undefined for unknown taskId', () => {
    const store = new InMemoryTaskRunStore();
    expect(store.update('nonexistent', { status: 'running' })).toBeUndefined();
  });

  it('update supports status transitions', () => {
    const store = new InMemoryTaskRunStore();
    const task = store.create(makeInput());

    expect(task.status).toBe('pending');

    store.update(task.taskId, { status: 'running' });
    expect(store.get(task.taskId)!.status).toBe('running');

    store.update(task.taskId, { status: 'completed', resultSummary: 'all done' });
    const final = store.get(task.taskId)!;
    expect(final.status).toBe('completed');
    expect(final.resultSummary).toBe('all done');
  });

  it('listByOwner returns only tasks owned by the given agent', () => {
    const store = new InMemoryTaskRunStore();
    store.create(makeInput({ ownerAgentId: 'owner-a', title: 'Task A1' }));
    store.create(makeInput({ ownerAgentId: 'owner-a', title: 'Task A2' }));
    store.create(makeInput({ ownerAgentId: 'owner-b', title: 'Task B1' }));

    expect(store.listByOwner('owner-a')).toHaveLength(2);
    expect(store.listByOwner('owner-b')).toHaveLength(1);
    expect(store.listByOwner('nonexistent')).toHaveLength(0);
  });

  it('listBySession returns only tasks for the given session', () => {
    const store = new InMemoryTaskRunStore();
    store.create(makeInput({ sessionId: 'session-a', title: 'Task A1' }));
    store.create(makeInput({ sessionId: 'session-a', title: 'Task A2' }));
    store.create(makeInput({ sessionId: 'session-b', title: 'Task B1' }));

    expect(store.listBySession('session-a')).toHaveLength(2);
    expect(store.listBySession('session-b')).toHaveLength(1);
    expect(store.listBySession('missing')).toHaveLength(0);
  });

  it('delete removes the task and returns true', () => {
    const store = new InMemoryTaskRunStore();
    const task = store.create(makeInput());
    expect(store.get(task.taskId)).toBeDefined();
    expect(store.delete(task.taskId)).toBe(true);
    expect(store.get(task.taskId)).toBeUndefined();
  });

  it('delete returns false for nonexistent taskId', () => {
    const store = new InMemoryTaskRunStore();
    expect(store.delete('nonexistent')).toBe(false);
  });
});
