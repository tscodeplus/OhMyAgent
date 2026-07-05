/**
 * WechatUserQuestionSender — sends user questions as text messages since
 * WeChat does not support interactive cards or inline keyboards.
 *
 * Implements the UserQuestionSender contract from src/agent/user-question-port.ts.
 *
 * Flow:
 *   1. Agent calls ask_user_question → sendQuestion() → WeChat text message
 *      with numbered options and instructions to reply with number or text
 *   2. User replies with text → message-handler detects pending question
 *      and resolves via UserQuestionStore.resolveFirstPendingQuestion()
 *   3. closeQuestion() → send follow-up confirmation message
 */

import type { UserQuestionSender, UserQuestionOption } from '../../src/agent/user-question-port.js';
import { sendChunkedText } from './wechat-sender.js';
import type { Logger } from 'pino';

export interface WechatUserQuestionDeps {
  apiBase: string;
  botToken: string;
  toUserId: string;
  contextToken: string;
  textLimit: number;
  logger?: Logger;
}

export function createWechatUserQuestionSender(
  deps: WechatUserQuestionDeps,
): UserQuestionSender {
  const { apiBase, botToken, toUserId, contextToken, textLimit, logger } = deps;

  return {
    async sendQuestion(
      _chatId: string,
      requestId: string,
      question: string,
      options?: UserQuestionOption[],
    ): Promise<string | undefined> {
      let text = `🤔 **${question}**`;

      if (options && options.length > 0) {
        text += '\n\n请回复以下选项编号或直接输入你的回答：';
        for (let i = 0; i < options.length; i++) {
          text += `\n${i + 1}. ${options[i].label}`;
        }
      } else {
        text += '\n\n请直接回复你的回答。';
      }

      try {
        await sendChunkedText(
          apiBase,
          botToken,
          toUserId,
          contextToken,
          text,
          textLimit,
          logger,
        );
      } catch {
        // If we can't send, the tool will fall back
      }

      // WeChat does not return message IDs that can be used later
      return undefined;
    },

    async closeQuestion(
      _chatId: string,
      _cardMessageId: string | undefined,
      _answer: string,
    ): Promise<void> {
      // WeChat does not support editing messages. The message handler already
      // sent "✅ 已收到回答" when the user typed their answer, so we don't
      // send a duplicate here.
    },
  };
}
