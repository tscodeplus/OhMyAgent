/**
 * QQUserQuestionSender — sends user questions via QQ Bot API markdown messages
 * with keyboard buttons.
 *
 * Implements the UserQuestionSender contract from src/agent/user-question-port.ts.
 *
 * Flow:
 *   1. Agent calls ask_user_question → sendQuestion() → QQ markdown message
 *      with keyboard buttons
 *   2. User clicks a button → INTERACTION_CREATE event resolves via UserQuestionStore
 *   3. closeQuestion() → send follow-up answer message (QQ cannot edit messages)
 */

import type { UserQuestionSender, UserQuestionOption } from '../../src/agent/user-question-port.js';
import type { QQGateway } from './qq-gateway.js';
import { sendKeyboardMessage, sendChunkedText } from './send-message.js';
import { buildQuestionKeyboard } from './qq-keyboard.js';

export interface QQUserQuestionDeps {
  gateway: QQGateway;
  logger?: { error: (...args: any[]) => void; warn: (...args: any[]) => void };
}

/**
 * Create a QQ UserQuestionSender.
 *
 * chatId format: "u:<openid>" for C2C, "g:<groupOpenid>" for groups.
 */
export function createQQUserQuestionSender(
  deps: QQUserQuestionDeps,
): UserQuestionSender {
  const { gateway, logger } = deps;

  return {
    async sendQuestion(
      chatId: string,
      requestId: string,
      question: string,
      options?: UserQuestionOption[],
    ): Promise<string | undefined> {
      const target = parseChatId(chatId);

      let markdown = `**🤔 ${question}**`;

      if (options && options.length > 0) {
        markdown += '\n\n_你也可以直接回复文字回答_';

        const keyboard = buildQuestionKeyboard(requestId, options);

        try {
          return await sendKeyboardMessage(gateway, {
            markdown,
            keyboard,
            target,
            logger,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger?.error('[QQ sendQuestion failed]', msg);
          throw err;
        }
      } else {
        // No options — send text message only
        markdown += '\n\n_请直接回复你的回答_';
        try {
          await sendChunkedText(gateway, markdown, target, 2000);
          return undefined;
        } catch {
          return undefined;
        }
      }
    },

    async closeQuestion(
      _chatId: string,
      _cardMessageId: string | undefined,
      _answer: string,
    ): Promise<void> {
      // QQ does not support editing messages. The interaction handler already
      // sent a follow-up result message when the button was clicked, so we
      // don't send another one here. For text replies, the message handler
      // also sends an acknowledgment.
    },
  };
}

function parseChatId(chatId: string): { openid?: string; groupOpenid?: string } {
  if (chatId.startsWith('g:')) {
    return { groupOpenid: chatId.slice(2) };
  }
  return { openid: chatId.startsWith('u:') ? chatId.slice(2) : chatId };
}
