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
) {
  return new PolicyCenterImpl({
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
