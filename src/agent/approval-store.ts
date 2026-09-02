/**
 * Event-driven store for pending approval requests.
 *
 * Uses Node.js EventEmitter for zero-CPU-wait resolution (no polling).
 * Optionally persists to the approval_requests table so pending requests
 * are durable across restarts, though on restart they are all rejected
 * (the original agent execution stack no longer exists to await them).
 *
 * Architecture:
 *   - create()   → writes to DB (if repo provided) + registers EventEmitter listener
 *   - resolve()  → emits event, resolving the waiting Promise
 *   - timeout    → auto-reject + update DB status
 *   - recoverFromDB() → rejects all pending requests on startup (stale_after_restart)
 */

import { EventEmitter } from 'node:events';
import type { ApprovalDecisionType } from '../app/types.js';
import type { ApprovalRequestRepository } from '../memory/repositories/approval-request-repository.js';

interface PendingApprovalEntry {
  timer: ReturnType<typeof setTimeout>;
  sessionKey: string;
  /** Risk level captured at create() — timeout-allow must never auto-approve high-risk requests. */
  riskLevel?: string;
  /** Absolute path this approval was about (file-access approvals only). When
   *  a human approves, onFileServeApproved fires so the WebUI file-serve
   *  allowlist learns the path (report #6b option B). */
  fileServePath?: string;
}

export class PendingApprovalStore {
  private pending = new Map<string, PendingApprovalEntry>();
  private events = new EventEmitter();
  private onAutoReject?: (
    requestId: string,
    reason: 'timeout' | 'stale_after_restart' | 'expired_before_recovery' | 'steered',
  ) => void;
  private onAutoApprove?: (requestId: string) => void;
  /** Fired when a human approves a file-access approval carrying a serve
   *  path. Injected by the composer with the WebUI grant function so the
   *  approval decision and the file-serve allowlist share one source of
   *  truth (the human decision) without src/agent importing webui. */
  private onFileServeApproved?: (info: { path: string; requestId: string }) => void;
  private timeoutAction: 'deny' | 'allow';

  constructor(options?: {
    onAutoReject?: (
      requestId: string,
      reason: 'timeout' | 'stale_after_restart' | 'expired_before_recovery' | 'steered',
    ) => void;
    onAutoApprove?: (requestId: string) => void;
    onFileServeApproved?: (info: { path: string; requestId: string }) => void;
    timeoutAction?: 'deny' | 'allow';
  }) {
    this.events.setMaxListeners(100);
    this.onAutoReject = options?.onAutoReject;
    this.onAutoApprove = options?.onAutoApprove;
    this.onFileServeApproved = options?.onFileServeApproved;
    this.timeoutAction = options?.timeoutAction ?? 'deny';
  }

  async create(
    requestId: string,
    timeoutMs: number,
    approvalRepo?: ApprovalRequestRepository,
    sessionKey?: string,
    command?: string,
    riskLevel?: string,
    metadata?: {
      chatId?: string;
      threadId?: string;
      cardMessageId?: string;
      targetKind?: 'shell' | 'tool';
      toolName?: string;
      reason?: string;
      policyScope?: string;
      /** Operator identity of the requester (e.g. Feishu open_id). Used by
       *  approval callbacks to verify that the clicker is the requester. */
      requesterId?: string;
      /** Absolute path whose WebUI serving should be granted when a human
       *  approves (file-access approvals only, see handleFileAccessApproval). */
      fileServePath?: string;
    },
  ): Promise<ApprovalDecisionType> {
    if (approvalRepo) {
      approvalRepo.create({
        id: requestId,
        session_key: sessionKey ?? '',
        chat_id: metadata?.chatId ?? null,
        thread_id: metadata?.threadId ?? null,
        requester_id: metadata?.requesterId ?? null,
        target_kind: metadata?.targetKind ?? 'shell',
        tool_name: metadata?.toolName ?? null,
        command_text: command,
        normalized_command: command?.trim().replace(/\s+/g, ' '),
        risk_level: riskLevel,
        reason: metadata?.reason ?? null,
        status: 'pending',
        policy_scope: metadata?.policyScope ?? null,
        card_message_id: metadata?.cardMessageId ?? null,
        expires_at: new Date(Date.now() + timeoutMs).toISOString(),
      });
    }

    return this._awaitDecision(
      requestId,
      timeoutMs,
      approvalRepo,
      sessionKey ?? '',
      riskLevel,
      metadata?.fileServePath,
    );
  }

  setTimeoutAction(action: 'deny' | 'allow'): void {
    this.timeoutAction = action;
  }

  resolve(requestId: string, decision: ApprovalDecisionType): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    this.events.emit(requestId, decision);
    this.notifyFileServeApproved(entry, requestId, decision);
    return true;
  }

  /**
   * Resolve the first (oldest) pending approval for a session.
   * Returns false if no pending approvals exist for the session.
   */
  resolveFirstForSession(sessionKey: string, decision: ApprovalDecisionType): boolean {
    for (const [requestId, entry] of this.pending) {
      if (entry.sessionKey !== sessionKey) continue;
      clearTimeout(entry.timer);
      this.pending.delete(requestId);
      this.events.emit(requestId, decision);
      this.notifyFileServeApproved(entry, requestId, decision);
      return true;
    }
    return false;
  }

  /**
   * Resolve ALL pending approvals for a session with the given decision.
   * Returns the number of approvals resolved.
   */
  resolveAllForSession(sessionKey: string, decision: ApprovalDecisionType): number {
    let count = 0;
    for (const [requestId, entry] of this.pending) {
      if (entry.sessionKey !== sessionKey) continue;
      clearTimeout(entry.timer);
      this.pending.delete(requestId);
      this.events.emit(requestId, decision);
      this.notifyFileServeApproved(entry, requestId, decision);
      count++;
    }
    return count;
  }

  recoverFromDB(approvalRepo: ApprovalRequestRepository): number {
    const pending = approvalRepo.findPending();
    let rejected = 0;

    for (const req of pending) {
      if (!req.expires_at) continue;
      const expiresAt = new Date(req.expires_at).getTime();
      const reason = Date.now() >= expiresAt ? 'expired_before_recovery' : 'stale_after_restart';
      approvalRepo.update(req.id, { status: 'rejected', reason });
      this.onAutoReject?.(req.id, reason);
      rejected++;
    }

    return rejected;
  }

  rejectAllForSession(
    sessionKey: string,
    approvalRepo?: ApprovalRequestRepository,
    reason: 'stopped_by_user' | 'steered' = 'stopped_by_user',
  ): number {
    let count = 0;
    for (const [requestId, entry] of this.pending) {
      if (entry.sessionKey !== sessionKey) continue;
      clearTimeout(entry.timer);
      this.pending.delete(requestId);
      if (approvalRepo) {
        approvalRepo.update(requestId, { status: 'rejected', reason });
      }
      this.events.emit(requestId, 'reject_once');
      // Trigger auto-reject callback so the channel UI (e.g. Feishu approval card) is updated
      if (reason === 'steered') {
        this.onAutoReject?.(requestId, 'steered');
      }
      count++;
    }
    return count;
  }

  private _awaitDecision(
    requestId: string,
    timeoutMs: number,
    approvalRepo?: ApprovalRequestRepository,
    sessionKey?: string,
    riskLevel?: string,
    fileServePath?: string,
  ): Promise<ApprovalDecisionType> {
    return new Promise<ApprovalDecisionType>((resolve) => {
      const timer = setTimeout(() => {
        this.events.off(requestId, handler);
        this.pending.delete(requestId);
        // timeout_action: allow is a global fail-open convenience — but it must
        // never auto-approve HIGH-RISK requests (e.g. dangerous shell commands).
        if (this.timeoutAction === 'allow' && riskLevel !== 'high') {
          if (approvalRepo) {
            approvalRepo.update(requestId, { status: 'approved', reason: 'timeout_allow' });
          }
          this.onAutoApprove?.(requestId);
          resolve('approve_once');
        } else {
          if (approvalRepo) {
            approvalRepo.update(requestId, {
              status: 'rejected',
              reason: this.timeoutAction === 'allow' ? 'timeout_high_risk' : 'timeout',
            });
          }
          this.onAutoReject?.(requestId, 'timeout');
          resolve('reject_once');
        }
      }, timeoutMs);

      const handler = (decision: ApprovalDecisionType) => {
        clearTimeout(timer);
        this.pending.delete(requestId);
        resolve(decision);
      };

      this.events.once(requestId, handler);
      this.pending.set(requestId, { timer, sessionKey: sessionKey ?? '', riskLevel, fileServePath });
    });
  }

  /** Fire the file-serve grant hook for an approve decision on a
   *  file-access approval. Called from every resolve path. */
  private notifyFileServeApproved(
    entry: PendingApprovalEntry,
    requestId: string,
    decision: ApprovalDecisionType,
  ): void {
    if (!entry.fileServePath || !decision.startsWith('approve')) return;
    try {
      this.onFileServeApproved?.({ path: entry.fileServePath, requestId });
    } catch {
      // The hook is an additive capability grant; a failure here must not
      // turn an approved tool call into an error.
    }
  }
}
