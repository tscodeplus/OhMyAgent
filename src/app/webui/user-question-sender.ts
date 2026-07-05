/**
 * WebUIUserQuestionSender — sends user questions via SSE during agent execution.
 *
 * Implements the UserQuestionSender contract from src/agent/user-question-port.ts.
 *
 * Flow:
 *   1. Agent calls ask_user_question → sendQuestion() → SSE "user_question"
 *   2. Frontend renders a question dialog with options + text input
 *   3. User selects option or types answer → POST /api/questions/:id/answer
 *   4. Backend resolves the pending question → agent continues
 *   5. closeQuestion() → SSE "user_question_resolved" to update the UI
 */

import type { UserQuestionSender, UserQuestionOption } from '../../agent/user-question-port.js';

export function createWebUIUserQuestionSender(
  sendSSE: (data: Record<string, unknown>) => void,
): UserQuestionSender {
  return {
    async sendQuestion(
      _chatId: string,
      requestId: string,
      question: string,
      options?: UserQuestionOption[],
    ): Promise<string | undefined> {
      sendSSE({
        type: 'user_question',
        requestId,
        question,
        options: options?.map((o) => ({ label: o.label, value: o.value })) ?? [],
      });
      return requestId;
    },

    async closeQuestion(
      _chatId: string,
      _cardMessageId: string | undefined,
      answer: string,
    ): Promise<void> {
      sendSSE({
        type: 'user_question_resolved',
        requestId: _cardMessageId,
        answer,
      });
    },
  };
}
