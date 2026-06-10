import type { ResolvedSkill } from './skill-router.js';
import type { SkillMemoryScope, ApprovalOverride, ToolProfileId } from '../app/types.js';
import type { PromptLayer } from '../prompt/types.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CompiledSkillContext {
  allowedTools: string[];
  deniedTools: string[];
  promptContent: string;
  /** Layered prompt blocks (v5) — one layer per resolved skill */
  promptLayers: PromptLayer[];
  memoryScopes: SkillMemoryScope[];
  approvalOverrides: Record<string, ApprovalOverride>;
  toolsProfile?: ToolProfileId;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function deduplicate<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

// ── Core ──────────────────────────────────────────────────────────────────────

/**
 * Compile multiple resolved skills into a single context.
 *
 * Compilation rules:
 * - allowedTools: union of all skills' allowedTools (deduplicated)
 * - deniedTools: union of all skills' deniedTools
 * - promptContent: concatenate all skills' promptContent with `---` separator (legacy)
 * - promptLayers: one PromptLayer per resolved skill (v5 layered approach)
 * - memoryScopes: merge all skills' memory scopes
 * - approvalOverrides: merge all skills' approval overrides (later skills override earlier)
 */
export function compileSkillContext(resolved: ResolvedSkill[]): CompiledSkillContext {
  const result: CompiledSkillContext = {
    allowedTools: [],
    deniedTools: [],
    promptContent: '',
    promptLayers: [],
    memoryScopes: [],
    approvalOverrides: {},
  };

  if (resolved.length === 0) {
    return result;
  }

  const allAllowedTools: string[] = [];
  const allDeniedTools: string[] = [];
  const allPromptParts: string[] = [];
  const promptLayers: PromptLayer[] = [];
  const allMemoryScopes: SkillMemoryScope[] = [];
  const approvalOverrides: Record<string, ApprovalOverride> = {};

  let effectiveProfile: ToolProfileId | undefined;

  for (let i = 0; i < resolved.length; i++) {
    const { skill } = resolved[i]!;
    allAllowedTools.push(...skill.tools.allowedTools);

    if (skill.tools.deniedTools) {
      allDeniedTools.push(...skill.tools.deniedTools);
    }

    if (skill.promptContent) {
      allPromptParts.push(skill.promptContent);
      promptLayers.push({
        name: `skill:${skill.manifest.id}`,
        content: skill.promptContent,
        priority: 100 + i,
        cacheKey: `skill:${skill.manifest.id}`,
        volatile: true,
        blockTag: `skill:${skill.manifest.id}`,
      });
    }

    if (skill.memoryPolicy?.scopes) {
      allMemoryScopes.push(...skill.memoryPolicy.scopes);
    }

    // Merge approval overrides from the skill's manifest
    if (skill.approvalOverrides && skill.approvalOverrides.length > 0) {
      for (const override of skill.approvalOverrides) {
        const key = `${override.targetKind}:${override.patternType}:${override.pattern}`;
        approvalOverrides[key] = override as ApprovalOverride;
      }
    }

    // Last resolved skill's toolsProfile wins
    if (skill.toolsProfile) {
      effectiveProfile = skill.toolsProfile;
    }
  }

  result.allowedTools = deduplicate(allAllowedTools);
  result.deniedTools = deduplicate(allDeniedTools);
  result.promptContent = allPromptParts.join('\n---\n');
  result.promptLayers = promptLayers;
  result.memoryScopes = allMemoryScopes;
  result.approvalOverrides = approvalOverrides;
  result.toolsProfile = effectiveProfile;

  return result;
}
