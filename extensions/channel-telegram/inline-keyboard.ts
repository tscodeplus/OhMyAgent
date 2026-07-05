/**
 * Telegram Inline Keyboard builders for approval actions and agent switching.
 *
 * Provides utilities to encode / decode CallbackAction payloads within
 * Telegram's 64-byte callback_data limit, with automatic abbreviation for
 * approval actions when the serialised JSON exceeds the limit.
 */

import type { CallbackAction } from './telegram-types.js';

/**
 * Maximum length of Telegram inline keyboard callback_data (bytes).
 * @see https://core.telegram.org/bots/api#inlinekeyboardbutton
 */
const MAX_CALLBACK_DATA = 64;

// ---------------------------------------------------------------------------
// Approval keyboard
// ---------------------------------------------------------------------------

/**
 * Build an inline keyboard markup for approval decisions.
 *
 * Row 1: [Approve Once]  [Approve Session]
 * Row 2: [Approve Always] [Reject]
 */
export function buildApprovalKeyboard(requestId: string): object {
  return {
    inline_keyboard: [
      [
        {
          text: '✅ Approve Once',
          callback_data: encodeCallbackAction({
            type: 'approve',
            requestId,
            decision: 'approve_once',
          }),
        },
        {
          text: '✅ Approve Session',
          callback_data: encodeCallbackAction({
            type: 'approve',
            requestId,
            decision: 'approve_session',
          }),
        },
      ],
      [
        {
          text: '✅ Approve Always',
          callback_data: encodeCallbackAction({
            type: 'approve',
            requestId,
            decision: 'approve_always',
          }),
        },
        {
          text: '❌ Reject',
          callback_data: encodeCallbackAction({
            type: 'approve',
            requestId,
            decision: 'reject_once',
          }),
        },
      ],
    ],
  };
}

// ---------------------------------------------------------------------------
// Agent-switch keyboard
// ---------------------------------------------------------------------------

/**
 * Build an inline keyboard markup for switching agents.
 * One button per agent, each bearing the agent's display name.
 */
export function buildAgentSwitchKeyboard(
  agents: Array<{ id: string; name: string }>,
): object {
  return {
    inline_keyboard: agents.map((agent) => [
      {
        text: agent.name,
        callback_data: encodeCallbackAction({
          type: 'agent_switch',
          agentId: agent.id,
        }),
      },
    ]),
  };
}

// ---------------------------------------------------------------------------
// Encode / decode
// ---------------------------------------------------------------------------

/**
 * Encode a CallbackAction into a callback_data string.
 *
 * When the JSON representation exceeds 64 bytes, approval actions are
 * abbreviated:
 *   - requestId  -> "i"
 *   - decision   -> "d"  (with a short-code map)
 */
export function encodeCallbackAction(action: CallbackAction): string {
  const json = JSON.stringify(action);
  if (json.length <= MAX_CALLBACK_DATA) return json;

  // Only approval actions have a meaningful abbreviation strategy.
  if (action.type === 'approve') {
    const decisionMap: Record<string, string> = {
      approve_once: 'ao',
      approve_session: 'as',
      approve_always: 'aa',
      reject_once: 'ro',
      reject_always: 'ra',
    };

    const compact = JSON.stringify({
      type: 'approve',
      i: action.requestId,
      d: decisionMap[action.decision] ?? action.decision,
    });

    if (compact.length <= MAX_CALLBACK_DATA) return compact;
  }

  // Abbreviate question_answer actions: requestId → r, answer → a
  if (action.type === 'question_answer') {
    const compact = JSON.stringify({
      type: 'question_answer',
      r: action.requestId,
      a: action.answer,
    });

    if (compact.length <= MAX_CALLBACK_DATA) return compact;
  }

  // Fallback: truncate to the byte limit (last resort).
  return json.slice(0, MAX_CALLBACK_DATA);
}

/**
 * Parse a callback_data string back into a CallbackAction.
 * Handles both full and abbreviated serialisations.
 * Returns null when the data is invalid or unrecognised.
 */
export function parseCallbackAction(data: string): CallbackAction | null {
  try {
    const parsed: unknown = JSON.parse(data);
    if (typeof parsed !== 'object' || parsed === null) return null;

    const record = parsed as Record<string, unknown>;

    if (record.type === 'approve') {
      return parseApproveAction(record);
    }

    if (record.type === 'agent_switch') {
      const agentId = record.agentId;
      if (typeof agentId !== 'string' || !agentId) return null;
      return { type: 'agent_switch', agentId };
    }

    if (record.type === 'stop') {
      return { type: 'stop' };
    }

    if (record.type === 'question_answer') {
      // Accept both full (requestId, answer) and abbreviated (r, a) keys.
      const requestId = (record.requestId ?? record.r) as string | undefined;
      const answer = (record.answer ?? record.a) as string | undefined;
      if (!requestId || answer === undefined) return null;
      return { type: 'question_answer', requestId, answer };
    }

    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Parse an approval action, normalising abbreviated field names.
 */
function parseApproveAction(
  record: Record<string, unknown>,
): CallbackAction | null {
  // Accept both full (requestId, decision) and abbreviated (i, d) keys.
  const requestId = (record.requestId ?? record.i) as string | undefined;
  const decision = (record.decision ?? record.d) as string | undefined;

  if (!requestId || !decision) return null;

  // Normalise abbreviated decisions back to their full form.
  const reverseMap: Record<string, string> = {
    ao: 'approve_once',
    as: 'approve_session',
    aa: 'approve_always',
    ro: 'reject_once',
    ra: 'reject_always',
  };

  const normalizedDecision = reverseMap[decision] ?? decision;
  const validDecisions = [
    'approve_once',
    'approve_session',
    'approve_always',
    'reject_once',
    'reject_always',
  ] as const;

  if (!validDecisions.includes(normalizedDecision as typeof validDecisions[number])) {
    return null;
  }

  return {
    type: 'approve',
    requestId,
    decision: normalizedDecision as CallbackAction extends { type: 'approve' }
      ? CallbackAction['decision']
      : never,
  };
}
