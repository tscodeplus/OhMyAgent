/**
 * Handles approval card button callbacks.
 *
 * Each callback carries an {@link ApprovalDecision} and a requestId.
 * Decisions are stored in-memory so that duplicate callbacks are idempotent.
 *
 * Security: when an `operatorId` is provided, the callback is only accepted
 * if `verifyOperator` (when configured) confirms the operator is the request
 * initiator. Without `verifyOperator` the callback fails closed rather than
 * allowing an unverified operator to decide the approval.
 */

// ─── Types ───

export type ApprovalDecision = 'approve_once' | 'approve_always' | 'reject_once' | 'reject_always';

export interface ApprovalCallbackData {
  action: ApprovalDecision;
  requestId: string;
}

export type ApprovalCallbackResult =
  | { decision: ApprovalDecision; requestId: string }
  | { error: 'not_authorized' }
  | null;

// ─── Handler ───

/**
 * Stateful handler for approval card callbacks.
 *
 * - First call for a given `requestId` returns the decision.
 * - Subsequent calls for the same `requestId` return `null` (idempotent).
 * - When `operatorId` is supplied, the operator must match the request
 *   initiator (via `verifyOperator`); a mismatch returns `{ error:
 *   'not_authorized' }` and does NOT record a decision.
 */
export class ApprovalActionHandler {
  private decidedRequests: Map<string, ApprovalDecision> = new Map();
  private readonly verifyOperator?: (requestId: string, operatorId: string) => Promise<boolean> | boolean;

  constructor(options?: {
    /** Returns true when the operator may decide the given approval request. */
    verifyOperator?: (requestId: string, operatorId: string) => Promise<boolean> | boolean;
  }) {
    this.verifyOperator = options?.verifyOperator;
  }

  /**
   * Process an approval callback.
   *
   * @param data The callback payload (action + requestId).
   * @param operatorId Identity of the clicker (e.g. Feishu open_id). When
   *                   provided, the callback is gated on `verifyOperator`.
   * @returns The decision + requestId on first processing, `{ error:
   *          'not_authorized' }` when the operator lacks authority, or
   *          `null` if the request was already decided.
   */
  async handleCallback(
    data: ApprovalCallbackData,
    operatorId?: string,
  ): Promise<ApprovalCallbackResult> {
    if (this.decidedRequests.has(data.requestId)) {
      return null;
    }

    if (operatorId) {
      if (!this.verifyOperator) return { error: 'not_authorized' };
      const authorized = await this.verifyOperator(data.requestId, operatorId);
      if (!authorized) return { error: 'not_authorized' };
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
