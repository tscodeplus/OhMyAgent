/**
 * WebSocket Card Action Handler
 *
 * Extracted from bootstrap.ts (Phase 9d). Handles Feishu approval card
 * button clicks received via WebSocket (cardActionHandler callback).
 */

import { i18n } from '../../i18n/index.js';
import { generateId } from '../../shared/ids.js';
import { harnessApprovalRegistry } from '../../harness/harness-approval-registry.js';
import {
  renderApprovalResultCard,
  renderHarnessEditCard,
  renderHarnessResultCard,
} from '../../../extensions/channel-feishu/render/approval-card-renderer.js';
import { buildCard20 } from '../../../extensions/channel-feishu/render/card20.js';
import type { AgentFactory } from '../../agent/agent-factory.js';
import type { ApprovalDecisionType } from '../types.js';
import type { ApprovalDecisionRepository } from '../../memory/repositories/approval-decision-repository.js';
import type { ApprovalRequestRepository } from '../../memory/repositories/approval-request-repository.js';
import type { ReplyApprovalRegistry } from '../../../extensions/channel-feishu/render/reply-approval-registry.js';
import type { UserQuestionStore } from '../../agent/user-question-store.js';

export interface WSCardActionHandlerOptions {
  agentFactory: AgentFactory;
  replyApprovalRegistry: ReplyApprovalRegistry;
  approvalDecisionRepository: ApprovalDecisionRepository;
  approvalRequestRepo: ApprovalRequestRepository;
  userQuestionStore?: UserQuestionStore;
}

/** Create the cardActionHandler callback for FeishuWSClient. */
export function createWSCardActionHandler(opts: WSCardActionHandlerOptions): (
  callback: any,
) => Promise<{
  code?: number;
  toast?: { type: string; content: string };
  card?: { type: string; data: Record<string, unknown> };
}> {
  return async (callback: any) => {
    const rawAction = callback?.action ?? {};

    // Resolve the interaction payload. Buttons put it in action.value
    // (object or JSON string); select_static dropdowns deliver the chosen
    // option's value in action.option (a JSON string, or already parsed by
    // some clients) and the component-level behaviors value in action.value.
    let value: Record<string, unknown> = {};
    const rawValue = rawAction.value;
    if (rawValue && typeof rawValue === 'object') {
      value = rawValue as Record<string, unknown>;
    } else if (typeof rawValue === 'string') {
      try {
        value = JSON.parse(rawValue) as Record<string, unknown>;
      } catch {
        value = {};
      }
    }
    const optionValue = (rawAction as { option?: unknown }).option;
    if (optionValue !== undefined && optionValue !== null) {
      let parsed: Record<string, unknown>;
      if (optionValue && typeof optionValue === 'object') {
        parsed = optionValue as Record<string, unknown>;
      } else {
        try {
          parsed = JSON.parse(String(optionValue)) as Record<string, unknown>;
        } catch {
          // Plain (non-JSON) option value — treat it as the answer itself.
          parsed = { answer: String(optionValue) };
        }
      }
      value = { ...value, ...parsed };
    }

    const action = typeof value.action === 'string' ? value.action : undefined;
    const requestId = typeof value.requestId === 'string' ? value.requestId : undefined;
    const command = typeof value.command === 'string' ? value.command : undefined;
    const risk =
      value.risk === 'low' || value.risk === 'medium' || value.risk === 'high'
        ? value.risk
        : undefined;
    const approvalTracker = opts.replyApprovalRegistry.get(callback?.context?.open_message_id);

    // ── harness_improvement: task failure analysis proposal buttons ──
    // These cards carry { proposalId, action } (no requestId) and route via
    // the process-wide harness approval registry.
    if (!requestId && value.proposalId && action) {
      const proposalId = String(value.proposalId);
      const harnessAction = String(action);

      // 'edit' is a two-step flow: the first click swaps in an edit form card
      // (prefilled with the current proposal value); the decision resolves
      // when the form's submit button (action 'edit_submit') delivers the
      // edited content via the callback's form_value.
      if (harnessAction === 'edit') {
        const entry = harnessApprovalRegistry.get(proposalId);
        if (!entry) {
          return {
            toast: { type: 'info', content: i18n.t('bootstrap:toast.alreadyHandled') },
            card: { type: 'raw', data: renderHarnessResultCard('handled') },
          };
        }
        return {
          toast: { type: 'info', content: i18n.t('bootstrap:toast.harnessEditHint') },
          card: {
            type: 'raw',
            data: renderHarnessEditCard(proposalId, entry.editedDefault ?? ''),
          },
        };
      }

      const isEditSubmit = harnessAction === 'edit_submit';
      const decision = isEditSubmit ? 'edit' : harnessAction;
      const formValue = (callback?.action?.form_value ?? callback?.action?.formValue) as
        Record<string, unknown> | undefined;
      const editedValue =
        isEditSubmit && formValue && typeof formValue.editedValue === 'string'
          ? formValue.editedValue
          : undefined;
      const resolved = harnessApprovalRegistry.resolve(
        proposalId,
        decision as 'approve' | 'reject' | 'dismiss' | 'edit',
        editedValue,
      );
      if (!resolved) {
        return {
          toast: { type: 'info', content: i18n.t('bootstrap:toast.alreadyHandled') },
          // Replace the card so the stale buttons can no longer be clicked.
          card: { type: 'raw', data: renderHarnessResultCard('handled') },
        };
      }
      const applied = harnessAction === 'approve' || isEditSubmit;
      const toastContent = applied
        ? i18n.t('bootstrap:toast.harnessApproved')
        : harnessAction === 'reject'
          ? i18n.t('bootstrap:toast.harnessRejected')
          : i18n.t('bootstrap:toast.harnessIgnored');
      return {
        toast: {
          type: applied ? 'success' : 'info',
          content: toastContent,
        },
        // Replace the original card (same mechanism as approval cards) so the
        // action buttons are removed once a decision is made.
        card: {
          type: 'raw',
          data: renderHarnessResultCard(
            isEditSubmit
              ? 'edit'
              : harnessAction === 'approve'
                ? 'approve'
                : harnessAction === 'reject'
                  ? 'reject'
                  : 'dismiss',
          ),
        },
      };
    }

    if (!requestId || !action) {
      return { code: 0 };
    }

    // ── answer_question: handle ask_user_question option click ──
    if (action === 'answer_question' && value.answer) {
      const resolved = opts.userQuestionStore?.resolve(requestId, String(value.answer));
      if (!resolved) {
        return {
          toast: { type: 'info', content: i18n.t('bootstrap:toast.alreadyHandled') },
          card: {
            type: 'raw',
            data: buildCard20('✅ 已回答', 'green', [
              { tag: 'markdown', content: '你的回答已收到。' },
            ]),
          },
        };
      }
      return {
        toast: { type: 'success', content: '回答已提交' },
        card: {
          type: 'raw',
          data: buildCard20('✅ 回答已收到', 'green', [
            { tag: 'markdown', content: `**你的回答**: ${String(value.answer)}` },
          ]),
        },
      };
    }

    const decision = action as
      'approve_once' | 'approve_session' | 'approve_always' | 'reject_once' | 'reject_always';

    // ── Operator identity verification ──
    // Only the request initiator (requester) may decide an approval. The
    // WS path (normalized by the lark SDK) carries operator.openId; the HTTP
    // card action body carries operator.open_id.
    const operatorId: string =
      (callback?.operator?.openId as string | undefined) ??
      (callback?.operator?.open_id as string | undefined) ??
      '';
    if (opts.approvalRequestRepo) {
      const record = opts.approvalRequestRepo.findById(requestId);
      if (record) {
        if (record.requester_id) {
          if (!operatorId || operatorId !== record.requester_id) {
            return {
              toast: { type: 'error', content: i18n.t('bootstrap:toast.approvalNotAuthorized') },
            };
          }
        } else {
          // No requester identity recorded (legacy/cron-created request).
          // Fail closed: an unverifiable approval must not be decidable.
          return {
            toast: { type: 'error', content: i18n.t('bootstrap:toast.approvalRequesterUnknown') },
          };
        }
      }
    }

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
      decided_by: operatorId || 'user',
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
      decision === 'approve_once'
        ? i18n.t('bootstrap:toast.approvedOnce')
        : decision === 'approve_session'
          ? i18n.t('bootstrap:toast.approvedSession')
          : decision === 'approve_always'
            ? i18n.t('bootstrap:toast.approvedAlways')
            : decision === 'reject_once'
              ? i18n.t('bootstrap:toast.deniedOnce')
              : i18n.t('bootstrap:toast.deniedAlways');

    return {
      toast: {
        type: decision.startsWith('approve') ? 'success' : 'error',
        content: toastContent,
      },
      card: { type: 'raw', data: resultCard },
    };
  };
}
