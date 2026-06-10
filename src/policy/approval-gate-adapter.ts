// ---------------------------------------------------------------------------
// v4 ApprovalGateAdapter — wraps existing ApprovalGate for PolicyCenter
// ---------------------------------------------------------------------------
//
// This adapter converts between v4 policy types (ToolPolicyInput,
// ShellPolicyInput, ApprovalDecisionRecord) and the old ApprovalRequest /
// ApprovalDecision types used by the SQLiteApprovalGate.
//
// It is used as a backend by the PolicyCenter when delegating to the
// existing approval infrastructure.

import type {
  ToolPolicyInput,
  ToolPolicyDecision,
  ShellPolicyInput,
  ShellPolicyDecision,
  ApprovalDecisionRecord,
} from './types.js';
import type {
  ApprovalGate,
  ApprovalDecision,
  ApprovalRequest as OldApprovalRequest,
} from '../app/types.js';
import { normalizeCommand } from '../tools/shell-command-policy.js';

export class ApprovalGateAdapter {
  constructor(private approvalGate: ApprovalGate) {}

  /**
   * Reason set by the last approval evaluation when it requires approval.
   * Delegates to the underlying ApprovalGate.
   */
  get lastRejectReason(): string | undefined {
    return this.approvalGate.lastRejectReason;
  }

  // -------------------------------------------------------------------------
  // evaluateTool
  // -------------------------------------------------------------------------

  /**
   * Convert a v4 ToolPolicyInput into the old ApprovalRequest format,
   * delegate to ApprovalGate.evaluate(), and map the result back to a
   * v4 ToolPolicyDecision.
   */
  async evaluateTool(input: ToolPolicyInput): Promise<ToolPolicyDecision> {
    const oldRequest: OldApprovalRequest = {
      kind: 'tool',
      toolName: input.toolName,
      sessionKey: input.sessionId ?? 'default',
      scope: 'session',
      scopeKey: input.sessionId,
    };

    const decision = await this.approvalGate.evaluate(oldRequest);
    return mapToolDecision(decision);
  }

  // -------------------------------------------------------------------------
  // evaluateShell
  // -------------------------------------------------------------------------

  /**
   * Convert a v4 ShellPolicyInput into the old ApprovalRequest format,
   * delegate to ApprovalGate.evaluate(), and map the result back to a
   * v4 ShellPolicyDecision.
   *
   * Handles empty-command and read-only-scope fast-paths before
   * normalizing and delegating.
   */
  async evaluateShell(input: ShellPolicyInput): Promise<ShellPolicyDecision> {
    const command = input.command?.trim() ?? '';

    // Empty command is always allowed
    if (!command) {
      return { allowed: true, requiresApproval: false, risk: 'low' };
    }

    // Read-only scope rejects all shell commands
    if (input.scope.readOnly) {
      return {
        allowed: false,
        requiresApproval: false,
        reason: 'Shell execution is disabled (read-only scope)',
        risk: 'high',
      };
    }

    // Normalize and delegate to existing ApprovalGate
    const normalized = normalizeCommand(command);

    const oldRequest: OldApprovalRequest = {
      kind: 'shell',
      command: normalized,
      sessionKey: input.sessionId ?? 'default',
      scope: 'session',
      scopeKey: input.sessionId,
    };

    const decision = await this.approvalGate.evaluate(oldRequest);
    return mapShellDecision(decision, normalized, this.approvalGate.lastRejectReason);
  }

  // -------------------------------------------------------------------------
  // recordDecision
  // -------------------------------------------------------------------------

  /**
   * Record an approval decision via the existing ApprovalGate.
   *
   * Maps the v4 ApprovalDecisionRecord fields to the old
   * `recordDecision(requestId, decision, command?, sessionKey?)` signature.
   */
  async recordDecision(input: ApprovalDecisionRecord): Promise<void> {
    if (!input.subject) return;
    await this.approvalGate.recordDecision(
      input.requestId,
      input.decision,
      input.subject,
      input.scope === 'session' ? input.sessionId : undefined,
      input.kind === 'shell' ? 'shell' : 'tool',
    );
  }
}

// ─── Pure mapping helpers (exported for testing) ───────────────────────────

/**
 * Map an old ApprovalDecision to a v4 ToolPolicyDecision.
 */
export function mapToolDecision(decision: ApprovalDecision): ToolPolicyDecision {
  switch (decision) {
    case 'approved':
      return { allowed: true, requiresApproval: false };
    case 'rejected':
      return { allowed: false, requiresApproval: false };
    case 'requires_approval':
      return { allowed: false, requiresApproval: true, approvalKind: 'tool' };
  }
}

/**
 * Map an old ApprovalDecision to a v4 ShellPolicyDecision, including risk
 * assessment based on the normalized command.
 */
export function mapShellDecision(
  decision: ApprovalDecision,
  normalized: { program: string; containsSecrets: boolean },
  lastRejectReason?: string,
): ShellPolicyDecision {
  switch (decision) {
    case 'approved':
      return { allowed: true, requiresApproval: false, risk: 'low' };
    case 'rejected':
      return {
        allowed: false,
        requiresApproval: false,
        reason: lastRejectReason ?? 'Shell command rejected by policy',
        risk: 'high',
      };
    case 'requires_approval':
      return {
        allowed: false,
        requiresApproval: true,
        reason: lastRejectReason ?? 'Shell command requires approval',
        risk: assessRisk(normalized),
      };
  }
}

/**
 * Simple risk assessment based on program name and secret detection.
 */
export function assessRisk(normalized: { program: string; containsSecrets: boolean }): 'low' | 'medium' | 'high' {
  if (normalized.containsSecrets) return 'high';

  const highRiskPrograms = ['rm', 'dd', 'mkfs', 'shutdown', 'reboot', 'chmod', 'chown'];
  if (highRiskPrograms.includes(normalized.program)) return 'high';

  const mediumRiskPrograms = ['kill', 'pkill', 'systemctl', 'service', 'mount', 'umount'];
  if (mediumRiskPrograms.includes(normalized.program)) return 'medium';

  return 'low';
}
