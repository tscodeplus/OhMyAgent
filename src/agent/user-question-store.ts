/**
 * Event-driven store for pending user questions (ask_user_question tool).
 *
 * Uses Node.js EventEmitter for zero-CPU-wait resolution (no polling).
 * Pure in-memory store — stale questions are rejected on restart (the agent
 * execution that awaited them is also gone).
 *
 * Architecture:
 *   - create()   → registers EventEmitter listener + timeout timer
 *   - resolve()  → emits event, resolving the waiting Promise with the answer
 *   - timeout    → auto-reject with a timeout message string
 *   - rejectAllForSession() → rejects all pending questions for a session
 */

import { EventEmitter } from 'node:events';

interface PendingQuestionEntry {
  timer: ReturnType<typeof setTimeout>;
  sessionKey: string;
}

export class UserQuestionStore {
  private pending = new Map<string, PendingQuestionEntry>();
  private events = new EventEmitter();
  private defaultTimeoutMs: number;

  constructor(options?: { defaultTimeoutMs?: number }) {
    this.events.setMaxListeners(100);
    this.defaultTimeoutMs = options?.defaultTimeoutMs ?? 300_000; // 5 minutes
  }

  /**
   * Create a pending question entry.
   * Returns a Promise that resolves with the user's answer string,
   * or rejects (well, resolves to a timeout marker string) on timeout.
   */
  create(
    requestId: string,
    timeoutMs?: number,
    sessionKey?: string,
  ): Promise<string> {
    return this._awaitAnswer(
      requestId,
      timeoutMs ?? this.defaultTimeoutMs,
      sessionKey ?? '',
    );
  }

  /**
   * Resolve a pending question with the user's answer.
   * Returns false if the requestId is not found (already timed out or resolved).
   */
  resolve(requestId: string, answer: string): boolean {
    if (!this.pending.has(requestId)) return false;
    this.events.emit(requestId, answer);
    return true;
  }

  /**
   * Check whether a session has at least one pending question.
   */
  hasPendingForSession(sessionKey: string): boolean {
    for (const [, entry] of this.pending) {
      if (entry.sessionKey === sessionKey) return true;
    }
    return false;
  }

  /**
   * Find the oldest pending question requestId for a session.
   * Returns undefined if no pending questions exist.
   */
  findPendingForSession(sessionKey: string): string | undefined {
    for (const [requestId, entry] of this.pending) {
      if (entry.sessionKey === sessionKey) return requestId;
    }
    return undefined;
  }

  /**
   * Reject all pending questions for a session with the given reason.
   * Returns the number of questions rejected.
   */
  rejectAllForSession(sessionKey: string, reason: string = 'cancelled'): number {
    let count = 0;
    for (const [requestId, entry] of this.pending) {
      if (entry.sessionKey !== sessionKey) continue;
      clearTimeout(entry.timer);
      this.pending.delete(requestId);
      this.events.emit(requestId, `[Cancelled] ${reason}`);
      count++;
    }
    return count;
  }

  /**
   * Get the count of pending questions (useful for diagnostics).
   */
  get pendingCount(): number {
    return this.pending.size;
  }

  // ── Private ──

  private _awaitAnswer(
    requestId: string,
    timeoutMs: number,
    sessionKey: string,
  ): Promise<string> {
    return new Promise<string>((resolve) => {
      const timer = setTimeout(() => {
        this.events.off(requestId, handler);
        this.pending.delete(requestId);
        resolve('[Timeout] User did not respond');
      }, timeoutMs);

      const handler = (answer: string) => {
        clearTimeout(timer);
        this.pending.delete(requestId);
        resolve(answer);
      };

      this.events.once(requestId, handler);
      this.pending.set(requestId, { timer, sessionKey });
    });
  }
}
