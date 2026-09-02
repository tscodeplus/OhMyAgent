// ---------------------------------------------------------------------------
// ApprovalPolicy — Ordered rule evaluation engine for harness change approval
// ---------------------------------------------------------------------------

import {
  ApprovalRule,
  ApprovalAction,
  AutoRollbackConfig,
  ImprovementProposal,
  FailurePattern,
  TimeRange,
  ApprovalMode,
} from './types.js';

/**
 * Check whether `now` falls within any of the given time ranges.
 * Handles overnight ranges where end < start (e.g., 22:00-08:00).
 */
function inTimeRange(now: Date, ranges: TimeRange[]): boolean {
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  for (const range of ranges) {
    const [startH, startM] = range.start.split(':').map(Number);
    const [endH, endM] = range.end.split(':').map(Number);
    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;
    if (startMinutes <= endMinutes) {
      // Normal range (e.g., 08:00-18:00)
      if (nowMinutes >= startMinutes && nowMinutes <= endMinutes) return true;
    } else {
      // Overnight range (e.g., 22:00-08:00)
      if (nowMinutes >= startMinutes || nowMinutes <= endMinutes) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Default rules (section 5.3 of the design doc)
// ---------------------------------------------------------------------------

export const DEFAULT_RULES: ApprovalRule[] = [
  // 0 — Destructive changes always require approval (highest priority,
  // never overridable — see design doc §5.3).
  {
    id: 'default-deny-deletion',
    name: 'Destructive changes require approval',
    priority: 0,
    enabled: true,
    changeTypes: ['trigger_remove', 'tool_allow_remove', 'approval_policy'],
    action: 'require_approval',
  },
  // 1 — Global / multi-skill changes always require approval
  {
    id: 'default-global-scope',
    name: 'Global scope requires approval',
    priority: 5,
    enabled: true,
    scopes: ['global', 'multi_skill'],
    action: 'require_approval',
  },
  // 2 — Medium-risk changes require approval
  {
    id: 'default-high-risk',
    name: 'High risk requires approval',
    priority: 10,
    enabled: true,
    riskLevels: ['medium'],
    action: 'require_approval',
  },
  // 3 — Permission-related changes require approval
  {
    id: 'default-permission-sensitive',
    name: 'Permission-sensitive changes require approval',
    priority: 12,
    enabled: true,
    mechanismFamilies: ['permission_interrupt'],
    action: 'require_approval',
  },
  // 4 — Numeric threshold changes require approval
  {
    id: 'default-numeric-threshold',
    name: 'Numeric threshold changes require approval',
    priority: 15,
    enabled: true,
    changeTypes: ['numeric_threshold'],
    action: 'require_approval',
  },
  // 5 — User dissatisfaction triggers approval
  {
    id: 'default-user-dissatisfied',
    name: 'User dissatisfaction requires approval',
    priority: 20,
    enabled: true,
    failurePatterns: ['user_explicit_dissatisfied'],
    action: 'require_approval',
  },
  // 6 — Structural / policy changes require approval
  {
    id: 'default-structure-change',
    name: 'Structural and policy changes require approval',
    priority: 25,
    enabled: true,
    changeTypes: [
      'prompt_structure',
      'execution_policy',
      'spawn_policy_edit',
      'memory_policy_edit',
    ],
    action: 'require_approval',
  },
  // 7 — Low-risk single-skill changes can auto-apply with rollback
  {
    id: 'default-low-risk-auto',
    name: 'Low-risk single-skill auto-apply',
    priority: 50,
    enabled: true,
    scopes: ['single_skill'],
    changeTypes: ['prompt_text', 'trigger_add', 'tool_allow_add', 'tool_desc_edit'],
    riskLevels: ['none', 'low'],
    minConfidence: 0.8,
    action: 'auto_apply',
    autoRollback: {
      satisfactionThreshold: 0.6,
      observationWindow: 50,
      errorRateMultiplier: 2.0,
    },
  },
  // 8 — Fallback: require approval for anything else
  {
    id: 'default-fallback',
    name: 'Fallback approval',
    priority: 100,
    enabled: true,
    action: 'require_approval',
  },
];

// ---------------------------------------------------------------------------
// ApprovalPolicy class
// ---------------------------------------------------------------------------

/**
 * Evaluates improvement proposals against an ordered set of approval rules.
 *
 * Rules are evaluated in priority order (lowest priority number first).
 * The first rule whose all non-empty match dimensions match the proposal
 * determines the approval action.  If no rule matches, `require_approval`
 * is returned as the safe default.
 */
export class ApprovalPolicy {
  private rules: ApprovalRule[];
  private mode: ApprovalMode;

  constructor(rules: ApprovalRule[] = DEFAULT_RULES, mode: ApprovalMode = 'smart_approve') {
    this.rules = [...rules].sort((a, b) => a.priority - b.priority);
    this.mode = mode;
  }

  /** Replace the approval strategy preset (always_ask / smart_approve / low_risk_auto). */
  setMode(mode: ApprovalMode): void {
    this.mode = mode;
  }

  /**
   * Evaluate a proposal against all active rules in priority order.
   * Returns the action, rule ID, and optional auto-rollback config of the
   * first matching rule, or a safe fallback.
   */
  evaluate(
    proposal: ImprovementProposal,
    context: {
      skillId?: string;
      agentId?: string;
      pattern?: FailurePattern;
      currentTime?: Date;
    } = {},
  ): { action: ApprovalAction; ruleId: string; autoRollback?: AutoRollbackConfig } {
    const now = context.currentTime ?? new Date();

    for (const rule of this.rules) {
      // Skip disabled rules
      if (rule.enabled === false) continue;

      // --- skillIds ---
      // If the rule specifies skillIds, context.skillId (or "*" when
      // undefined) must be in the list.
      if (rule.skillIds && rule.skillIds.length > 0) {
        const targetSkill = context.skillId ?? '*';
        if (!rule.skillIds.includes(targetSkill)) continue;
      }

      // --- agentIds ---
      // Same pattern as skillIds.
      if (rule.agentIds && rule.agentIds.length > 0) {
        const targetAgent = context.agentId ?? '*';
        if (!rule.agentIds.includes(targetAgent)) continue;
      }

      // --- mechanismFamilies ---
      // The proposal's mechanism family must appear in the rule's list.
      if (rule.mechanismFamilies && rule.mechanismFamilies.length > 0) {
        if (!(rule.mechanismFamilies as string[]).includes(proposal.mechanismFamily)) continue;
      }

      // --- changeTypes ---
      // The proposal's type must appear in the rule's list.
      if (rule.changeTypes && rule.changeTypes.length > 0) {
        if (!(rule.changeTypes as string[]).includes(proposal.type)) continue;
      }

      // --- riskLevels ---
      // The proposal's regression risk must appear in the rule's list.
      if (rule.riskLevels && rule.riskLevels.length > 0) {
        if (!(rule.riskLevels as string[]).includes(proposal.regressionRisk)) continue;
      }

      // --- failurePatterns ---
      // The context pattern (when provided) must appear in the rule's list.
      if (rule.failurePatterns && rule.failurePatterns.length > 0) {
        if (!context.pattern || !(rule.failurePatterns as string[]).includes(context.pattern))
          continue;
      }

      // --- minConfidence ---
      // The proposal's confidence must meet or exceed the threshold.
      if (rule.minConfidence !== undefined) {
        if (proposal.confidence < rule.minConfidence) continue;
      }

      // --- scopes ---
      // The proposal's standardised affectedScope must appear in the rule's
      // list (proposals are normalised to single_skill | multi_skill |
      // global | session | unknown by the optimizer).
      if (rule.scopes && rule.scopes.length > 0) {
        if (!(rule.scopes as string[]).includes(proposal.affectedScope)) continue;
      }

      // --- timeRanges ---
      // The current time must fall within at least one configured range.
      if (rule.timeRanges && rule.timeRanges.length > 0) {
        if (!inTimeRange(now, rule.timeRanges)) continue;
      }

      // All dimensions matched — this rule wins; the active approval preset
      // may still escalate or relax the resulting action.
      const action = this.applyMode(rule.action, rule, proposal);
      return {
        action,
        ruleId: rule.id,
        autoRollback: rule.autoRollback,
      };
    }

    // No rule matched — safe fallback
    return { action: 'require_approval', ruleId: 'fallback' };
  }

  /**
   * Adjust a matched rule's action according to the active approval preset:
   *  - always_ask: every auto_apply is escalated to require_approval
   *  - low_risk_auto: low-risk, non-destructive require_approval rules are
   *    relaxed to auto_apply (with a default rollback config)
   *  - smart_approve: no adjustment
   */
  private applyMode(
    action: ApprovalAction,
    rule: ApprovalRule,
    proposal: ImprovementProposal,
  ): ApprovalAction {
    if (this.mode === 'always_ask') {
      return action === 'auto_apply' ? 'require_approval' : action;
    }
    if (this.mode === 'low_risk_auto') {
      if (action !== 'require_approval') return action;
      // Never auto-apply permission / approval-rule changes or destructive edits.
      if (proposal.mechanismFamily === 'permission_interrupt') return action;
      const destructive = (rule.changeTypes ?? []).some(
        (ct) => ct === 'trigger_remove' || ct === 'tool_allow_remove' || ct === 'approval_policy',
      );
      if (destructive) return action;
      const lowRisk =
        proposal.regressionRisk !== 'medium' && proposal.impact.riskLevel !== 'medium';
      if (!lowRisk) return action;
      return 'auto_apply';
    }
    return action;
  }

  /**
   * Replace the current rules with a new set.  Rules are re-sorted by
   * priority ascending.
   */
  reload(rules: ApprovalRule[]): void {
    this.rules = [...rules].sort((a, b) => a.priority - b.priority);
  }

  /**
   * Return a shallow copy of the current rules to prevent external mutation.
   */
  getRules(): ApprovalRule[] {
    return [...this.rules];
  }
}
