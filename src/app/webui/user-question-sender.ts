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

import type Database from 'better-sqlite3';
import type { UserQuestionSender, UserQuestionOption } from '../../agent/user-question-port.js';

export function createWebUIUserQuestionSender(
  sendSSE: (data: Record<string, unknown>) => void,
  db?: Database.Database,
  sessionId?: string,
): UserQuestionSender {
  return {
    async sendQuestion(
      _chatId: string,
      requestId: string,
      question: string,
      options?: UserQuestionOption[],
    ): Promise<string | undefined> {
      const opts = options?.map((o) => ({ label: o.label, value: o.value })) ?? [];

      sendSSE({
        type: 'user_question',
        requestId,
        question,
        options: opts,
      });

      // Persist question as a message so it survives page refresh.
      // Uses "question-{requestId}" ID to match the frontend streaming message ID.
      if (db && sessionId) {
        try {
          const msgId = `question-${requestId}`;
          const meta = JSON.stringify({
            userQuestion: { requestId, question, options: opts, status: 'pending' },
          });
          db.prepare(
            "INSERT OR REPLACE INTO messages (id, session_id, role, content, created_at, metadata) VALUES (?, ?, 'assistant', ?, ?, ?)",
          ).run(msgId, sessionId, '', Date.now(), meta);
        } catch (err) {
          console.warn('[user-question-sender] Failed to persist question message:', err);
        }
      }

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

      // Update the persisted question message with answer
      if (db && sessionId && _cardMessageId) {
        try {
          const msgId = `question-${_cardMessageId}`;
          const row = db.prepare(
            'SELECT metadata FROM messages WHERE id = ?',
          ).get(msgId) as { metadata: string | null } | undefined;
          if (row) {
            let meta: Record<string, unknown> = {};
            try { meta = row.metadata ? JSON.parse(String(row.metadata)) : {}; } catch { /* ignore */ }
            const uq = (meta.userQuestion || {}) as Record<string, unknown>;
            uq.status = 'answered';
            uq.answer = answer;
            meta.userQuestion = uq;
            db.prepare(
              'UPDATE messages SET metadata = ? WHERE id = ?',
            ).run(JSON.stringify(meta), msgId);
          }
        } catch (err) {
          console.warn('[user-question-sender] Failed to update question message:', err);
        }
      }
    },
  };
}
