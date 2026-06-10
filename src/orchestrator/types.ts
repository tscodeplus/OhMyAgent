// ---------------------------------------------------------------------------
// v4 Orchestrator — core entity types
// ---------------------------------------------------------------------------

import type { AgentPolicyScope } from '../policy/types.js';

// ---------------------------------------------------------------------------
// AgentRun
// ---------------------------------------------------------------------------

export interface AgentRun {
  agentId: string;
  parentAgentId?: string;
  rootSessionId: string;
  role: 'primary' | 'child';
  status: 'pending' | 'running' | 'waiting_for_approval' | 'waiting_for_input' | 'completed' | 'failed' | 'stopped';
  statusDetail?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  scope: AgentPolicyScope;
}

// ---------------------------------------------------------------------------
// TaskRun
// ---------------------------------------------------------------------------

export interface TaskRun {
  taskId: string;
  ownerAgentId: string;
  sessionId: string;
  parentTaskId?: string;
  title: string;
  description: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'stopped';
  createdAt: number;
  updatedAt: number;
  resultSummary?: string;
}

// ---------------------------------------------------------------------------
// TeamRun
// ---------------------------------------------------------------------------

export interface TeamRun {
  teamId: string;
  rootSessionId: string;
  ownerAgentId: string;
  memberAgentIds: string[];
  createdAt: number;
  status: 'active' | 'closed';
}

// ---------------------------------------------------------------------------
// AgentMessage
// ---------------------------------------------------------------------------

export interface AgentMessage {
  id: string;
  fromAgentId: string;
  toAgentId: string;
  sessionId: string;
  kind: 'instruction' | 'status' | 'result' | 'question';
  content: string;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Result summary
// ---------------------------------------------------------------------------

export interface AgentResultSummary {
  agentId: string;
  status: AgentRun['status'];
  summary?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Orchestrator inputs
// ---------------------------------------------------------------------------

export interface SpawnChildAgentInput {
  parentAgentId: string;
  sessionId: string;
  prompt: string;
  requestedScope: import('../policy/types.js').ChildAgentPolicyRequest;
}

export interface CreateTaskInput {
  sessionId: string;
  ownerAgentId: string;
  title: string;
  description: string;
  parentTaskId?: string;
  assignToAgentId?: string;
}

export interface SendAgentMessageInput {
  fromAgentId: string;
  toAgentId: string;
  sessionId: string;
  kind: AgentMessage['kind'];
  content: string;
}

// ---------------------------------------------------------------------------
// Factory input types
// ---------------------------------------------------------------------------

/** Factory input for creating an AgentRun. */
export interface CreateAgentRunInput {
  agentId: string;
  parentAgentId?: string;
  rootSessionId: string;
  role: 'primary' | 'child';
  scope: import('../policy/types.js').AgentPolicyScope;
  prompt: string;
}

/** Factory input for creating a TaskRun. */
export interface CreateTaskRunInput {
  ownerAgentId: string;
  parentTaskId?: string;
  title: string;
  description: string;
  sessionId: string;
}

// ---------------------------------------------------------------------------
// ManagedAgentRuntime
// ---------------------------------------------------------------------------

export interface ManagedAgentRuntime {
  agentId: string;
  sessionId: string;
  abort(): void;
  waitForIdle(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Orchestrator interface
// ---------------------------------------------------------------------------

export interface Orchestrator {
  spawnChildAgent(input: SpawnChildAgentInput): Promise<AgentRun>;
  stopAgent(agentId: string): Promise<void>;
  createTask(input: CreateTaskInput): Promise<TaskRun>;
  listTasks(sessionId: string): Promise<TaskRun[]>;
  getTask(taskId: string): Promise<TaskRun | null>;
  updateTask(taskId: string, patch: Partial<TaskRun>): Promise<TaskRun | null>;
  sendMessage(input: SendAgentMessageInput): Promise<void>;
  collectResults(parentAgentId: string): Promise<AgentResultSummary[]>;

  /** Get message history, optionally filtered by agent ID. */
  getMessages(agentId?: string): AgentMessage[];
  /** Get a single AgentRun by ID. */
  getAgentRun(agentId: string): AgentRun | undefined;
  /** List all AgentRuns for a root session. */
  listAgentRuns(sessionId: string): AgentRun[];
  /** Route a child agent's approval request to the parent session UI. */
  routeApprovalToParent(approval: import('../policy/types.js').ApprovalRequest, parentSessionId: string): Promise<void>;
  /** Mark an agent run as completed or failed. */
  finishAgent(agentId: string, status: 'completed' | 'failed', detail?: string): Promise<void>;
  /** Register a managed runtime for real abort support. */
  registerRuntime(runtime: ManagedAgentRuntime): void;
  /** Unregister a managed runtime. */
  unregisterRuntime(agentId: string): void;
}
