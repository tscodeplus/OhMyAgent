/**
 * FeishuUserQuestionSender — sends user questions via Feishu interactive cards.
 *
 * Implements the UserQuestionSender contract from src/agent/user-question-port.ts.
 *
 * Flow:
 *   1. Agent calls ask_user_question → sendQuestion() → Feishu interactive card
 *      with option buttons
 *   2. User clicks a button → WebSocket card.action.trigger
 *   3. ws-card-action-handler resolves via UserQuestionStore.resolve()
 *      AND returns a replacement card showing the answer
 *   4. closeQuestion() → update the card to show the answer (idempotent —
 *      if ws handler already replaced it, the update is redundant but harmless)
 *
 *   2b. User types a text answer → message-handler resolves via
 *       resolveFirstPendingQuestion()
 *   3b. closeQuestion() → update the card to "answered" state
 */

import type {
  UserQuestionSender,
  UserQuestionOption,
} from '../../../src/agent/user-question-port.js';
import { buildCard20, button20 } from './card20.js';

/**
 * Button text is a single line — labels longer than this truncate. When any
 * option exceeds the threshold, a numbered markdown list (which wraps
 * naturally) is rendered above the buttons so the full text stays readable;
 * list numbers map 1:1 to the button order.
 */
const SHORT_OPTION_LABEL_MAX = 10;

export interface FeishuUserQuestionDeps {
  /** Send an interactive card and return its message_id. */
  sendCard(chatId: string, card: Record<string, unknown>): Promise<string>;
  /** Update an existing card message (non-CardKit PATCH). */
  updateCard(messageId: string, card: Record<string, unknown>): Promise<void>;
}

export function createFeishuUserQuestionSender(deps: FeishuUserQuestionDeps): UserQuestionSender {
  return {
    async sendQuestion(
      chatId: string,
      requestId: string,
      question: string,
      options?: UserQuestionOption[],
    ): Promise<string | undefined> {
      const elements: Record<string, unknown>[] = [];

      // Question text
      elements.push({
        tag: 'markdown',
        content: `**${question}**`,
      });

      if (options && options.length > 0) {
        // Hint for free-text input
        elements.push({
          tag: 'markdown',
          content: '_你也可以直接回复文字回答_',
        });
        elements.push({ tag: 'hr' });

        const answerValue = (label: string) => ({
          action: 'answer_question',
          requestId,
          // Human-readable label as the answer value so the result
          // card shows "你的回答: 中餐" instead of "你的回答: opt_0".
          answer: label,
        });

        // Buttons cannot wrap — their text truncates on a single line. For
        // long labels, render the full option text as a numbered markdown
        // list (markdown wraps) directly above the buttons; the list order
        // matches the button order.
        if (options.some((opt) => opt.label.length > SHORT_OPTION_LABEL_MAX)) {
          elements.push({
            tag: 'markdown',
            content: options.map((opt, i) => `${i + 1}. ${opt.label}`).join('\n'),
          });
        }

        // One full-width button per row (2.0 stacks buttons placed directly
        // in body.elements vertically) — avoids the cramped 2-per-row grid
        // that forced text wrapping.
        elements.push(
          ...options.map((opt) => button20(opt.label, 'primary', answerValue(opt.label))),
        );
      } else {
        // No options — hint for text reply
        elements.push({
          tag: 'markdown',
          content: '_请直接回复你的回答_',
        });
      }

      const card = buildCard20('🤔 需要你的回答', 'blue', elements);

      try {
        const messageId = await deps.sendCard(chatId, card);
        return messageId;
      } catch {
        return undefined;
      }
    },

    async closeQuestion(
      _chatId: string,
      cardMessageId: string | undefined,
      answer: string,
      status: 'answered' | 'cancelled' = 'answered',
    ): Promise<void> {
      if (!cardMessageId) return;

      // Cancelled questions (steer/stop raced with the question) must not
      // claim the user answered — show an explicit cancelled state.
      const resultCard =
        status === 'cancelled'
          ? buildCard20('🚫 问题已取消', 'grey', [
              {
                tag: 'markdown',
                content: '问题已被取消（收到新指令或会话停止），你的回答未被记录。',
              },
            ])
          : buildCard20('✅ 回答已收到', 'green', [
              {
                tag: 'markdown',
                content: `**你的回答**: ${String(answer)}`,
              },
            ]);

      try {
        await deps.updateCard(cardMessageId, resultCard);
      } catch {
        // Card update failure is not critical — the ws handler may have
        // already replaced it, or the message may no longer exist.
      }
    },
  };
}
