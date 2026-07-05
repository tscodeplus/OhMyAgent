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

import type { UserQuestionSender, UserQuestionOption } from '../../../src/agent/user-question-port.js';

export interface FeishuUserQuestionDeps {
  /** Send an interactive card and return its message_id. */
  sendCard(chatId: string, card: Record<string, unknown>): Promise<string>;
  /** Update an existing card message (non-CardKit PATCH). */
  updateCard(messageId: string, card: Record<string, unknown>): Promise<void>;
}

export function createFeishuUserQuestionSender(
  deps: FeishuUserQuestionDeps,
): UserQuestionSender {
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
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**${question}**`,
        },
      });

      if (options && options.length > 0) {
        // Hint for free-text input
        elements.push({
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: '_你也可以直接回复文字回答_',
          },
        });
        elements.push({ tag: 'hr' });

        // Action buttons — one per option
        // Use the human-readable label as the answer value so the result
        // card shows "你的回答: 中餐" instead of "你的回答: opt_0".
        const actions: Record<string, unknown>[] = options.map((opt) => ({
          tag: 'button',
          text: { tag: 'plain_text', content: opt.label },
          type: 'primary',
          value: {
            action: 'answer_question',
            requestId,
            answer: opt.label,
          },
        }));

        elements.push({
          tag: 'action',
          actions,
        });
      } else {
        // No options — hint for text reply
        elements.push({
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: '_请直接回复你的回答_',
          },
        });
      }

      const card = {
        header: {
          title: {
            tag: 'plain_text',
            content: '🤔 需要你的回答',
          },
          template: 'blue',
        },
        elements,
      };

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
    ): Promise<void> {
      if (!cardMessageId) return;

      // Update the question card to show the answer.
      // If the user clicked a button, ws-card-action-handler already replaced
      // the card — this update is redundant but harmless. If the user typed
      // a text answer, this is the only UI update.
      const resultCard = {
        header: {
          title: { tag: 'plain_text', content: '✅ 回答已收到' },
          template: 'green' as const,
        },
        elements: [
          {
            tag: 'div',
            text: {
              tag: 'lark_md',
              content: `**你的回答**: ${String(answer)}`,
            },
          },
        ],
      };

      try {
        await deps.updateCard(cardMessageId, resultCard);
      } catch {
        // Card update failure is not critical — the ws handler may have
        // already replaced it, or the message may no longer exist.
      }
    },
  };
}
