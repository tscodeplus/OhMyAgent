// ---------------------------------------------------------------------------
// TaskRunStore interface + InMemoryTaskRunStore
// ---------------------------------------------------------------------------

import type { TaskRun, CreateTaskRunInput } from './types.js';

export interface TaskRunStore {
  create(input: CreateTaskRunInput): TaskRun;
  update(taskId: string, patch: Partial<TaskRun>): TaskRun | undefined;
  get(taskId: string): TaskRun | undefined;
  listBySession(sessionId: string): TaskRun[];
  listByOwner(ownerAgentId: string): TaskRun[];
  delete(taskId: string): boolean;
}

export class InMemoryTaskRunStore implements TaskRunStore {
  private tasks = new Map<string, TaskRun>();

  create(input: CreateTaskRunInput): TaskRun {
    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const run: TaskRun = {
      taskId,
      ownerAgentId: input.ownerAgentId,
      sessionId: input.sessionId,
      parentTaskId: input.parentTaskId,
      title: input.title,
      description: input.description,
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.tasks.set(run.taskId, run);
    return run;
  }

  update(taskId: string, patch: Partial<TaskRun>): TaskRun | undefined {
    const existing = this.tasks.get(taskId);
    if (!existing) return undefined;
    Object.assign(existing, patch, { updatedAt: Date.now() });
    return existing;
  }

  get(taskId: string): TaskRun | undefined { return this.tasks.get(taskId); }

  listBySession(sessionId: string): TaskRun[] {
    return [...this.tasks.values()].filter(t => t.sessionId === sessionId);
  }

  listByOwner(ownerAgentId: string): TaskRun[] {
    return [...this.tasks.values()].filter(t => t.ownerAgentId === ownerAgentId);
  }

  delete(taskId: string): boolean { return this.tasks.delete(taskId); }
}
