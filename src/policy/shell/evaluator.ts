// ---------------------------------------------------------------------------
// v4 Policy — shell execution policy
// ---------------------------------------------------------------------------

import type { ShellPolicyInput, ShellPolicyDecision } from '../types.js';
import type { ApprovalGate, ApprovalRequest as OldApprovalRequest } from '../../app/types.js';
import {
  getReadOnlyShellBlockReason,
  normalizeCommand,
} from '../../tools/shell-command-policy.js';

export interface ShellExecutionPolicy {
  evaluate(input: ShellPolicyInput): Promise<ShellPolicyDecision>;
}

export class ShellExecutionPolicyImpl implements ShellExecutionPolicy {
  private approvalGate: ApprovalGate;

  constructor(deps: { approvalGate: ApprovalGate }) {
    this.approvalGate = deps.approvalGate;
  }

  async evaluate(input: ShellPolicyInput): Promise<ShellPolicyDecision> {
    const command = input.command?.trim() ?? '';

    // Empty command
    if (!command) {
      return { allowed: true, requiresApproval: false, risk: 'low' };
    }

    // Read-only scope permits the same read-only shell subset used by the
    // legacy beforeToolCall path, then delegates allowed commands to the
    // regular approval gate.
    if (input.scope.readOnly) {
      const reason = getReadOnlyShellBlockReason(command, input.scope.toolsProfile);
      if (reason) {
        return {
          allowed: false,
          requiresApproval: false,
          reason,
          risk: 'high',
        };
      }
    }

    // Normalize and delegate to existing ApprovalGate
    const normalized = normalizeCommand(command);

    const oldRequest: OldApprovalRequest = {
      kind: 'shell',
      command: normalized,
      sessionKey: input.sessionId ?? 'default',
      scope: 'session',
      scopeKey: input.sessionId ?? 'default',
    };

    const decision = await this.approvalGate.evaluate(oldRequest);

    switch (decision) {
      case 'approved':
        return { allowed: true, requiresApproval: false, risk: 'low' };
      case 'rejected':
        return {
          allowed: false,
          requiresApproval: false,
          reason: this.approvalGate.lastRejectReason ?? 'Shell command rejected by policy',
          risk: 'high',
        };
      case 'requires_approval':
        return {
          allowed: false,
          requiresApproval: true,
          reason: this.approvalGate.lastRejectReason ?? 'Shell command requires approval',
          risk: this.assessRisk(normalized),
        };
    }
  }

  private assessRisk(normalized: { program: string; containsSecrets: boolean }): 'low' | 'medium' | 'high' {
    if (normalized.containsSecrets) return 'high';

    const riskPrograms = ['rm', 'dd', 'mkfs', 'shutdown', 'reboot', 'chmod', 'chown'];
    if (riskPrograms.includes(normalized.program)) return 'high';

    const mediumPrograms = ['kill', 'pkill', 'systemctl', 'service', 'mount', 'umount'];
    if (mediumPrograms.includes(normalized.program)) return 'medium';

    return 'low';
  }
}
