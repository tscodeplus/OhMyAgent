// ---------------------------------------------------------------------------
// AgentRunStore interface + InMemoryAgentRunStore
// ---------------------------------------------------------------------------

import type { AgentRun, CreateAgentRunInput } from './types.js';

export interface AgentRunStore {
  create(input: CreateAgentRunInput): AgentRun;
  update(agentId: string, patch: Partial<AgentRun>): AgentRun | undefined;
  get(agentId: string): AgentRun | undefined;
  listBySession(sessionId: string): AgentRun[];
  listByParent(parentAgentId: string): AgentRun[];
  delete(agentId: string): boolean;
}

export class InMemoryAgentRunStore implements AgentRunStore {
  private runs = new Map<string, AgentRun>();

  create(input: CreateAgentRunInput): AgentRun {
    const run: AgentRun = {
      agentId: input.agentId,
      parentAgentId: input.parentAgentId,
      rootSessionId: input.rootSessionId,
      role: input.role,
      status: 'pending',
      createdAt: Date.now(),
      scope: input.scope,
    };
    this.runs.set(run.agentId, run);
    return run;
  }

  update(agentId: string, patch: Partial<AgentRun>): AgentRun | undefined {
    const existing = this.runs.get(agentId);
    if (!existing) return undefined;
    Object.assign(existing, patch);
    return existing;
  }

  get(agentId: string): AgentRun | undefined {
    return this.runs.get(agentId);
  }

  listBySession(sessionId: string): AgentRun[] {
    return [...this.runs.values()].filter(r => r.rootSessionId === sessionId);
  }

  listByParent(parentAgentId: string): AgentRun[] {
    return [...this.runs.values()].filter(r => r.parentAgentId === parentAgentId);
  }

  delete(agentId: string): boolean {
    return this.runs.delete(agentId);
  }
}
