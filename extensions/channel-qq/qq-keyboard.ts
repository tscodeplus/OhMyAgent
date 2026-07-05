/**
 * QQ Keyboard builder for approval actions.
 *
 * Button data format matches OpenClaw: "approve:<requestId>:<decision>"
 */

import type { QQKeyboard } from './qq-types.js';

const DECISION_LABEL: Record<string, string> = {
  approve_once: 'allow-once',
  approve_session: 'allow-session',
  approve_always: 'allow-always',
  reject_once: 'deny',
};

const LABEL_DECISION: Record<string, string> = {
  'allow-once': 'approve_once',
  'allow-session': 'approve_session',
  'allow-always': 'approve_always',
  'deny': 'reject_once',
};

function enc(requestId: string, decision: string): string {
  return `approve:${requestId}:${DECISION_LABEL[decision] ?? decision}`;
}

function makeBtn(id: string, label: string, requestId: string, decision: string, style: 0 | 1) {
  return {
    id,
    render_data: { label, visited_label: label, style },
    action: {
      type: 1 as const,
      permission: { type: 2 as const },
      data: enc(requestId, decision),
      click_limit: 1,
    },
    group_id: 'approval',
  };
}

export function buildApprovalKeyboard(
  requestId: string,
  labels: { approveOnce: string; approveSession: string; alwaysAllow: string; denyOnce: string },
): QQKeyboard {
  return {
    content: {
      rows: [
        {
          buttons: [
            makeBtn('allow', labels.approveOnce, requestId, 'approve_once', 1),
            makeBtn('session', labels.approveSession, requestId, 'approve_session', 1),
          ],
        },
        {
          buttons: [
            makeBtn('always', labels.alwaysAllow, requestId, 'approve_always', 1),
            makeBtn('deny', labels.denyOnce, requestId, 'reject_once', 0),
          ],
        },
      ],
    },
  };
}

export function parseApprovalCallback(
  buttonData: string,
): { requestId: string; decision: string } | null {
  const m = buttonData.match(/^approve:(.+):(allow-once|allow-session|allow-always|deny)$/);
  if (!m) return null;
  return { requestId: m[1], decision: LABEL_DECISION[m[2]] ?? m[2] };
}

// ---------------------------------------------------------------------------
// Question keyboard (for ask_user_question tool)
// ---------------------------------------------------------------------------

/**
 * Build a QQ Keyboard for user question options.
 * Button data format: "question|<requestId>|<value>"
 * Using | as delimiter avoids issues when option labels contain ':'.
 */
export function buildQuestionKeyboard(
  requestId: string,
  options: Array<{ label: string; value: string }>,
): QQKeyboard {
  const buttons = options.map((opt, i) => ({
    id: `q_${i}`,
    render_data: { label: opt.label, visited_label: opt.label, style: 1 as const },
    action: {
      type: 1 as const,
      permission: { type: 2 as const },
      data: `question|${requestId}|${opt.value}`,
      click_limit: 1,
    },
    group_id: 'question',
  }));

  return {
    content: {
      rows: [{
        buttons,
      }],
    },
  };
}

/**
 * Parse a question answer from button data.
 * Format: "question|<requestId>|<value>"
 * Returns null if the data is not a question answer.
 */
export function parseQuestionCallback(
  buttonData: string,
): { requestId: string; answer: string } | null {
  // Format: question|<requestId>|<answer>
  if (!buttonData.startsWith('question|')) return null;
  const rest = buttonData.slice('question|'.length);
  const sepIdx = rest.indexOf('|');
  if (sepIdx < 0) return null;
  return { requestId: rest.slice(0, sepIdx), answer: rest.slice(sepIdx + 1) };
}
