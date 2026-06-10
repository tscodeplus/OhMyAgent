import type { MemoryAccessPolicy } from '../memory-access-policy.js';

export interface RetrievalPolicy {
  /** Memory access/visibility policy. */
  access: MemoryAccessPolicy;

  /** Pool weights for agent-aware retrieval (current / shared / other). */
  poolWeights?: {
    current?: number;
    shared?: number;
    otherShared?: number;
  };

  /** Enable entity graph expansion. Default false. */
  includeEntityExpansion?: boolean;

  /** Enable temporal decay scoring. Default true. */
  includeTemporalDecay?: boolean;

  /** Only return active memories. Default true. */
  activeOnly?: boolean;
}

/**
 * Default classic recall policy — single-agent, shared-only access.
 */
export function classicRecallPolicy(options?: {
  scope?: string;
  scopeKey?: string;
  kind?: string;
  agentId?: string;
}): RetrievalPolicy {
  return {
    access: {
      scope: options?.scope,
      scopeKey: options?.scopeKey,
      kind: options?.kind,
      agentId: options?.agentId,
      includeShared: true,
    },
    includeEntityExpansion: true,
    includeTemporalDecay: true,
    activeOnly: true,
  };
}

/**
 * Agent-aware recall policy — multi-pool retrieval with weights.
 */
export function agentAwareRecallPolicy(options: {
  agentId: string;
  poolWeights?: {
    current?: number;
    shared?: number;
    otherShared?: number;
  };
}): RetrievalPolicy {
  return {
    access: {
      agentId: options.agentId,
      includeShared: true,
    },
    poolWeights: options.poolWeights ?? {
      current: 60,
      shared: 50,
      otherShared: 40,
    },
    includeEntityExpansion: true,
    includeTemporalDecay: true,
    activeOnly: true,
  };
}
