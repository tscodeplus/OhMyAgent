import type { Memory } from './repositories/memory-repository.js';

export interface MemoryAccessPolicy {
  scope?: string;
  scopeKey?: string;
  kind?: string | string[];
  agentId?: string;
  pool?: MemoryPool;
  includeShared?: boolean;
  includeOtherAgents?: boolean;
  includePrivate?: boolean;
}

export type MemoryPool = 'current' | 'shared' | 'other';

export function matchesMemoryAccess(memory: Memory, policy: MemoryAccessPolicy = {}): boolean {
  if (policy.scope !== undefined && memory.scope !== policy.scope) return false;
  if (policy.scopeKey !== undefined && memory.scope_key !== policy.scopeKey) return false;

  if (policy.kind !== undefined) {
    const kinds = Array.isArray(policy.kind) ? policy.kind : [policy.kind];
    if (!kinds.includes(memory.kind)) return false;
  }

  if (policy.pool) {
    return matchesMemoryPool(memory, policy.pool, policy.agentId ?? null);
  }

  const includeShared = policy.includeShared !== false;
  const agentId = policy.agentId;
  const memoryAgentId = memory.agent_id ?? null;
  const visibility = memory.visibility ?? 'shared';

  if (!agentId) {
    if (memoryAgentId === null) return true;
    if (includeShared && visibility === 'shared') return true;
    return policy.includePrivate === true;
  }

  if (memoryAgentId === agentId) return true;
  if (memoryAgentId === null) return true;
  if (includeShared && visibility === 'shared') return true;
  if (policy.includeOtherAgents && policy.includePrivate) return true;
  return false;
}

export function matchesMemoryPool(
  memory: Memory,
  pool: MemoryPool,
  agentId: string | null,
): boolean {
  const memoryAgentId = memory.agent_id ?? null;
  const visibility = memory.visibility ?? 'shared';

  if (pool === 'current') {
    return agentId !== null && memoryAgentId === agentId;
  }
  if (pool === 'shared') {
    return memoryAgentId === null;
  }

  return agentId !== null && memoryAgentId !== null && memoryAgentId !== agentId && visibility === 'shared';
}

export function policyFromRetrievalOptions(options: {
  scope?: string;
  scopeKey?: string;
  agentId?: string;
  kind?: string | string[];
}): MemoryAccessPolicy {
  return {
    scope: options.scope,
    scopeKey: options.scopeKey,
    agentId: options.agentId,
    kind: options.kind,
    includeShared: true,
  };
}
