// ---------------------------------------------------------------------------
// v4 Orchestrator — implementation skeleton
// ---------------------------------------------------------------------------

import type {
  Orchestrator, AgentRun, TaskRun, AgentResultSummary, AgentMessage,
  SpawnChildAgentInput, CreateTaskInput, SendAgentMessageInput, ManagedAgentRuntime,
} from './types.js';
import type { AgentRunStore } from './agent-run-store.js';
import type { TaskRunStore } from './task-run-store.js';
import type { PermissionInheritanceService } from './permission-inheritance.js';
import type { ApprovalStateSync } from './approval-state-sync.js';
import type { PolicyCenter } from '../policy/policy-center.js';
import type { AgentFactory } from '../agent/agent-factory.js';
import type { AgentManager } from '../agent/agent-manager.js';
import type { PendingApprovalStore } from '../agent/approval-store.js';
import type { Logger } from 'pino';
import { DEFAULT_POLICY_SCOPE } from '../policy/types.js';

export type { Orchestrator } from './types.js';

export interface OrchestratorDeps {
  agentRunStore: AgentRunStore;
  taskRunStore: TaskRunStore;
  permissionInheritance: PermissionInheritanceService;
  approvalStateSync: ApprovalStateSync;
  policyCenter: PolicyCenter;
  agentFactory: AgentFactory;
  agentManager: AgentManager;
  pendingApprovals: PendingApprovalStore;
  logger: Logger;
}

export class OrchestratorImpl implements Orchestrator {
  private deps: OrchestratorDeps;
  private messageLog: AgentMessage[] = [];
  private runtimes = new Map<string, ManagedAgentRuntime>();

  constructor(deps: OrchestratorDeps) { this.deps = deps; }

  async spawnChildAgent(input: SpawnChildAgentInput): Promise<AgentRun> {
    // 1. Get parent AgentRun
    let parent = this.deps.agentRunStore.get(input.parentAgentId);
    if (!parent) {
      // Create a parent AgentRun if it doesn't exist (for primary agent)
      parent = this.deps.agentRunStore.create({
        agentId: input.parentAgentId,
        rootSessionId: input.sessionId,
        role: 'primary',
        scope: DEFAULT_POLICY_SCOPE,
        prompt: '',
      });
    }

    // 2. Derive child scope via permission inheritance
    const childScope = this.deps.permissionInheritance.deriveChildScope(parent, input.requestedScope);

    // 3. Create child AgentRun
    const childAgentId = `child-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const childRun = this.deps.agentRunStore.create({
      agentId: childAgentId,
      parentAgentId: input.parentAgentId,
      rootSessionId: input.sessionId,
      role: 'child',
      scope: childScope,
      prompt: input.prompt,
    });

    // 4. Update status to running
    this.deps.agentRunStore.update(childAgentId, { status: 'running', startedAt: Date.now() });

    return childRun;
  }

  async stopAgent(agentId: string): Promise<void> {
    // F4: Real agent abort — check runtimes map for managed runtime
    const runtime = this.runtimes.get(agentId);
    if (runtime) {
      runtime.abort();
      // Graceful give-up after 10s (resolve, not reject). clearTimeout so the
      // timer doesn't outlive a fast waitForIdle and keep the loop alive.
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          runtime.waitForIdle(),
          new Promise<void>((resolve) => { idleTimer = setTimeout(resolve, 10_000); }),
        ]);
      } finally {
        if (idleTimer !== undefined) clearTimeout(idleTimer);
      }
      this.unregisterRuntime(agentId);
    }
    this.deps.agentRunStore.update(agentId, { status: 'stopped', finishedAt: Date.now() });
  }

  async createTask(input: CreateTaskInput): Promise<TaskRun> {
    return this.deps.taskRunStore.create({
      ownerAgentId: input.assignToAgentId ?? input.ownerAgentId,
      sessionId: input.sessionId,
      title: input.title,
      description: input.description,
      parentTaskId: input.parentTaskId,
    });
  }

  async listTasks(sessionId: string): Promise<TaskRun[]> {
    return this.deps.taskRunStore.listBySession(sessionId);
  }

  async getTask(taskId: string): Promise<TaskRun | null> {
    return this.deps.taskRunStore.get(taskId) ?? null;
  }

  async updateTask(taskId: string, patch: Partial<TaskRun>): Promise<TaskRun | null> {
    return this.deps.taskRunStore.update(taskId, patch) ?? null;
  }

  async sendMessage(input: SendAgentMessageInput): Promise<void> {
    // Validate: target agent must exist in current root session
    const target = this.deps.agentRunStore.get(input.toAgentId);
    if (!target) {
      throw new Error(`Target agent "${input.toAgentId}" not found`);
    }
    if (target.rootSessionId !== input.sessionId) {
      throw new Error('Cross-session messaging is not allowed');
    }

    // Validate: sender and target must share root session
    const sender = this.deps.agentRunStore.get(input.fromAgentId);
    if (sender && sender.rootSessionId !== target.rootSessionId) {
      throw new Error('Cross-session messaging is not allowed');
    }
    if (sender && sender.rootSessionId !== input.sessionId) {
      throw new Error('Cross-session messaging is not allowed');
    }

    // Construct AgentMessage
    const message: AgentMessage = {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      fromAgentId: input.fromAgentId,
      toAgentId: input.toAgentId,
      sessionId: input.sessionId,
      kind: input.kind,
      content: input.content,
      createdAt: Date.now(),
    };

    // Route based on kind
    if (input.kind === 'instruction' || input.kind === 'status' || input.kind === 'result') {
      // Internal: store in message log, no user visibility
      this.messageLog.push(message);
    } else {
      // External (question): store in message log
      // Full PolicyCenter gating deferred to Phase 7
      this.messageLog.push(message);
    }
  }

  getMessages(agentId?: string): AgentMessage[] {
    if (agentId) {
      return this.messageLog.filter(
        m => m.fromAgentId === agentId || m.toAgentId === agentId,
      );
    }
    return [...this.messageLog];
  }

  async collectResults(parentAgentId: string): Promise<AgentResultSummary[]> {
    const children = this.deps.agentRunStore.listByParent(parentAgentId);
    return children.map(child => ({
      agentId: child.agentId,
      status: child.status,
      summary: child.statusDetail,
    }));
  }

  getAgentRun(agentId: string): AgentRun | undefined {
    return this.deps.agentRunStore.get(agentId);
  }

  listAgentRuns(sessionId: string): AgentRun[] {
    return this.deps.agentRunStore.listBySession(sessionId);
  }

  async routeApprovalToParent(_approval: any, _parentSessionId: string): Promise<void> {
    await this.deps.approvalStateSync.routeApproval(_approval, _parentSessionId);
  }

  async finishAgent(agentId: string, status: 'completed' | 'failed', detail?: string): Promise<void> {
    this.deps.agentRunStore.update(agentId, {
      status,
      statusDetail: detail,
      finishedAt: Date.now(),
    });
    this.unregisterRuntime(agentId);
  }

  registerRuntime(runtime: ManagedAgentRuntime): void {
    this.runtimes.set(runtime.agentId, runtime);
  }

  unregisterRuntime(agentId: string): void {
    this.runtimes.delete(agentId);
  }
}
