/**
 * TelegramUserQuestionSender — sends user questions via Telegram messages
 * with inline keyboard buttons.
 *
 * Implements the UserQuestionSender contract from src/agent/user-question-port.ts.
 *
 * Flow:
 *   1. Agent calls ask_user_question → sendQuestion() → Telegram message
 *      with option buttons as inline keyboard
 *   2. User clicks a button → callback_query handler resolves via UserQuestionStore
 *   3. closeQuestion() → edit message to show answer, remove keyboard
 */

import type { UserQuestionSender, UserQuestionOption } from '../../src/agent/user-question-port.js';
import { encodeCallbackAction } from './inline-keyboard.js';
import type { Bot } from 'grammy';

export function createTelegramUserQuestionSender(bot: Bot): UserQuestionSender {
  return {
    async sendQuestion(
      chatId: string,
      requestId: string,
      question: string,
      options?: UserQuestionOption[],
    ): Promise<string | undefined> {
      const chatIdNum = Number(chatId);

      let text = `🤔 **${escapeHtml(question)}**`;

      if (options && options.length > 0) {
        text += '\n\n_你也可以直接回复文字回答_';

        // Each option in its own row to avoid horizontal truncation
        const keyboard = {
          inline_keyboard: options.map((opt) => ([{
            text: opt.label,
            callback_data: encodeCallbackAction({
              type: 'question_answer',
              requestId,
              answer: opt.value,
            }),
          }])),
        };

        const msg = await bot.api.sendMessage(chatIdNum, text, {
          parse_mode: 'HTML',
          reply_markup: keyboard,
        });
        return String(msg.message_id);
      } else {
        // No options — just prompt for text reply
        text += '\n\n_请直接回复你的回答_';
        const msg = await bot.api.sendMessage(chatIdNum, text, {
          parse_mode: 'HTML',
        });
        return String(msg.message_id);
      }
    },

    async closeQuestion(
      _chatId: string,
      cardMessageId: string | undefined,
      answer: string,
    ): Promise<void> {
      if (!cardMessageId) return;
      const chatIdNum = Number(_chatId);
      const messageIdNum = Number(cardMessageId);
      if (isNaN(chatIdNum) || isNaN(messageIdNum)) return;

      try {
        await bot.api.editMessageText(
          chatIdNum,
          messageIdNum,
          `🤔 **问题已解决**\n\n✅ 回答: ${escapeHtml(answer)}`,
          { parse_mode: 'HTML', reply_markup: undefined },
        );
      } catch {
        // Message might have been deleted or edited already
      }
    },
  };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
