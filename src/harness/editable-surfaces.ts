import { EditableSurface, EditableSurfaceKind, FailureContext, FailurePattern } from './types.js';

/**
 * Registry of all editable surfaces the harness can read and propose changes to.
 * Provides lookup, categorisation, and context-aware relevance filtering.
 */
export class EditableSurfaceProvider {
  private surfaces: Map<string, EditableSurface> = new Map();

  // ---------------------------------------------------------------------------
  // Registration & lookup
  // ---------------------------------------------------------------------------

  /** Register a single editable surface. Replaces any existing surface with the same id. */
  register(surface: EditableSurface): void {
    this.surfaces.set(surface.id, surface);
  }

  /** Retrieve a surface by its id, or undefined if not registered. */
  get(surfaceId: string): EditableSurface | undefined {
    return this.surfaces.get(surfaceId);
  }

  // ---------------------------------------------------------------------------
  // Context-aware relevance
  // ---------------------------------------------------------------------------

  /**
   * Identify the subset of registered surfaces that are relevant to a given
   * failure context, using the heuristic rules described in the surface-provider
   * specification.
   */
  identifyRelevantSurfaces(context: FailureContext): EditableSurface[] {
    const selected: EditableSurface[] = [];
    const seen = new Set<string>();

    // The failure pattern is not part of the base FailureContext interface but
    // is provided at runtime by the caller (e.g. from a FailureSignal).
    const pattern: FailurePattern | undefined = (context as FailureContext & { pattern?: FailurePattern }).pattern;

    const addOnce = (surface: EditableSurface): void => {
      if (!seen.has(surface.id)) {
        seen.add(surface.id);
        selected.push(surface);
      }
    };

    // -- Step 2: skill-context surfaces --------------------------------------
    // When a skill was active, add every surface whose kind begins with "skill_"
    // AND whose path contains the skill id.
    if (context.skillId) {
      for (const surface of this.surfaces.values()) {
        if (surface.kind.startsWith('skill_') && surface.path.includes(context.skillId)) {
          addOnce(surface);
        }
      }
    }

    // -- Step 3: agent-context surfaces --------------------------------------
    // When a non-default agent was active, add the agent_system_prompt and
    // agent_role_description surfaces whose path contains the agent id.
    if (context.agentId && context.agentId !== 'default') {
      for (const surface of this.surfaces.values()) {
        if (
          (surface.kind === 'agent_system_prompt' || surface.kind === 'agent_role_description') &&
          surface.path.includes(context.agentId)
        ) {
          addOnce(surface);
        }
      }
    }

    // -- Step 4: pattern-specific global surfaces ----------------------------
    // Based on the detected failure pattern, add the surfaces whose kind matches
    // the rule set for that pattern.
    if (pattern) {
      const patternKinds = PATTERN_SURFACE_KINDS[pattern];
      if (patternKinds) {
        for (const surface of this.surfaces.values()) {
          if ((patternKinds as readonly EditableSurfaceKind[]).includes(surface.kind)) {
            addOnce(surface);
          }
        }
      }
    }

    // -- Step 5: fallback ----------------------------------------------------
    // If no surfaces were selected and there is no skill context, include the
    // base_system_prompt surface as a minimal default.
    if (selected.length === 0 && !context.skillId) {
      for (const surface of this.surfaces.values()) {
        if (surface.kind === 'base_system_prompt') {
          addOnce(surface);
          break;
        }
      }
    }

    // Steps 1 (start empty) and 6 (deduplicate by id) are inherent in the
    // logic above — we initialise `selected` as `[]` and always call `addOnce`.
    return selected;
  }

  // ---------------------------------------------------------------------------
  // Value accessors
  // ---------------------------------------------------------------------------

  /** Return the current value of the surface identified by `surfaceId`. */
  getCurrentValue(surfaceId: string): string {
    const surface = this.surfaces.get(surfaceId);
    return surface ? surface.currentValue : '';
  }

  /** Set the current value of the surface identified by `surfaceId`. No-op if the surface does not exist. */
  setCurrentValue(surfaceId: string, value: string): void {
    const surface = this.surfaces.get(surfaceId);
    if (surface) {
      surface.currentValue = value;
    }
  }

  // ---------------------------------------------------------------------------
  // Categorised queries
  // ---------------------------------------------------------------------------

  /** Return all surfaces associated with the given skill. */
  getSkillSurfaces(skillId: string): EditableSurface[] {
    const result: EditableSurface[] = [];
    for (const surface of this.surfaces.values()) {
      if (surface.kind.startsWith('skill_') && surface.path.includes(skillId)) {
        result.push(surface);
      }
    }
    return result;
  }

  /** Return all surfaces associated with the given agent. */
  getAgentSurfaces(agentId: string): EditableSurface[] {
    const result: EditableSurface[] = [];
    for (const surface of this.surfaces.values()) {
      if (
        (surface.kind === 'agent_system_prompt' || surface.kind === 'agent_role_description') &&
        surface.path.includes(agentId)
      ) {
        result.push(surface);
      }
    }
    return result;
  }

  /** Return all global surfaces (those whose id starts with "global:"). */
  getGlobalSurfaces(): EditableSurface[] {
    const result: EditableSurface[] = [];
    for (const surface of this.surfaces.values()) {
      if (surface.id.startsWith('global:')) {
        result.push(surface);
      }
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Maps each recognised failure pattern to the set of surface kinds that should
 * be exposed for diagnosis/proposal when that pattern is detected.
 */
const PATTERN_SURFACE_KINDS: Record<FailurePattern, EditableSurfaceKind[]> = {
  identical_retry_loop: ['failure_recovery_instruction', 'tool_description'],
  exploration_without_output: ['execution_instruction', 'turn_counter_rules', 'spawn_policy'],
  tool_error_cascade: ['failure_recovery_instruction', 'tool_execution_mode'],
  timeout_or_abort: ['max_retry_delay', 'thinking_budget', 'spawn_policy'],
  dependency_not_checked: [],
  user_explicit_dissatisfied: ['base_system_prompt', 'agent_system_prompt'],
};
