// ---------------------------------------------------------------------------
// v4 Orchestrator — PermissionInheritanceService
// ---------------------------------------------------------------------------
//
// Wraps PolicyCenter.inheritScope() for the Orchestrator, adding hard
// constraints that always apply to child agents (e.g. computerUseEnabled = false).
// ---------------------------------------------------------------------------

import type { AgentRun } from './types.js';
import type { AgentPolicyScope, ChildAgentPolicyRequest } from '../policy/types.js';
import type { PolicyCenter } from '../policy/policy-center.js';

export interface PermissionInheritanceService {
  /** Derive a child agent's scope from the parent AgentRun + child request. */
  deriveChildScope(parent: AgentRun, request: ChildAgentPolicyRequest): AgentPolicyScope;
}

export class PermissionInheritanceServiceImpl implements PermissionInheritanceService {
  constructor(private policyCenter: PolicyCenter) {}

  deriveChildScope(parent: AgentRun, request: ChildAgentPolicyRequest): AgentPolicyScope {
    // 1. Call PolicyCenter.inheritScope() — applies intersection/union rules
    //    defined in AgentInheritancePolicy.deriveChildScope().
    const childScope = this.policyCenter.inheritScope(parent.scope, request);

    // 2. v4 Phase 5 hard constraint: child NEVER gets computer_use.
    //    Even if the parent scope or the child request would allow it, the
    //    orchestrator unconditionally denies it to prevent unauthorized
    //    remote-control escalation through agent nesting.
    childScope.computerUseEnabled = false;

    return childScope;
  }
}
