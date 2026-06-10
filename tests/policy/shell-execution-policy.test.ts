import { describe, expect, it, vi } from 'vitest';
import type { ApprovalGate } from '../../src/app/types';
import { ShellExecutionPolicyImpl } from '../../src/policy/shell/evaluator';
import type { AgentPolicyScope } from '../../src/policy/types';

function readOnlyScope(): AgentPolicyScope {
  return {
    toolsProfile: 'minimal',
    readRoots: [],
    writeRoots: [],
    deniedPatterns: [],
    shellExecMode: 'safe',
    sessionApprovals: [],
    appApprovals: [],
    readOnly: true,
    computerUseEnabled: false,
  };
}

function makeGate(decision: Awaited<ReturnType<ApprovalGate['evaluate']>> = 'approved'): ApprovalGate {
  return {
    evaluate: vi.fn(async () => decision),
    recordDecision: vi.fn(async () => undefined),
    getPolicy: vi.fn(async () => null),
  };
}

describe('ShellExecutionPolicyImpl read-only scopes', () => {
  it('allows read-only shell subset through to the approval gate', async () => {
    const gate = makeGate('approved');
    const policy = new ShellExecutionPolicyImpl({ approvalGate: gate });

    const decision = await policy.evaluate({
      command: 'ls -la',
      sessionId: 'session-1',
      scope: readOnlyScope(),
    });

    expect(decision).toEqual({ allowed: true, requiresApproval: false, risk: 'low' });
    expect(gate.evaluate).toHaveBeenCalledOnce();
  });

  it('blocks mutating shell commands before approval in read-only scopes', async () => {
    const gate = makeGate('approved');
    const policy = new ShellExecutionPolicyImpl({ approvalGate: gate });

    const decision = await policy.evaluate({
      command: 'tee output.txt',
      sessionId: 'session-1',
      scope: readOnlyScope(),
    });

    expect(decision).toEqual({
      allowed: false,
      requiresApproval: false,
      reason: 'Program "tee" is blocked by read-only shell mode (toolsProfile: minimal)',
      risk: 'high',
    });
    expect(gate.evaluate).not.toHaveBeenCalled();
  });
});
