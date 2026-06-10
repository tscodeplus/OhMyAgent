// ---------------------------------------------------------------------------
// Tests for PermissionInheritanceServiceImpl
// ---------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest';
import { PermissionInheritanceServiceImpl } from '../../src/orchestrator/permission-inheritance.js';
import type { PolicyCenter } from '../../src/policy/policy-center.js';
import type { AgentRun } from '../../src/orchestrator/types.js';
import type { AgentPolicyScope, ChildAgentPolicyRequest } from '../../src/policy/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeParentScope(overrides: Partial<AgentPolicyScope> = {}): AgentPolicyScope {
  return {
    toolsProfile: 'standard',
    readRoots: ['/data'],
    writeRoots: ['/data/write'],
    deniedPatterns: [],
    shellExecMode: 'balanced',
    sessionApprovals: ['shell:install'],
    appApprovals: ['app:deploy'],
    readOnly: false,
    computerUseEnabled: true,
    ...overrides,
  };
}

function makeAgentRun(scope: AgentPolicyScope, overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    agentId: 'parent-agent',
    parentAgentId: undefined,
    rootSessionId: 'session-1',
    role: 'primary',
    status: 'running',
    createdAt: Date.now(),
    scope,
    ...overrides,
  };
}

/** Create a minimal PolicyCenter mock — all methods are spies by default. */
function mockPolicyCenter(overrides?: Partial<PolicyCenter>): PolicyCenter {
  return {
    evaluateToolCall: vi.fn(),
    evaluateShellCommand: vi.fn(),
    evaluatePathAccess: vi.fn(),
    inheritScope: vi.fn(),
    recordApprovalDecision: vi.fn(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PermissionInheritanceServiceImpl', () => {
  it('forces computerUseEnabled=false even when parent has it true', () => {
    const parentScope = makeParentScope({ computerUseEnabled: true });
    const parent = makeAgentRun(parentScope);

    const policyCenter = mockPolicyCenter({
      inheritScope: vi.fn().mockReturnValue({ ...parentScope, computerUseEnabled: true }),
    });

    const service = new PermissionInheritanceServiceImpl(policyCenter);
    const childScope = service.deriveChildScope(parent, {});

    expect(childScope.computerUseEnabled).toBe(false);
  });

  it('intersects readRoots when child requests a wider set', () => {
    const parentScope = makeParentScope({ readRoots: ['/data', '/common'] });
    const parent = makeAgentRun(parentScope);

    const childRequest: ChildAgentPolicyRequest = {
      requestedReadRoots: ['/common', '/wider', '/data'],
    };

    // Simulate what the policy center's inheritScope would produce:
    // intersection of ['/data', '/common'] and ['/common', '/wider', '/data'] = ['/common', '/data']
    const inheritResult: AgentPolicyScope = {
      ...parentScope,
      readRoots: ['/common', '/data'],
    };

    const policyCenter = mockPolicyCenter({
      inheritScope: vi.fn().mockReturnValue(inheritResult),
    });

    const service = new PermissionInheritanceServiceImpl(policyCenter);
    const childScope = service.deriveChildScope(parent, childRequest);

    // Intersection should exclude '/wider'
    expect(childScope.readRoots).toContain('/common');
    expect(childScope.readRoots).toContain('/data');
    expect(childScope.readRoots).not.toContain('/wider');
  });

  it('keeps readOnly=true when parent is readOnly even if child requests readOnly=false', () => {
    const parentScope = makeParentScope({ readOnly: true });
    const parent = makeAgentRun(parentScope);

    const childRequest: ChildAgentPolicyRequest = {
      requestedReadOnly: false,
    };

    // Policy center preserves readOnly= true because parent.readOnly || childRequest → true
    const inheritResult: AgentPolicyScope = {
      ...parentScope,
      readOnly: true,
    };

    const policyCenter = mockPolicyCenter({
      inheritScope: vi.fn().mockReturnValue(inheritResult),
    });

    const service = new PermissionInheritanceServiceImpl(policyCenter);
    const childScope = service.deriveChildScope(parent, childRequest);

    expect(childScope.readOnly).toBe(true);
  });

  it('inherits sessionApprovals from parent scope', () => {
    const parentScope = makeParentScope({
      sessionApprovals: ['shell:install', 'shell:git'],
    });
    const parent = makeAgentRun(parentScope);

    // Policy center copies sessionApprovals from parent
    const inheritResult: AgentPolicyScope = {
      ...parentScope,
      sessionApprovals: [...parentScope.sessionApprovals],
    };

    const policyCenter = mockPolicyCenter({
      inheritScope: vi.fn().mockReturnValue(inheritResult),
    });

    const service = new PermissionInheritanceServiceImpl(policyCenter);
    const childScope = service.deriveChildScope(parent, {});

    expect(childScope.sessionApprovals).toEqual(['shell:install', 'shell:git']);
  });

  it('delegates to PolicyCenter.inheritScope with correct arguments', () => {
    const parentScope = makeParentScope();
    const parent = makeAgentRun(parentScope);
    const childRequest: ChildAgentPolicyRequest = {
      requestedToolsProfile: 'minimal',
      requestedReadRoots: ['/child'],
    };

    const inheritResult: AgentPolicyScope = {
      ...parentScope,
      toolsProfile: 'minimal',
      readRoots: [],
    };

    const inheritScopeSpy = vi.fn().mockReturnValue(inheritResult);
    const policyCenter = mockPolicyCenter({ inheritScope: inheritScopeSpy });

    const service = new PermissionInheritanceServiceImpl(policyCenter);
    service.deriveChildScope(parent, childRequest);

    expect(inheritScopeSpy).toHaveBeenCalledTimes(1);
    expect(inheritScopeSpy).toHaveBeenCalledWith(parentScope, childRequest);
  });
});
