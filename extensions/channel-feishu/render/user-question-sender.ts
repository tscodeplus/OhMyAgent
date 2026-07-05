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
 *   4. closeQuestion() → recall the card (best-effort)
 */

import type { UserQuestionSender, UserQuestionOption } from '../../../src/agent/user-question-port.js';

export interface FeishuUserQuestionDeps {
  /** Send an interactive card and return its message_id. */
  sendCard(chatId: string, card: Record<string, unknown>): Promise<string>;
  /** Recall (delete) a message by ID. */
  recallMessage?(messageId: string): Promise<void>;
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
        const actions: Record<string, unknown>[] = options.map((opt) => ({
          tag: 'button',
          text: { tag: 'plain_text', content: opt.label },
          type: 'primary',
          value: {
            action: 'answer_question',
            requestId,
            answer: opt.value,
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
      _answer: string,
    ): Promise<void> {
      if (cardMessageId && deps.recallMessage) {
        try {
          await deps.recallMessage(cardMessageId);
        } catch {
          // Card recall failure is not critical
        }
      }
    },
  };
}
