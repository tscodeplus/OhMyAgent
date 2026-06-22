/**
 * Skill Activator
 *
 * Extracted from agent-factory.ts (Phase 9). Handles skill resolution,
 * compilation, compliance tracking, metrics recording, token stripping,
 * and approval override registration for a single Agent turn.
 */

import type { SkillRegistry } from '../skills/skill-registry.js';
import type { ApprovalGate, PatternType, PolicyEffect } from '../app/types.js';
import type { Logger } from 'pino';
import type { LoadedSkill } from '../skills/skill-loader.js';

// ── Types ──

export interface SkillActivationResult {
  /** Compiled skill context (allowed tools, prompt layers, etc.). */
  compiled: ReturnType<SkillRegistry['compile']> | undefined;
  /** Resolved scope for the activated skill. */
  scope: { scope: 'global' | 'skill'; scopeKey: string };
  /** The cleaned-up message (skill tokens stripped). */
  cleanMessage: string;
  /** All activated skill names joined by " | " for display (ordered by priority). */
  activatedSkillNames?: string;
}

export interface SkillActivationDeps {
  skillRegistry?: SkillRegistry;
  approvalGate?: ApprovalGate | null;
  logger?: Logger;
  /** Returns the AppServices container (lazy — may not exist at construction time). */
  getServices?: () => { skillMetricsService?: { recordActivation(skillId: string, sessionKey: string, message: string): string } } | undefined;
}

// ── State ──

/** Session-scoped active skill tracking (P1-3 compliance). */
export const activeSkillForSession = new Map<string, { skillId: string; skill: LoadedSkill }>();

/** Session-scoped feedback tracking for metrics (P1-4). */
export const activeSkillFeedbackIds = new Map<string, { feedbackId: string; startTime: number }>();

// ── Activation ──

/**
 * Resolve and activate a skill from the user message.
 *
 * When a skill matches, this function:
 *   1. Compiles the skill context
 *   2. Stores active skill for compliance tracking
 *   3. Records activation for metrics
 *   4. Strips $skill-id / /skill-id tokens from the message
 *   5. Registers skill-level approval overrides
 *
 * Returns the compiled context, scope, and cleaned message.
 * If no skill matches, returns defaults (undefined compiled, global scope).
 */
export function activateSkill(
  message: string,
  sessionId: string,
  deps: SkillActivationDeps,
): SkillActivationResult {
  const { skillRegistry, approvalGate, logger, getServices } = deps;

  const fallback: SkillActivationResult = {
    compiled: undefined,
    scope: { scope: 'global', scopeKey: '' },
    cleanMessage: message,
  };

  // Don't resolve when there's no message (no skill can match an empty input).
  if (!skillRegistry || !message) return fallback;

  const resolved = skillRegistry.resolve(message);
  logger?.info(
    { message, count: resolved.length, skills: resolved.map(r => r.skill.manifest.id) },
    '[skill-activator] resolution result',
  );

  if (resolved.length === 0) {
    logger?.info('[skill-activator] no skill matched — falling back to global scope');
    return fallback;
  }

  const compiled = skillRegistry.compile(resolved);
  const skill = resolved[0]!.skill;
  const scope = {
    scope: 'skill' as const,
    scopeKey: resolved[0]!.skill.manifest.id,
  };

  logger?.info({ skillId: skill.manifest.id, matchType: resolved[0]!.matchType, trigger: resolved[0]!.matchedTrigger }, '[skill-activator] skill activated');

  // P1-3: Store active skill for compliance tracking
  activeSkillForSession.set(sessionId, { skillId: skill.manifest.id, skill });

  // P1-4: Record skill activation for metrics
  let skillFeedbackId: string | undefined;
  const metricsService = getServices?.()?.skillMetricsService;
  if (metricsService) {
    skillFeedbackId = metricsService.recordActivation(
      skill.manifest.id,
      sessionId,
      message,
    );
    activeSkillFeedbackIds.set(sessionId, { feedbackId: skillFeedbackId, startTime: Date.now() });
  }

  // Strip $skill-id and /skill-id tokens from the user message
  const escapedId = skill.manifest.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let cleanMessage = message
    .replace(new RegExp(`(?:^/${escapedId}\\s*)|(?:\\$${escapedId}\\s*)`, 'gi'), '')
    .trim();
  if (!cleanMessage) {
    cleanMessage = 'I am ready to help with this skill.';
  }

  // Register skill-level approval overrides
  if (compiled.approvalOverrides && approvalGate?.createPolicy) {
    for (const [key, override] of Object.entries(compiled.approvalOverrides)) {
      const ov = override as { targetKind: string; patternType: string; pattern: string; effect: string };
      approvalGate.createPolicy({
        id: `skill-${key}`,
        scope: 'skill',
        scopeKey: '',
        targetKind: ov.targetKind,
        patternType: ov.patternType as PatternType,
        pattern: ov.pattern,
        effect: ov.effect as PolicyEffect,
      });
    }
  }

  const activatedSkillNames = resolved.map(r => r.skill.manifest.name).join(' | ');

  return { compiled, scope, cleanMessage, activatedSkillNames };
}
