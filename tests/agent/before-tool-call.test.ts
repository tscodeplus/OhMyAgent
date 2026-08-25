import { describe, expect, it, vi } from 'vitest';
import { createBeforeToolCall } from '../../src/agent/before-tool-call';
import { PendingApprovalStore } from '../../src/agent/approval-store';
import type { ApprovalGate } from '../../src/app/types';
import type { PolicyCenter } from '../../src/policy/types';

describe('createBeforeToolCall computer_use approval', () => {
  it('records approved computer_use app decisions for later policy reuse', async () => {
    const recordApprovalDecision = vi.fn(async () => undefined);
    const policyCenter = {
      evaluateToolCall: vi.fn(async () => ({
        allowed: false,
        requiresApproval: true,
        approvalKind: 'computer_use_action',
      })),
      recordApprovalDecision,
    } as unknown as PolicyCenter;

    const pendingApprovals = new PendingApprovalStore();
    vi.spyOn(pendingApprovals, 'create').mockResolvedValue('approve_always');

    const computerUseHost = {
      isAppApproved: vi.fn(() => false),
      approveApp: vi.fn(),
    };

    const sendApprovalCard = vi.fn(async () => 'msg-approval');
    const beforeToolCall = createBeforeToolCall({
      approvalGate: {
        evaluate: vi.fn(),
        recordDecision: vi.fn(),
        getPolicy: vi.fn(),
      } as unknown as ApprovalGate,
      approvalPort: {
        getSession(_ctx, cache) {
          if (cache.approvalSession) return cache.approvalSession;
          const session = {
            present: async (req: any) => sendApprovalCard(req.chatId, req),
            resolve: async () => {},
          };
          cache.approvalSession = session as any;
          return session as any;
        },
      },
      approvalTimeoutMs: 30_000,
      computerUseHost: computerUseHost as any,
      pendingApprovals,
      sessionId: 'session-1',
      chatId: 'chat-1',
      messageId: 'message-1',
      agentConfig: { id: 'agent-1' } as any,
      resolvedSkillScope: { scope: 'global', scopeKey: '' },
      effectiveProfile: 'full',
      shellMode: 'full',
      channel: 'feishu',
      policyCenter,
      policyScope: {
        toolsProfile: 'full',
        readRoots: [],
        writeRoots: [],
        deniedPatterns: [],
        shellExecMode: 'balanced',
        sessionApprovals: [],
        appApprovals: [],
        readOnly: false,
        computerUseEnabled: true,
      },
    });

    await expect(
      beforeToolCall({
        toolCall: { name: 'computer_use' },
        args: { action: 'open_app', target: '记事本' },
      }),
    ).resolves.toBeUndefined();

    expect(recordApprovalDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: expect.any(String),
        decision: 'approve_always',
        scope: 'global',
        kind: 'tool',
        sessionId: 'session-1',
        subject: 'computer_use open_app notepad',
      }),
    );
    expect(computerUseHost.approveApp).toHaveBeenCalledWith(
      { sessionPath: 'session-1', agentId: 'agent-1' },
      '记事本',
      'global',
    );
  });

  it('routes follow-up non-app computer_use actions through generic approval (fail-closed)', async () => {
    const policyCenter = {
      evaluateToolCall: vi.fn(async () => ({
        allowed: false,
        requiresApproval: true,
        approvalKind: 'computer_use_action',
      })),
      recordApprovalDecision: vi.fn(async () => undefined),
    } as unknown as PolicyCenter;

    const pendingApprovals = new PendingApprovalStore();
    const createApproval = vi.spyOn(pendingApprovals, 'create').mockResolvedValue('approve_once');
    const sendApprovalCard = vi.fn(async () => 'msg-approval');

    // Even when an app was already approved, non-app actions (type_text,
    // click_point, …) are mutating/high-risk and must NOT be silently
    // allowed — they go through the fail-closed generic approval path.
    const computerUseHost = {
      isAppApproved: vi.fn(() => true),
      approveApp: vi.fn(),
    } as any;

    const beforeToolCall = createBeforeToolCall({
      approvalGate: {
        evaluate: vi.fn(),
        recordDecision: vi.fn(),
        getPolicy: vi.fn(),
      } as unknown as ApprovalGate,
      approvalPort: {
        getSession(_ctx, cache) {
          if (cache.approvalSession) return cache.approvalSession;
          const session = {
            present: async (req: any) => sendApprovalCard(req.chatId, req),
            resolve: async () => {},
          };
          cache.approvalSession = session as any;
          return session as any;
        },
      },
      approvalTimeoutMs: 30_000,
      computerUseHost,
      pendingApprovals,
      sessionId: 'session-1',
      chatId: 'chat-1',
      messageId: 'message-1',
      resolvedSkillScope: { scope: 'global', scopeKey: '' },
      effectiveProfile: 'full',
      shellMode: 'full',
      channel: 'feishu',
      policyCenter,
      policyScope: {
        toolsProfile: 'full',
        readRoots: [],
        writeRoots: [],
        deniedPatterns: [],
        shellExecMode: 'balanced',
        sessionApprovals: [],
        appApprovals: [],
        readOnly: false,
        computerUseEnabled: true,
      },
    });

    await expect(
      beforeToolCall({
        toolCall: { name: 'computer_use' },
        args: { action: 'type_text', text: '你好' },
      }),
    ).resolves.toBeUndefined();

    expect(createApproval).toHaveBeenCalledTimes(1);
    expect(sendApprovalCard).toHaveBeenCalledTimes(1);
    // Non-app actions must not grant any app-level approval.
    expect(computerUseHost.approveApp).not.toHaveBeenCalled();
  });

  it('blocks non-app computer_use actions when no approval channel is available (fail-closed)', async () => {
    const policyCenter = {
      evaluateToolCall: vi.fn(async () => ({
        allowed: false,
        requiresApproval: true,
        approvalKind: 'computer_use_action',
      })),
      recordApprovalDecision: vi.fn(async () => undefined),
    } as unknown as PolicyCenter;

    const pendingApprovals = new PendingApprovalStore();
    const createApproval = vi.spyOn(pendingApprovals, 'create');

    const beforeToolCall = createBeforeToolCall({
      approvalGate: {
        evaluate: vi.fn(),
        recordDecision: vi.fn(),
        getPolicy: vi.fn(),
      } as unknown as ApprovalGate,
      approvalPort: { getSession: () => undefined },
      approvalTimeoutMs: 30_000,
      computerUseHost: { isAppApproved: vi.fn(() => false), approveApp: vi.fn() } as any,
      pendingApprovals,
      sessionId: 'session-1',
      chatId: 'chat-1',
      messageId: 'message-1',
      resolvedSkillScope: { scope: 'global', scopeKey: '' },
      effectiveProfile: 'full',
      shellMode: 'full',
      channel: 'wechat', // no interactive approval sender
      policyCenter,
      policyScope: {
        toolsProfile: 'full',
        readRoots: [],
        writeRoots: [],
        deniedPatterns: [],
        shellExecMode: 'balanced',
        sessionApprovals: [],
        appApprovals: [],
        readOnly: false,
        computerUseEnabled: true,
      },
    });

    await expect(
      beforeToolCall({
        toolCall: { name: 'computer_use' },
        args: { action: 'click_point', x: 10, y: 20 },
      }),
    ).resolves.toEqual(expect.objectContaining({ block: true }));

    expect(createApproval).not.toHaveBeenCalled();
  });
});
