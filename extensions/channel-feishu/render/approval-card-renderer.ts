/**
 * Approval card renderer for shell command approval requests.
 *
 * Produces a standard Feishu interactive card (not CardKit 2.0).
 */

import {
  assessCommandRisk,
} from '../../../src/tools/shell-command-policy.js';
import type { ApprovalDecisionType } from '../../../src/app/types.js';
import type { ReplyApprovalRecord } from './approval-tracker.js';
import { truncateCommand } from './cardkit-builder.js';
import { i18n } from '../../../src/i18n/index.js';

// ─── Types ───

export interface ApprovalRequest {
  id: string;
  command: string;
  risk: 'low' | 'medium' | 'high';
  description?: string;
  /** Reason the command requires approval (e.g. path outside allowed roots). */
  reason?: string;
  sessionId: string;
  timestamp: number;
}

// ─── Risk Assessment ───

/**
 * Assess the risk level of a shell command.
 *
 * Re-exported from the shared shell-command-policy module — the heuristic is
 * channel-agnostic and no longer lives here. Kept as a named export for
 * backward compatibility with existing importers.
 */
export { assessCommandRisk };

// ─── Card Rendering ───

const RISK_HEADER_TEMPLATE: Record<string, string> = {
  low: 'green',
  medium: 'orange',
  high: 'red',
};

const RISK_LABEL: Record<string, () => string> = {
  low: () => i18n.t('feishu-cards:approval.riskLow'),
  medium: () => i18n.t('feishu-cards:approval.riskMedium'),
  high: () => i18n.t('feishu-cards:approval.riskHigh'),
};

const STATUS_LABEL: Record<string, () => string> = {
  pending: () => i18n.t('feishu-cards:status.pending'),
  approved: () => i18n.t('feishu-cards:status.approved'),
  rejected: () => i18n.t('feishu-cards:status.rejected'),
};

/**
 * Render a Feishu interactive card for a shell command approval request.
 *
 * @returns A plain object suitable for `JSON.stringify` and sending via the
 *          Feishu message API (`msg_type: 'interactive'`).
 */
function getApprovalTitleKey(command: string): string {
  if (command.startsWith('computer_use ')) {
    return 'feishu-cards:card.computerUseApproval';
  }
  if (command.startsWith('file_read ') || command.startsWith('file_search ')) {
    return 'feishu-cards:card.fileAccessApproval';
  }
  return 'feishu-cards:card.shellCommandApproval';
}

export function renderApprovalCard(request: ApprovalRequest): Record<string, unknown> {
  const headerColor = 'blue';
  const riskLabel = RISK_LABEL[request.risk]?.() ?? request.risk;

  const elements: object[] = [];

  // Command detail
  elements.push({
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: `${i18n.t('feishu-cards:field.command')} \`${request.command}\``,
    },
  });

  // Risk level
  elements.push({
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: `${i18n.t('feishu-cards:field.riskLevel')} ${riskLabel}`,
    },
  });

  // Reason for approval (e.g. path outside allowed roots)
  if (request.reason) {
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `${i18n.t('feishu-cards:field.reason')} ${request.reason}`,
      },
    });
  }

  // Optional description
  if (request.description) {
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `${i18n.t('feishu-cards:field.description')} ${request.description}`,
      },
    });
  }

  // Divider before actions
  elements.push({ tag: 'hr' });

  // Action buttons — include command + risk in value for result card rendering
  const buttonMeta = {
    requestId: request.id,
    command: request.command,
    risk: request.risk,
  };

  elements.push({
    tag: 'action',
    actions: [
      {
        tag: 'button',
        text: { tag: 'plain_text', content: i18n.t('feishu-cards:button.approveOnce') },
        type: 'primary',
        value: { ...buttonMeta, action: 'approve_once' },
      },
      {
        tag: 'button',
        text: { tag: 'plain_text', content: i18n.t('feishu-cards:button.approveSession') },
        type: 'primary',
        value: { ...buttonMeta, action: 'approve_session' },
      },
      {
        tag: 'button',
        text: { tag: 'plain_text', content: i18n.t('feishu-cards:button.alwaysAllow') },
        type: 'primary',
        value: { ...buttonMeta, action: 'approve_always' },
      },
      {
        tag: 'button',
        text: { tag: 'plain_text', content: i18n.t('feishu-cards:button.denyOnce') },
        type: 'danger',
        value: { ...buttonMeta, action: 'reject_once' },
      },
    ],
  });

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: i18n.t(getApprovalTitleKey(request.command)) },
      template: headerColor,
    },
    elements,
  };
}

export function renderApprovalQueueCard(
  records: ReplyApprovalRecord[],
  options: {
    expanded?: boolean;
    initialVisibleCount?: number;
  } = {},
): Record<string, unknown> {
  const pending = records.filter(record => record.status === 'pending');
  const current = pending[0];
  const sortedHistory = [...records]
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const initialVisibleCount = options.initialVisibleCount ?? 3;
  const expanded = options.expanded ?? false;
  const showFullHistory = expanded || !current;
  const history = showFullHistory ? sortedHistory : sortedHistory.slice(0, initialVisibleCount);
  const hiddenCount = Math.max(0, sortedHistory.length - history.length);

  const elements: object[] = [
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: i18n.t('feishu-cards:overview.summary', { total: records.length, pending: pending.length }),
      },
    },
  ];

  if (current) {
    elements.push({ tag: 'hr' });
    const riskLabel = RISK_LABEL[current.risk]?.() ?? current.risk;
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: i18n.t('feishu-cards:overview.currentPending', { command: current.command, risk: riskLabel }),
      },
    });

    const buttonMeta = {
      requestId: current.requestId,
      command: current.command,
      risk: current.risk,
    };
    elements.push({
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: i18n.t('feishu-cards:button.approveOnce') },
          type: 'primary',
          value: { ...buttonMeta, action: 'approve_once' },
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: i18n.t('feishu-cards:button.approveSession') },
          type: 'primary',
          value: { ...buttonMeta, action: 'approve_session' },
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: i18n.t('feishu-cards:button.alwaysAllow') },
          type: 'primary',
          value: { ...buttonMeta, action: 'approve_always' },
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: i18n.t('feishu-cards:button.denyOnce') },
          type: 'danger',
          value: { ...buttonMeta, action: 'reject_once' },
        },
      ],
    });
  } else {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: i18n.t('feishu-cards:overview.allDone'),
      },
    });
  }

  if (history.length > 0) {
    elements.push({ tag: 'hr' });
    const lines = history.map((record, index) => {
      const prefix = `${index + 1}.`;
      const statusLabel = formatDecisionStatus(record);
      return `${prefix} **${statusLabel}** · \`${record.command}\``;
    });
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `${i18n.t('feishu-cards:overview.historyTitle')}\n${lines.join('\n')}`,
      },
    });
    if (hiddenCount > 0 || expanded) {
      elements.push({
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: {
              tag: 'plain_text',
              content: expanded
                ? i18n.t('feishu-cards:button.collapseHistory')
                : i18n.t('feishu-cards:button.expandMore', { count: hiddenCount }),
            },
            type: 'default',
            value: {
              action: expanded ? 'collapse_history' : 'expand_history',
            },
          },
        ],
      });
    }
  }

  return {
    config: { wide_screen_mode: true },
    header: {
      title: {
        tag: 'plain_text',
        content: current
          ? i18n.t('feishu-cards:card.replyApprovalQueue')
          : i18n.t('feishu-cards:card.approvalComplete'),
      },
      template: current ? 'orange' : 'green',
    },
    elements,
  };
}

function formatDecisionStatus(record: ReplyApprovalRecord): string {
  if (record.status === 'pending') {
    return i18n.t('feishu-cards:status.pending');
  }

  switch (record.decision) {
    case 'approve_once':
      return i18n.t('feishu-cards:status.approvedOnce');
    case 'approve_session':
      return i18n.t('feishu-cards:status.approvedSession');
    case 'approve_always':
      return i18n.t('feishu-cards:status.alwaysAllow');
    case 'reject_once':
      return i18n.t('feishu-cards:status.rejectedOnce');
    case 'reject_always':
      return i18n.t('feishu-cards:status.rejectedAlways');
    default:
      return STATUS_LABEL[record.status]?.() ?? record.status;
  }
}

// ─── Approval Result Card (post-decision) ───

/**
 * Render a card showing the approval decision result.
 * Replaces the original approval card after the user clicks a button.
 */
export function renderApprovalResultCard(
  decision: ApprovalDecisionType,
  request: ApprovalRequest,
  rejectReason?: 'timeout' | 'restart',
): Record<string, unknown> {
  const isApproved = decision.startsWith('approve');
  const headerColor = isApproved ? 'green' : 'red';

  const statusLabel =
    rejectReason && !isApproved
      ? (rejectReason === 'timeout'
          ? i18n.t('feishu-cards:status.rejectedTimeout')
          : i18n.t('feishu-cards:status.rejectedRestart'))
      : decision === 'approve_once' ? i18n.t('feishu-cards:status.approvedOnce') :
        decision === 'approve_session' ? i18n.t('feishu-cards:status.approvedSession') :
        decision === 'approve_always' ? i18n.t('feishu-cards:status.alwaysAllow') :
        decision === 'reject_once' ? i18n.t('feishu-cards:status.rejectedOnce') :
        i18n.t('feishu-cards:status.rejectedAlways');

  const truncated = truncateCommand(request.command, 100);

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: statusLabel },
      template: headerColor,
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: truncated,
        },
      },
    ],
  };
}
