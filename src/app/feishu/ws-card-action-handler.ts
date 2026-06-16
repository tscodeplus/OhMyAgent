/**
 * WebSocket Card Action Handler
 *
 * Extracted from bootstrap.ts (Phase 9d). Handles Feishu approval card
 * button clicks received via WebSocket (cardActionHandler callback).
 */

import { i18n } from '../../i18n/index.js';
import { generateId } from '../../shared/ids.js';
import { renderApprovalResultCard } from '../../../extensions/channel-feishu/render/approval-card-renderer.js';
import type { AgentFactory } from '../../agent/agent-factory.js';
import type { ApprovalDecisionType } from '../types.js';
import type { ApprovalDecisionRepository } from '../../memory/repositories/approval-decision-repository.js';
import type { ApprovalRequestRepository } from '../../memory/repositories/approval-request-repository.js';
import type { ReplyApprovalRegistry } from '../../../extensions/channel-feishu/render/reply-approval-registry.js';

export interface WSCardActionHandlerOptions {
  agentFactory: AgentFactory;
  replyApprovalRegistry: ReplyApprovalRegistry;
  approvalDecisionRepository: ApprovalDecisionRepository;
  approvalRequestRepo: ApprovalRequestRepository;
}

/** Create the cardActionHandler callback for FeishuWSClient. */
export function createWSCardActionHandler(
  opts: WSCardActionHandlerOptions,
): (callback: any) => Promise<{ code?: number; toast?: { type: string; content: string }; card?: { type: string; data: Record<string, unknown> } }> {
  return async (callback: any) => {
    const value = callback?.action?.value ?? {};
    const { action, requestId, command, risk } = value;
    const approvalTracker = opts.replyApprovalRegistry.get(callback?.context?.open_message_id);

    if (!requestId || !action) {
      return { code: 0 };
    }

    const decision = action as 'approve_once' | 'approve_session' | 'approve_always' | 'reject_once' | 'reject_always';
    const resolved = opts.agentFactory.resolveApproval(requestId, decision);

    if (!resolved) {
      const existingDecision = opts.approvalDecisionRepository.findLatestByRequestId(requestId);
      const resultCard = renderApprovalResultCard(
        (existingDecision?.decision as ApprovalDecisionType) ?? 'reject_once',
        {
          id: requestId,
          command: command ?? 'unknown',
          risk: (risk as 'low' | 'medium' | 'high') ?? 'low',
          sessionId: '',
          timestamp: Date.now(),
        },
      );
      return {
        toast: { type: 'info', content: i18n.t('bootstrap:toast.alreadyHandled') },
        card: { type: 'raw', data: resultCard },
      };
    }

    // Persist the decision to DB for audit trail
    opts.approvalDecisionRepository.create({
      id: generateId(),
      request_id: requestId,
      decided_by: 'user',
      decision,
    });
    opts.approvalRequestRepo.update(requestId, {
      status: decision.startsWith('approve') ? 'approved' : 'rejected',
      decision_mode: decision,
    });

    if (approvalTracker) {
      await approvalTracker.resolve(requestId, decision, { skipRecall: true });
    }

    // Build result card to replace the approval card
    const resultCard = renderApprovalResultCard(decision, {
      id: requestId,
      command: command ?? 'unknown',
      risk: risk ?? 'low',
      sessionId: '',
      timestamp: Date.now(),
    });

    const toastContent =
      decision === 'approve_once' ? i18n.t('bootstrap:toast.approvedOnce') :
      decision === 'approve_session' ? i18n.t('bootstrap:toast.approvedSession') :
      decision === 'approve_always' ? i18n.t('bootstrap:toast.approvedAlways') :
      decision === 'reject_once' ? i18n.t('bootstrap:toast.deniedOnce') :
      i18n.t('bootstrap:toast.deniedAlways');

    return {
      toast: {
        type: decision.startsWith('approve') ? 'success' : 'error',
        content: toastContent,
      },
      card: { type: 'raw', data: resultCard },
    };
  };
}
