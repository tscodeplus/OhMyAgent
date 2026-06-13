/**
 * Skill Compliance Tracker (P1-3)
 *
 * Tracks consecutive violations of skill rules across agent turns.
 * When an agent repeatedly ignores a skill's MUST DO instructions,
 * an automatic reinforcement reminder is injected into the system prompt.
 *
 * Usage:
 *   const tracker = new SkillComplianceTracker();
 *   const result = tracker.check(skillId, toolCalls, skill);
 *   if (!result.compliant) { inject reinforcement }
 */

import type { LoadedSkill } from './skill-loader.js';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ToolCallSnapshot {
  name: string;
  args: Record<string, unknown>;
}

export interface ComplianceResult {
  /** Whether all MUST DO rules were followed */
  compliant: boolean;
  /** Specific violations found */
  violations: ComplianceViolation[];
  /** Whether a reinforcement reminder should be injected */
  needsReinforcement: boolean;
  /** The reinforcement message, if needed */
  reinforcementMessage?: string;
}

export interface ComplianceViolation {
  rule: string;
  message: string;
  evidence?: string;
}

/**
 * Compliance tracker that persists across turns via session-scoped state.
 *
 * Violation counting uses exponential decay: after each compliant turn,
 * the count is decremented by 1 (not reset), so a single mistake doesn't
 * reset a long compliance streak.
 */
export class SkillComplianceTracker {
  /** Map of skillId → consecutive violation count */
  private violations = new Map<string, number>();
  /** Map of sessionId → Map of skillId → violation count (session-scoped) */
  private sessionViolations = new Map<string, Map<string, number>>();
  /** Reinforcement already injected this turn (dedup) */
  private reinforcedThisTurn = new Set<string>();

  /**
   * Check compliance for a skill based on the tool calls made.
   *
   * @param skillId - The activated skill's ID
   * @param toolCalls - Tool calls made in the current turn
   * @param skill - The loaded skill to check rules against
   * @param sessionId - Optional session key for session-scoped tracking
   */
  check(
    skillId: string,
    toolCalls: ToolCallSnapshot[],
    skill: LoadedSkill,
    sessionId?: string,
  ): ComplianceResult {
    const violations = this.findViolations(skillId, toolCalls, skill);

    // Select the appropriate violation store
    const store = sessionId
      ? this.getSessionStore(sessionId)
      : this.violations;

    const prevCount = store.get(skillId) ?? 0;

    if (violations.length > 0) {
      const count = prevCount + 1;
      store.set(skillId, count);

      const needsReinforcement = count >= 2;
      let reinforcementMessage: string | undefined;

      if (needsReinforcement && !this.reinforcedThisTurn.has(skillId)) {
        this.reinforcedThisTurn.add(skillId);
        reinforcementMessage = this.buildReinforcement(skillId, skill, violations, count);
      }

      return {
        compliant: false,
        violations,
        needsReinforcement,
        reinforcementMessage,
      };
    }

    // Compliant turn: decay the count by 1 (don't reset)
    if (prevCount > 0) {
      store.set(skillId, Math.max(0, prevCount - 1));
    }
    this.reinforcedThisTurn.delete(skillId);

    return { compliant: true, violations: [], needsReinforcement: false };
  }

  /**
   * Reset tracking for a specific skill or all skills.
   */
  reset(skillId?: string): void {
    if (skillId) {
      this.violations.delete(skillId);
      this.reinforcedThisTurn.delete(skillId);
      for (const store of this.sessionViolations.values()) {
        store.delete(skillId);
      }
    } else {
      this.violations.clear();
      this.sessionViolations.clear();
      this.reinforcedThisTurn.clear();
    }
  }

  /**
   * Get the current violation count for a skill (for diagnostics).
   */
  getViolationCount(skillId: string, sessionId?: string): number {
    if (sessionId) {
      return this.getSessionStore(sessionId).get(skillId) ?? 0;
    }
    return this.violations.get(skillId) ?? 0;
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private getSessionStore(sessionId: string): Map<string, number> {
    let store = this.sessionViolations.get(sessionId);
    if (!store) {
      store = new Map();
      this.sessionViolations.set(sessionId, store);
    }
    return store;
  }

  private findViolations(
    skillId: string,
    toolCalls: ToolCallSnapshot[],
    skill: LoadedSkill,
  ): ComplianceViolation[] {
    const violations: ComplianceViolation[] = [];

    // Rule 1: Check if the skill requires specific tools that were NOT called
    // (MUST DO sections may specify mandatory tool usage)
    const body = skill.promptContent || '';

    // Extract MUST DO rules from the body
    const mustSection = body.match(/##\s+MUST\s+DO\s*\n([\s\S]*?)(?=\n##\s|\n*$)/i);
    if (mustSection) {
      const mustRules = mustSection[1]!
        .split('\n')
        .filter(line => /^[-*]\s+/.test(line.trim()))
        .map(line => line.replace(/^[-*]\s+/, '').trim())
        .filter(Boolean);

      for (const rule of mustRules) {
        // Skip prohibitions and negation rules (不要/禁止/never/do not/don't/avoid)
        if (/不要|禁止|不得|不能|never|do\s*not|don'?t|avoid|禁止|must\s*not|should\s*not/i.test(rule)) {
          continue;
        }
        // Check if the rule mentions a tool that must be used
        const toolMention = rule.match(/使用\s*(?:`)?(\w+)(?:`)?|use\s*(?:`)?(\w+)(?:`)?|call\s*(?:`)?(\w+)(?:`)?/i);
        if (toolMention) {
          const requiredTool = (toolMention[1] || toolMention[2] || toolMention[3])?.toLowerCase();
          if (requiredTool) {
            const wasCalled = toolCalls.some(
              tc => tc.name.toLowerCase() === requiredTool,
            );
            if (!wasCalled) {
              violations.push({
                rule: 'must-tool-not-called',
                message: `MUST DO rule requires "${requiredTool}" but it was not called`,
                evidence: rule,
              });
            }
          }
        }
      }
    }

    // Rule 2: Check if allowed tools constraint was violated
    if (skill.tools.allowedTools.length > 0) {
      for (const tc of toolCalls) {
        if (!skill.tools.allowedTools.includes(tc.name)) {
          violations.push({
            rule: 'unauthorized-tool',
            message: `Tool "${tc.name}" was called but is not in the skill's allowed-tools list`,
            evidence: `Allowed: ${skill.tools.allowedTools.join(', ')}`,
          });
        }
      }
    }

    return violations;
  }

  private buildReinforcement(
    skillId: string,
    skill: LoadedSkill,
    violations: ComplianceViolation[],
    count: number,
  ): string {
    const lines: string[] = [];
    lines.push(`⚠️ **Skill Compliance Warning** (${count} consecutive violations)`);
    lines.push('');
    lines.push(`The skill **${skill.manifest.name}** ($${skillId}) has been violated ${count} times in a row.`);
    lines.push('');
    lines.push('Violations this turn:');
    for (const v of violations) {
      lines.push(`  - ${v.message}`);
      if (v.evidence) lines.push(`    Evidence: ${v.evidence}`);
    }
    lines.push('');
    lines.push('Please re-read the skill rules above and ensure compliance in the next turn.');
    lines.push('If the skill rules are outdated, use `skill_lint` to review and `skill_create` to update.');

    return lines.join('\n');
  }
}
