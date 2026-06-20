// ---------------------------------------------------------------------------
// v4 Policy — agent inheritance / scope merge
// ---------------------------------------------------------------------------

import type { AgentPolicyScope, ChildAgentPolicyRequest, ToolProfileId } from '../types.js';
import { ToolVisibilityPolicyImpl } from '../tool-visibility.js';

export interface AgentInheritancePolicy {
  deriveChildScope(parent: AgentPolicyScope, request: ChildAgentPolicyRequest): AgentPolicyScope;
}

export class AgentInheritancePolicyImpl implements AgentInheritancePolicy {
  deriveChildScope(parent: AgentPolicyScope, request: ChildAgentPolicyRequest): AgentPolicyScope {
    // toolsProfile: take the stricter value
    const toolsProfile = this.stricterProfile(
      parent.toolsProfile,
      request.requestedToolsProfile,
    );

    // readRoots / writeRoots: intersection
    const readRoots = this.intersect(
      parent.readRoots,
      request.requestedReadRoots,
    );
    const writeRoots = this.intersect(
      parent.writeRoots,
      request.requestedWriteRoots,
    );

    // deniedPatterns: union
    const deniedPatterns = this.union(
      parent.deniedPatterns,
      [], // child can't add new denied patterns in v4 Phase 1
    );

    // shellExecMode: take the stricter value
    const shellExecMode = this.stricterExecMode(
      parent.shellExecMode,
    );

    // readOnly: either parent or child request → readOnly wins
    const readOnly = parent.readOnly || (request.requestedReadOnly ?? false);

    // computerUseEnabled: v4 Phase 1 — child always false
    const computerUseEnabled = false;

    return {
      toolsProfile,
      readRoots,
      writeRoots,
      deniedPatterns,
      shellExecMode,
      sessionApprovals: [...parent.sessionApprovals],
      appApprovals: [...parent.appApprovals],
      readOnly,
      computerUseEnabled,
      policyMode: parent.policyMode,
    };
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private stricterProfile(parent: ToolProfileId, child?: ToolProfileId): ToolProfileId {
    if (!child) return parent;
    return ToolVisibilityPolicyImpl.minProfile(parent, child);
  }

  private stricterExecMode(parent: 'safe' | 'balanced' | 'trusted'): 'safe' | 'balanced' | 'trusted' {
    // child can never get a looser mode than parent
    return parent;
  }

  private intersect(parentValues: string[], childValues?: string[]): string[] {
    if (!childValues || childValues.length === 0) return [...parentValues];

    const parentSet = new Set(parentValues.map(v => v.toLowerCase()));
    return childValues.filter(v => parentSet.has(v.toLowerCase()));
  }

  private union(parentValues: string[], childValues: string[]): string[] {
    return [...new Set([...parentValues, ...childValues])];
  }
}
