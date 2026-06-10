// ---------------------------------------------------------------------------
// v4 Policy — approval resolution policy
// ---------------------------------------------------------------------------

import type {
  ApprovalKind,
  ApprovalDecisionType,
  ApprovalDecisionRecord,
} from '../types.js';
import type { ApprovalGate } from '../../app/types.js';

export interface ApprovalReuseResult {
  canReuse: boolean;
  decision?: ApprovalDecisionType;
}

export interface ApprovalResolutionPolicy {
  checkReuse(sessionId: string, kind: ApprovalKind, command?: string): Promise<ApprovalReuseResult>;
  recordDecision(input: ApprovalDecisionRecord): Promise<void>;
}

export class ApprovalResolutionPolicyImpl implements ApprovalResolutionPolicy {
  private approvalGate: ApprovalGate;
  private sessionApprovals: Map<string, Map<string, ApprovalDecisionType>>;

  constructor(deps: { approvalGate: ApprovalGate }) {
    this.approvalGate = deps.approvalGate;
    this.sessionApprovals = new Map();
  }

  async checkReuse(
    sessionId: string,
    kind: ApprovalKind,
    command?: string,
  ): Promise<ApprovalReuseResult> {
    // Check in-memory session approvals
    const sessionMap = this.sessionApprovals.get(sessionId);
    if (sessionMap) {
      const decision = sessionMap.get(makeApprovalKey(kind, command));
      if (decision) {
        return { canReuse: true, decision };
      }
    }

    if (command) {
      try {
        const decision = await this.approvalGate.evaluate({
          kind: 'tool',
          toolName: command,
          sessionKey: sessionId,
          scope: 'session',
          scopeKey: sessionId,
        });
        if (decision === 'approved') {
          return { canReuse: true, decision: 'approve_always' };
        }
        if (decision === 'rejected') {
          return { canReuse: true, decision: 'reject_always' };
        }
      } catch {
        // Policy lookup failure is non-fatal.
      }
    }

    // Check broad persistent policies via ApprovalGate.
    try {
      const policy = await this.approvalGate.getPolicy('session', sessionId);
      if (policy?.effect === 'allow') {
        return { canReuse: true, decision: 'approve_session' };
      }
    } catch {
      // Policy lookup failure is non-fatal
    }

    return { canReuse: false };
  }

  async recordDecision(input: ApprovalDecisionRecord): Promise<void> {
    // Record in-memory
    if ((input.scope === 'session' || input.scope === 'agent') && input.sessionId) {
      let sessionMap = this.sessionApprovals.get(input.sessionId);
      if (!sessionMap) {
        sessionMap = new Map();
        this.sessionApprovals.set(input.sessionId, sessionMap);
      }
      sessionMap.set(makeApprovalKey(input.kind, input.subject), input.decision);
    }

    // Persist via ApprovalGate
    // Avoid creating broad "*" policies for approve_always/reject_always when
    // the approved subject is unknown.
    if (!input.subject) return;

    try {
      await this.approvalGate.recordDecision(
        input.requestId,
        input.decision,
        input.subject,
        input.scope === 'session' ? input.sessionId : undefined,
        input.kind === 'shell' ? 'shell' : 'tool',
      );
    } catch {
      // Recording failure is non-fatal in Phase 1
    }
  }
}

function makeApprovalKey(kind: ApprovalKind, subject?: string): string {
  return subject ? `${kind}:${subject}` : kind;
}
