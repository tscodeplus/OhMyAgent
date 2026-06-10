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

    await expect(beforeToolCall({
      toolCall: { name: 'computer_use' },
      args: { action: 'open_app', target: '记事本' },
    })).resolves.toBeUndefined();

    expect(recordApprovalDecision).toHaveBeenCalledWith(expect.objectContaining({
      requestId: expect.any(String),
      decision: 'approve_always',
      scope: 'global',
      kind: 'tool',
      sessionId: 'session-1',
      subject: 'computer_use open_app notepad',
    }));
    expect(computerUseHost.approveApp).toHaveBeenCalledWith(
      { sessionPath: 'session-1', agentId: 'agent-1' },
      '记事本',
      'global',
    );
  });

  it('does not ask for a second approval for follow-up computer_use actions', async () => {
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
      computerUseHost: {
        isAppApproved: vi.fn(() => true),
        approveApp: vi.fn(),
      } as any,
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

    await expect(beforeToolCall({
      toolCall: { name: 'computer_use' },
      args: { action: 'type_text', text: '你好' },
    })).resolves.toBeUndefined();

    expect(createApproval).not.toHaveBeenCalled();
    expect(sendApprovalCard).not.toHaveBeenCalled();
  });
});
