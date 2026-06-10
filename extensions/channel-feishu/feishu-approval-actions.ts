/**
 * Handles approval card button callbacks.
 *
 * Each callback carries an {@link ApprovalDecision} and a requestId.
 * Decisions are stored in-memory so that duplicate callbacks are idempotent.
 */

// ─── Types ───

export type ApprovalDecision = 'approve_once' | 'approve_always' | 'reject_once' | 'reject_always';

export interface ApprovalCallbackData {
  action: ApprovalDecision;
  requestId: string;
}

// ─── Handler ───

/**
 * Stateful handler for approval card callbacks.
 *
 * - First call for a given `requestId` returns the decision.
 * - Subsequent calls for the same `requestId` return `null` (idempotent).
 */
export class ApprovalActionHandler {
  private decidedRequests: Map<string, ApprovalDecision> = new Map();

  /**
   * Process an approval callback.
   *
   * @returns The decision + requestId on first processing, or `null` if the
   *          request was already decided.
   */
  handleCallback(
    data: ApprovalCallbackData,
  ): { decision: ApprovalDecision; requestId: string } | null {
    if (this.decidedRequests.has(data.requestId)) {
      return null;
    }

    this.decidedRequests.set(data.requestId, data.action);

    return {
      decision: data.action,
      requestId: data.requestId,
    };
  }

  /**
   * Check whether a request has already been decided.
   */
  isDecided(requestId: string): boolean {
    return this.decidedRequests.has(requestId);
  }

  /**
   * Retrieve the decision for a request, if any.
   */
  getDecision(requestId: string): ApprovalDecision | undefined {
    return this.decidedRequests.get(requestId);
  }
}
