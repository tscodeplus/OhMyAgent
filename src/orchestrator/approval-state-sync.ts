// ---------------------------------------------------------------------------
// v4 Orchestrator — ApprovalStateSync
// ---------------------------------------------------------------------------
//
// Routes child agent approval requests up to the parent session's chat UI.
// Checks whether a parent-session approval already covers the request so
// the user is not prompted twice for the same kind of operation.
// ---------------------------------------------------------------------------

import type { ApprovalKind, ApprovalRequest } from '../policy/types.js';
import type { ApprovalResolutionPolicy } from '../policy/approval/resolution.js';
import type { PendingApprovalStore } from '../agent/approval-store.js';

export interface ApprovalStateSync {
  /** Check if child can reuse a parent session's existing approval. */
  checkParentApprovalReuse(
    parentSessionId: string,
    kind: ApprovalKind,
    command?: string,
  ): Promise<boolean>;

  /** Route a child agent's approval to the parent session. Returns a promise that resolves when the user decides. */
  routeApproval(
    approval: ApprovalRequest,
    parentSessionId: string,
  ): Promise<void>;
}

export class ApprovalStateSyncImpl implements ApprovalStateSync {
  constructor(private deps: {
    approvalResolution: ApprovalResolutionPolicy;
    pendingApprovals: PendingApprovalStore;
    /** Channel-agnostic callback to send an approval card/message to a chat. Returns messageId. */
    sendApprovalToChat: (
      chatId: string,
      approval: ApprovalRequest,
    ) => Promise<string>;
  }) {}

  async checkParentApprovalReuse(
    parentSessionId: string,
    kind: ApprovalKind,
    _command?: string,
  ): Promise<boolean> {
    const result = await this.deps.approvalResolution.checkReuse(parentSessionId, kind);
    return result.canReuse;
  }

  async routeApproval(
    approval: ApprovalRequest,
    parentSessionId: string,
  ): Promise<void> {
    // 1. Check if parent session already has an approval that covers this.
    const canReuse = await this.checkParentApprovalReuse(parentSessionId, approval.kind);
    if (canReuse) return;

    // 2. Mark the approval with parent context so the resolution callback
    //    can route the decision back to the original child agent.
    approval.parentAgentId = approval.agentId;
    approval.sessionId = parentSessionId;

    // 3. Send approval UI to parent session (channel-agnostic callback).
    //    The parent session's chatId is derived from sessionId.
    await this.deps.sendApprovalToChat(parentSessionId, approval);
  }
}
