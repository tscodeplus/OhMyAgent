import { describe, expect, it, vi } from 'vitest';
import { ApprovalResolutionPolicyImpl } from '../../src/policy/approval/resolution';
import type { ApprovalGate } from '../../src/app/types';

function makeGate(): ApprovalGate {
  return {
    evaluate: vi.fn(),
    recordDecision: vi.fn(async () => undefined),
    getPolicy: vi.fn(async () => null),
  } as unknown as ApprovalGate;
}

describe('ApprovalResolutionPolicyImpl', () => {
  it('reuses approvals by session, kind, and subject', async () => {
    const gate = makeGate();
    const policy = new ApprovalResolutionPolicyImpl({ approvalGate: gate });

    await policy.recordDecision({
      requestId: 'req-1',
      decision: 'approve_session',
      scope: 'session',
      kind: 'tool',
      sessionId: 'session-1',
      subject: 'file_write /tmp/a.txt',
      recordedAt: Date.now(),
    });

    expect(await policy.checkReuse('session-1', 'tool', 'file_write /tmp/a.txt'))
      .toEqual({ canReuse: true, decision: 'approve_session' });
    expect(await policy.checkReuse('session-1', 'tool', 'file_write /tmp/b.txt'))
      .toEqual({ canReuse: false });
    expect(gate.recordDecision).toHaveBeenCalledWith(
      'req-1',
      'approve_session',
      'file_write /tmp/a.txt',
      'session-1',
      'tool',
    );
  });

  it('does not persist an always decision without an approval subject', async () => {
    const gate = makeGate();
    const policy = new ApprovalResolutionPolicyImpl({ approvalGate: gate });

    await policy.recordDecision({
      requestId: 'req-1',
      decision: 'approve_always',
      scope: 'global',
      kind: 'tool',
      recordedAt: Date.now(),
    });

    expect(gate.recordDecision).not.toHaveBeenCalled();
  });

  it('checks persisted tool policies by kind and subject', async () => {
    const gate = makeGate();
    vi.mocked(gate.evaluate).mockResolvedValueOnce('approved');
    const policy = new ApprovalResolutionPolicyImpl({ approvalGate: gate });

    await expect(policy.checkReuse('session-1', 'tool', 'remote_trigger'))
      .resolves.toEqual({ canReuse: true, decision: 'approve_always' });
    expect(gate.evaluate).toHaveBeenCalledWith({
      kind: 'tool',
      toolName: 'remote_trigger',
      sessionKey: 'session-1',
      scope: 'session',
      scopeKey: 'session-1',
    });
  });
});
