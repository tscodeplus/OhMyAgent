import { EditableSurface, EditableSurfaceKind, FailureContext, FailurePattern } from './types.js';
import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';

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
    const pattern: FailurePattern | undefined = (
      context as FailureContext & { pattern?: FailurePattern }
    ).pattern;

    const addOnce = (surface: EditableSurface): void => {
      if (!seen.has(surface.id)) {
        seen.add(surface.id);
        selected.push(surface);
      }
    };

    // -- Step 2: skill-context surfaces --------------------------------------
    // When a skill was active, add every surface whose kind begins with "skill_"
    // AND whose path or aliases match any of the activated skill names
    // (the runtime may report several names joined by " | ").
    if (context.skillId) {
      const skillTokens = context.skillId
        .split(' | ')
        .map((s) => s.trim())
        .filter(Boolean);
      for (const surface of this.surfaces.values()) {
        if (!surface.kind.startsWith('skill_')) continue;
        const matches = (token: string): boolean =>
          surface.path.includes(token) ||
          (surface.aliases?.some((alias) => alias === token) ?? false);
        if (skillTokens.some(matches)) {
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
      if (!surface.kind.startsWith('skill_')) continue;
      const matches =
        surface.path.includes(skillId) ||
        (surface.aliases?.some((alias) => alias === skillId) ?? false);
      if (matches) result.push(surface);
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
  dependency_not_checked: ['failure_recovery_instruction', 'tool_description'],
  user_explicit_dissatisfied: ['base_system_prompt', 'agent_system_prompt'],
};

// ---------------------------------------------------------------------------
// Skill file surface registration
// ---------------------------------------------------------------------------

interface SkillFileFrontmatter {
  name?: unknown;
  description?: unknown;
  triggers?: unknown;
  'allowed-tools'?: unknown;
  'x-ohmyagent'?: { memoryPolicy?: unknown };
}

/**
 * Parse the YAML frontmatter block of a SKILL.md file.
 * Returns `null` when the file has no frontmatter or cannot be parsed.
 */
export async function parseSkillFrontmatter(
  filePath: string,
): Promise<SkillFileFrontmatter | null> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!match) return null;
  try {
    const parsed = parseYaml(match[1]!) as SkillFileFrontmatter;
    return typeof parsed === 'object' && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

/** Extract the body text (everything after the frontmatter block). */
export function extractSkillBody(content: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(content);
  return match ? content.slice(match[0].length).trim() : content.trim();
}

/**
 * Register the editable surfaces backed by a single skill file
 * (`skills/<id>/SKILL.md`). The surface ids become the only legal
 * modification targets for SkillEditor — this registration is the
 * allow-list for what the harness may change.
 *
 * @param provider  the surface registry to populate
 * @param skillId   directory name of the skill
 * @param filePath  absolute path to the skill's SKILL.md
 * @returns number of surfaces registered
 */
export async function registerSkillFileSurfaces(
  provider: EditableSurfaceProvider,
  skillId: string,
  filePath: string,
): Promise<number> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    return 0;
  }

  const frontmatter = await parseSkillFrontmatter(filePath);
  const body = extractSkillBody(content);
  const aliases: string[] = [];
  if (frontmatter && typeof frontmatter.name === 'string' && frontmatter.name.length > 0) {
    aliases.push(frontmatter.name);
  }

  let registered = 0;
  const register = (surface: EditableSurface): void => {
    provider.register(surface);
    registered++;
  };

  if (body.length > 0) {
    register({
      id: `skill:${skillId}:prompt`,
      kind: 'skill_prompt',
      path: filePath,
      label: `Skill "${skillId}" — prompt body`,
      currentValue: body,
      mechanismFamily: 'prompt_instruction',
      aliases,
    });
  }

  const triggers = frontmatter?.triggers;
  if (Array.isArray(triggers) && triggers.length > 0) {
    register({
      id: `skill:${skillId}:triggers`,
      kind: 'skill_triggers',
      path: filePath,
      label: `Skill "${skillId}" — triggers`,
      currentValue: triggers.map((t) => String(t)).join('\n'),
      mechanismFamily: 'skill_procedure',
      aliases,
    });
  }

  const allowedTools = frontmatter?.['allowed-tools'];
  if (typeof allowedTools === 'string' && allowedTools.trim().length > 0) {
    register({
      id: `skill:${skillId}:allowed_tools`,
      kind: 'skill_allowed_tools',
      path: filePath,
      label: `Skill "${skillId}" — allowed tools`,
      currentValue: allowedTools,
      mechanismFamily: 'skill_procedure',
      aliases,
    });
  }

  const memoryPolicy = frontmatter?.['x-ohmyagent']?.memoryPolicy;
  if (memoryPolicy !== undefined) {
    register({
      id: `skill:${skillId}:memory_policy`,
      kind: 'skill_memory_policy',
      path: filePath,
      label: `Skill "${skillId}" — memory policy`,
      currentValue: JSON.stringify(memoryPolicy, null, 2),
      mechanismFamily: 'skill_procedure',
      aliases,
    });
  }

  return registered;
}
