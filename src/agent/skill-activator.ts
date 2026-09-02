/**
 * Skill Activator
 *
 * Extracted from agent-factory.ts (Phase 9). Handles skill resolution,
 * compilation, compliance tracking, metrics recording, token stripping,
 * and approval override registration for a single Agent turn.
 */

import type { SkillRegistry } from '../skills/skill-registry.js';
import type { ConflictReport } from '../skills/skill-compiler.js';
import type { ApprovalGate, PatternType, PolicyEffect } from '../app/types.js';
import type { SkillToolOverrides } from '../policy/tool-visibility.js';
import type { Logger } from 'pino';
import type { LoadedSkill } from '../skills/skill-loader.js';
import { LRUCache } from 'lru-cache';

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
  /**
   * Conflict reports for the co-activated skills. Historically these were
   * computed and dropped — no consumer existed (report #8). They are logged
   * at activation time and exposed here so the agent layer can enforce them.
   */
  conflicts?: ConflictReport[];
}

export interface SkillActivationDeps {
  skillRegistry?: SkillRegistry;
  approvalGate?: ApprovalGate | null;
  logger?: Logger;
  /** Returns the AppServices container (lazy — may not exist at construction time). */
  getServices?: () =>
    | {
        skillMetricsService?: {
          recordActivation(skillId: string, sessionKey: string, message: string): string;
        };
      }
    | undefined;
}

// ── State ──

// Session-scoped tracking maps use bounded LRU caches (TTL 24h) — plain Maps
// grew without bound on the long-running gateway and concurrent turns on the
// same session silently overwrote each other's state.

/** Session-scoped active skill tracking (P1-3 compliance). */
export const activeSkillForSession = new LRUCache<string, { skillId: string; skill: LoadedSkill }>({
  max: 1000,
  ttl: 1000 * 60 * 60 * 24,
});

/** Session-scoped feedback tracking for metrics (P1-4). */
export const activeSkillFeedbackIds = new LRUCache<
  string,
  { feedbackId: string; startTime: number }
>({
  max: 1000,
  ttl: 1000 * 60 * 60 * 24,
});

/**
 * Compiled skill tool policy, keyed by skill scope key (the manifest id the
 * approval gate sees as `resolvedSkillScope.scopeKey`). Skill allow/deny lists
 * used to be compiled and then only logged, so a skill declaring
 * `deniedTools: [shell]` never actually lost shell.
 *
 * Keyed by skill id rather than session on purpose: a global-scope turn looks up
 * nothing, so a stale entry can never leak into a skill-less turn.
 */
export const skillToolPolicyByScopeKey = new LRUCache<string, SkillToolOverrides>({
  max: 200,
});

/** Tool policy for the activated skill scope, or undefined when none applies. */
export function getSkillToolPolicy(scope: {
  scope: 'global' | 'skill';
  scopeKey: string;
}): SkillToolOverrides | undefined {
  if (scope.scope !== 'skill' || !scope.scopeKey) return undefined;
  return skillToolPolicyByScopeKey.get(scope.scopeKey);
}

// ── Activation ──

/**
 * Resolve and activate a skill from the user message.
 *
 * When a skill matches, this function:
 *   1. Compiles the skill context
 *   2. Stores active skill for compliance tracking
 *   3. Records activation for metrics
 *   4. Strips $skill-id / /skill:skill-id tokens from the message
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
    { message, count: resolved.length, skills: resolved.map((r) => r.skill.manifest.id) },
    '[skill-activator] resolution result',
  );

  if (resolved.length === 0) {
    logger?.info('[skill-activator] no skill matched — falling back to global scope');
    return fallback;
  }

  const compiled = skillRegistry.compile(resolved);

  // Report #8 follow-up: detectConflicts() output used to have zero
  // consumers — reports were computed and silently dropped. Surface them:
  // error-level conflicts (declared via metadata.x-ohmyagent.conflicts or
  // deny-priority tool clashes) log as errors, the rest as warnings, and
  // they ride on the result for downstream enforcement.
  // (Tolerate registries/mocks that predate the conflicts field.)
  const conflicts = compiled.conflicts ?? [];
  if (conflicts.length > 0) {
    for (const conflict of conflicts) {
      if (conflict.level === 'error') {
        logger?.error({ conflict }, '[skill-activator] skill conflict detected');
      } else {
        logger?.warn({ conflict }, '[skill-activator] skill conflict detected');
      }
    }
  }

  const skill = resolved[0]!.skill;
  const scope = {
    scope: 'skill' as const,
    scopeKey: resolved[0]!.skill.manifest.id,
  };

  logger?.info(
    {
      skillId: skill.manifest.id,
      matchType: resolved[0]!.matchType,
      trigger: resolved[0]!.matchedTrigger,
    },
    '[skill-activator] skill activated',
  );

  // P1-3: Store active skill for compliance tracking
  activeSkillForSession.set(sessionId, { skillId: skill.manifest.id, skill });

  // P1-4: Record skill activation for metrics
  let skillFeedbackId: string | undefined;
  const metricsService = getServices?.()?.skillMetricsService;
  if (metricsService) {
    skillFeedbackId = metricsService.recordActivation(skill.manifest.id, sessionId, message);
    activeSkillFeedbackIds.set(sessionId, { feedbackId: skillFeedbackId, startTime: Date.now() });
  }

  // Strip $skill-id and /skill:skill-id tokens from the user message
  const escapedId = skill.manifest.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let cleanMessage = message
    .replace(new RegExp(`(?:^/skill:${escapedId}\\s*)|(?:\\$${escapedId}\\s*)`, 'gi'), '')
    .trim();
  if (!cleanMessage) {
    cleanMessage = 'I am ready to help with this skill.';
  }

  // Record the compiled tool policy so the runtime approval gate can enforce
  // skill allow/deny lists (see getSkillToolPolicy / PolicyCenter.evaluateToolCall).
  skillToolPolicyByScopeKey.set(scope.scopeKey, {
    allowedTools: compiled.allowedTools,
    deniedTools: compiled.deniedTools,
  });

  // Register skill-level approval overrides, scoped to the activating skill.
  // ApprovalGate.scopeMatches() treats an empty scope key as a wildcard, so
  // registering with scopeKey: '' would turn a skill's `allow` override into a
  // permanent, never-revoked approval bypass for every skill-activated session.
  // Ids embed the skill id and registration is an upsert, so re-activating the
  // same skill (i.e. every inbound message it matches) is idempotent.
  if (compiled.approvalOverrides && approvalGate?.createPolicy) {
    if (!scope.scopeKey) {
      logger?.warn(
        { skillId: skill.manifest.id },
        '[skill-activator] skipping approval overrides: no skill scope key to bind to',
      );
    } else {
      for (const [key, override] of Object.entries(compiled.approvalOverrides)) {
        const ov = override as {
          targetKind: string;
          patternType: string;
          pattern: string;
          effect: string;
        };
        approvalGate.createPolicy({
          id: `skill-${scope.scopeKey}-${key}`,
          scope: 'skill',
          scopeKey: scope.scopeKey,
          targetKind: ov.targetKind,
          patternType: ov.patternType as PatternType,
          pattern: ov.pattern,
          effect: ov.effect as PolicyEffect,
        });
      }
    }
  }

  const activatedSkillNames = resolved.map((r) => r.skill.manifest.name).join(' | ');

  return { compiled, scope, cleanMessage, activatedSkillNames, conflicts };
}
