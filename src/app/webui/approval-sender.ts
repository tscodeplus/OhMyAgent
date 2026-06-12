/**
 * WebUIApprovalSender — sends approval requests via SSE during streaming
 * and updates them after the user makes a decision.
 *
 * Implements the channelApprovalSender contract defined in
 * src/agent/before-tool-call.ts so it can be plugged directly into the
 * Agent's approval pipeline.
 *
 * Flow:
 *   1. Tool needs approval → sendApprovalMessage() → SSE "approval_required"
 *   2. Frontend renders ApprovalCard with approve/reject buttons
 *   3. User clicks approve/reject → POST /api/approvals/:id/resolve
 *   4. Backend resolves pending approval → agent continues
 *   5. updateApprovalResult() → SSE "approval_resolved" to update the card
 */

import type Database from 'better-sqlite3';

export interface WebUIApprovalSender {
  sendApprovalMessage(
    chatId: string,
    requestId: string,
    command: string,
    risk: 'low' | 'medium' | 'high',
    reason?: string,
  ): Promise<string>;

  updateApprovalResult(
    chatId: string,
    messageId: string,
    decision: string,
    command: string,
  ): Promise<void>;
}

export function createWebUIApprovalSender(
  sendSSE: (data: Record<string, unknown>) => void,
  db?: Database.Database,
  sessionId?: string,
): WebUIApprovalSender {
  return {
    async sendApprovalMessage(_chatId, requestId, command, risk, reason) {
      sendSSE({
        type: 'approval_required',
        approvalId: requestId,
        command,
        risk,
        reason: reason ?? '',
        // toolName for the frontend ApprovalCard
        toolName: command.length > 50 ? command.slice(0, 50) + '...' : command,
      });

      // Persist approval request as a message so it survives page refresh.
      // Uses "approval-{id}" ID to match the frontend streaming message ID.
      if (db && sessionId) {
        try {
          const msgId = `approval-${requestId}`;
          const meta = JSON.stringify({
            approval: { approvalId: requestId, command, risk, status: 'pending', reason: reason ?? '' },
          });
          db.prepare(
            "INSERT OR REPLACE INTO messages (id, session_id, role, content, created_at, metadata) VALUES (?, ?, 'assistant', ?, ?, ?)",
          ).run(msgId, sessionId, '', Date.now(), meta);
        } catch (err) {
          console.warn('[approval-sender] Failed to persist approval message:', err);
        }
      }

      // Return the requestId as the "messageId" — used later to update
      return requestId;
    },

    async updateApprovalResult(_chatId, _messageId, decision, _command) {
      // Read the rejection reason from the persisted DB record (set by
      // PendingApprovalStore when auto-rejecting). This lets the frontend
      // show the correct message ("received new message" vs "timeout").
      let reason: string | undefined;
      if (!decision.startsWith('approve') && db && sessionId) {
        try {
          const msgId = `approval-${_messageId}`;
          const row = db.prepare(
            'SELECT metadata FROM messages WHERE id = ?',
          ).get(msgId) as { metadata: string | null } | undefined;
          if (row?.metadata) {
            const meta = JSON.parse(String(row.metadata));
            reason = meta?.approval?.timeoutReason as string | undefined;
          }
        } catch { /* best-effort */ }
      }
      sendSSE({
        type: 'approval_resolved',
        approvalId: _messageId,
        decision,
        reason,
      });

      // Update the persisted approval message status
      if (db && sessionId) {
        try {
          const msgId = `approval-${_messageId}`;
          const row = db.prepare(
            'SELECT metadata FROM messages WHERE id = ?',
          ).get(msgId) as { metadata: string | null } | undefined;
          if (row) {
            let meta: Record<string, unknown> = {};
            try { meta = row.metadata ? JSON.parse(String(row.metadata)) : {}; } catch { /* ignore */ }
            const approval = (meta.approval || {}) as Record<string, unknown>;
            const isApproved = decision.startsWith('approve');
            approval.status = isApproved ? 'approved' : 'rejected';
            approval.decision = decision;
            meta.approval = approval;
            db.prepare(
              'UPDATE messages SET metadata = ? WHERE id = ?',
            ).run(JSON.stringify(meta), msgId);
          }
        } catch (err) {
          console.warn('[approval-sender] Failed to update approval message:', err);
        }
      }
    },
  };
}
