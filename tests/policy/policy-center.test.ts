import { describe, expect, it, vi } from 'vitest';
import { PolicyCenterImpl } from '../../src/policy/policy-center';
import type { AgentPolicyScope, ToolPolicyInput } from '../../src/policy/types';
import type { ToolCapabilityDescriptor } from '../../src/tools/platform/tool-capabilities';

function scope(overrides: Partial<AgentPolicyScope> = {}): AgentPolicyScope {
  return {
    toolsProfile: 'advanced',
    readRoots: [],
    writeRoots: [],
    deniedPatterns: [],
    shellExecMode: 'balanced',
    sessionApprovals: [],
    appApprovals: [],
    readOnly: false,
    computerUseEnabled: false,
    policyMode: 'balanced',
    ...overrides,
  };
}

function readCapability(): ToolCapabilityDescriptor {
  return {
    category: 'file',
    readOnly: true,
    writesFiles: false,
    readsFiles: true,
    usesShell: false,
    usesNetwork: false,
    usesComputerUse: false,
    pathAccess: 'read',
    approvalDefault: 'none',
  };
}

function makePolicyCenter(
  check: ReturnType<typeof vi.fn>,
  checkReuse: ReturnType<typeof vi.fn> = vi.fn(async () => ({ canReuse: false })),
  mode: 'bypass' | 'safe' | 'balanced' | 'permissive' = 'balanced',
) {
  return new PolicyCenterImpl({
    mode,
    toolVisibility: { isVisible: vi.fn(() => true) },
    pathAccess: {
      check,
      getEffectiveRoots: vi.fn(() => ({ readRoots: [], writeRoots: [] })),
    },
    shellExecution: {
      evaluate: vi.fn(async () => ({ allowed: true, requiresApproval: false, risk: 'low' })),
    },
    approvalResolution: {
      checkReuse,
      recordDecision: vi.fn(async () => undefined),
    },
    agentInheritance: {
      deriveChildScope: vi.fn((parent: AgentPolicyScope) => parent),
    },
  });
}

async function evaluate(center: PolicyCenterImpl, args: unknown) {
  const input: ToolPolicyInput = {
    toolName: 'file_like_tool',
    capability: readCapability(),
    args,
    sessionId: 'session-1',
    agentId: 'agent-1',
    policyScope: scope(),
  };
  return center.evaluateToolCall(input);
}

describe('PolicyCenterImpl path argument extraction', () => {
  it('checks imagePath for image_to_text style tools', async () => {
    const check = vi.fn(() => ({ allowed: true, resolvedPath: '/tmp/image.png' }));
    const center = makePolicyCenter(check);

    await evaluate(center, { imagePath: '/tmp/image.png' });

    expect(check).toHaveBeenCalledWith(expect.objectContaining({
      path: '/tmp/image.png',
      operation: 'read',
    }));
  });

  it('checks cwd for directory-scoped read tools such as glob', async () => {
    const check = vi.fn(() => ({ allowed: false, reason: 'outside roots' }));
    const center = makePolicyCenter(check);

    const decision = await evaluate(center, { pattern: '*.ts', cwd: '/private' });

    expect(check).toHaveBeenCalledWith(expect.objectContaining({
      path: '/private',
      operation: 'read',
    }));
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('outside roots');
  });

  it('checks directory for file_search style tools', async () => {
    const check = vi.fn(() => ({ allowed: false, reason: 'outside roots' }));
    const center = makePolicyCenter(check);

    const decision = await evaluate(center, { directory: '/private', pattern: '*.ts' });

    expect(check).toHaveBeenCalledWith(expect.objectContaining({
      path: '/private',
      operation: 'read',
    }));
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('outside roots');
  });

  it('allows denied path access when the same path approval is reusable', async () => {
    const check = vi.fn(() => ({ allowed: false, reason: 'outside roots' }));
    const checkReuse = vi.fn(async () => ({ canReuse: true, decision: 'approve_session' }));
    const center = makePolicyCenter(check, checkReuse);

    const decision = await evaluate(center, { path: '/private/file.txt' });

    expect(checkReuse).toHaveBeenCalledWith(
      'session-1',
      'path',
      'file_like_tool:/private/file.txt',
    );
    expect(decision.allowed).toBe(true);
  });

  it('reuses generic tool approval by tool name after exact subject misses', async () => {
    const check = vi.fn(() => ({ allowed: true }));
    const checkReuse = vi.fn()
      .mockResolvedValueOnce({ canReuse: false })
      .mockResolvedValueOnce({ canReuse: true, decision: 'approve_session' });
    const center = makePolicyCenter(check, checkReuse);

    const input: ToolPolicyInput = {
      toolName: 'remote_trigger',
      capability: {
        category: 'web',
        readOnly: false,
        writesFiles: false,
        readsFiles: false,
        usesShell: false,
        usesNetwork: true,
        usesComputerUse: false,
        pathAccess: 'none',
        approvalDefault: 'high_risk',
      },
      args: { route: 'deploy' },
      sessionId: 'session-1',
      agentId: 'agent-1',
      policyScope: scope(),
    };

    const decision = await center.evaluateToolCall(input);

    expect(checkReuse).toHaveBeenNthCalledWith(
      1,
      'session-1',
      'tool',
      'remote_trigger {"route":"deploy"}',
    );
    expect(checkReuse).toHaveBeenNthCalledWith(2, 'session-1', 'tool', 'remote_trigger');
    expect(decision.allowed).toBe(true);
  });

  it('reuses computer_use app approval using the same subject as the approval card', async () => {
    const check = vi.fn(() => ({ allowed: true }));
    const checkReuse = vi.fn(async () => ({ canReuse: true, decision: 'approve_always' }));
    const center = makePolicyCenter(check, checkReuse);

    const decision = await center.evaluateToolCall({
      toolName: 'computer_use',
      capability: {
        category: 'computer_use',
        readOnly: false,
        writesFiles: false,
        readsFiles: false,
        usesShell: false,
        usesNetwork: false,
        usesComputerUse: true,
        pathAccess: 'none',
        approvalDefault: 'high_risk',
      },
      args: { action: 'open_app', target: '记事本' },
      sessionId: 'session-1',
      agentId: 'agent-1',
      policyScope: scope({ computerUseEnabled: true }),
    });

    expect(checkReuse).toHaveBeenCalledWith(
      'session-1',
      'tool',
      'computer_use open_app 记事本',
    );
    expect(decision.allowed).toBe(true);
  });
});

describe('PolicyCenterImpl policy mode handling', () => {
  function mutatingCapability(): ToolCapabilityDescriptor {
    return {
      category: 'file',
      readOnly: false,
      writesFiles: true,
      readsFiles: false,
      usesShell: false,
      usesNetwork: false,
      usesComputerUse: false,
      pathAccess: 'write',
      approvalDefault: 'mutating',
    };
  }

  function highRiskCapability(): ToolCapabilityDescriptor {
    return {
      category: 'web',
      readOnly: false,
      writesFiles: false,
      readsFiles: false,
      usesShell: false,
      usesNetwork: true,
      usesComputerUse: false,
      pathAccess: 'none',
      approvalDefault: 'high_risk',
    };
  }

  function defaultCapability(): ToolCapabilityDescriptor {
    return {
      category: 'session',
      readOnly: false,
      writesFiles: false,
      readsFiles: false,
      usesShell: false,
      usesNetwork: false,
      usesComputerUse: false,
      pathAccess: 'none',
      approvalDefault: 'none',
    };
  }

  it('bypass mode: allows all tools regardless of capability', async () => {
    const check = vi.fn(() => ({ allowed: false, reason: 'outside roots' }));
    const center = makePolicyCenter(check, undefined, 'bypass');

    const decision = await center.evaluateToolCall({
      toolName: 'file_write',
      capability: mutatingCapability(),
      args: { filePath: '/private/file.txt' },
      sessionId: 'session-1',
      agentId: 'agent-1',
      policyScope: scope(),
    });

    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(false);
    // Path check should NOT be called in bypass mode
    expect(check).not.toHaveBeenCalled();
  });

  it('permissive mode: skips mutating/high_risk checks but still checks path access', async () => {
    const check = vi.fn(() => ({ allowed: true, resolvedPath: '/allowed/file.txt' }));
    const center = makePolicyCenter(check, undefined, 'permissive');

    const decision = await center.evaluateToolCall({
      toolName: 'file_write',
      capability: mutatingCapability(),
      args: { filePath: '/allowed/file.txt' },
      sessionId: 'session-1',
      agentId: 'agent-1',
      policyScope: scope(),
    });

    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(false);
    // Path check should still be called
    expect(check).toHaveBeenCalled();
  });

  it('permissive mode: requires approval when path is denied', async () => {
    const check = vi.fn(() => ({ allowed: false, reason: 'outside roots' }));
    const checkReuse = vi.fn(async () => ({ canReuse: false }));
    const center = makePolicyCenter(check, checkReuse, 'permissive');

    const decision = await center.evaluateToolCall({
      toolName: 'file_write',
      capability: mutatingCapability(),
      args: { filePath: '/private/file.txt' },
      sessionId: 'session-1',
      agentId: 'agent-1',
      policyScope: scope(),
    });

    expect(decision.allowed).toBe(false);
    expect(decision.requiresApproval).toBe(true);
    expect(decision.approvalKind).toBe('path');
  });

  it('safe mode: requires approval for all non-readOnly tools', async () => {
    const check = vi.fn(() => ({ allowed: true }));
    const center = makePolicyCenter(check, undefined, 'safe');

    const decision = await center.evaluateToolCall({
      toolName: 'todo_write',
      capability: defaultCapability(),
      args: {},
      sessionId: 'session-1',
      agentId: 'agent-1',
      policyScope: scope(),
    });

    // defaultCapability has approvalDefault: 'none' but safe mode overrides
    expect(decision.allowed).toBe(false);
    expect(decision.requiresApproval).toBe(true);
  });

  it('safe mode: allows readOnly tools', async () => {
    const check = vi.fn(() => ({ allowed: true }));
    const center = makePolicyCenter(check, undefined, 'safe');

    const decision = await center.evaluateToolCall({
      toolName: 'file_read',
      capability: readCapability(),
      args: { filePath: '/tmp/test.txt' },
      sessionId: 'session-1',
      agentId: 'agent-1',
      policyScope: scope(),
    });

    // readOnly tools bypass the safe mode check
    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(false);
  });

  it('balanced mode: honors approvalDefault (existing behavior)', async () => {
    const check = vi.fn(() => ({ allowed: true }));
    const center = makePolicyCenter(check, undefined, 'balanced');

    const decision = await center.evaluateToolCall({
      toolName: 'file_write',
      capability: mutatingCapability(),
      args: { filePath: '/tmp/test.txt' },
      sessionId: 'session-1',
      agentId: 'agent-1',
      policyScope: scope(),
    });

    // mutating capability requires approval in balanced mode
    expect(decision.allowed).toBe(false);
    expect(decision.requiresApproval).toBe(true);
  });

  it('balanced mode: allows tools with approvalDefault: none', async () => {
    const check = vi.fn(() => ({ allowed: true }));
    const center = makePolicyCenter(check, undefined, 'balanced');

    const decision = await center.evaluateToolCall({
      toolName: 'todo_write',
      capability: defaultCapability(),
      args: {},
      sessionId: 'session-1',
      agentId: 'agent-1',
      policyScope: scope(),
    });

    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(false);
  });

  it('updateMode: changes behavior at runtime', async () => {
    const check = vi.fn(() => ({ allowed: true }));
    const center = makePolicyCenter(check, undefined, 'balanced');

    // Initially balanced — mutating requires approval
    const decision1 = await center.evaluateToolCall({
      toolName: 'file_write',
      capability: mutatingCapability(),
      args: { filePath: '/tmp/test.txt' },
      sessionId: 'session-1',
      agentId: 'agent-1',
      policyScope: scope(),
    });
    expect(decision1.allowed).toBe(false);
    expect(decision1.requiresApproval).toBe(true);

    // Switch to bypass — everything allowed
    center.updateMode('bypass');
    const decision2 = await center.evaluateToolCall({
      toolName: 'file_write',
      capability: mutatingCapability(),
      args: { filePath: '/private/file.txt' },
      sessionId: 'session-1',
      agentId: 'agent-1',
      policyScope: scope(),
    });
    expect(decision2.allowed).toBe(true);
    expect(decision2.requiresApproval).toBe(false);
  });
});
