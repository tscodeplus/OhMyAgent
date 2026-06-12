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

// ── Structured Section Parsing ────────────────────────────────────────────────

/**
 * Regex patterns for structured SKILL.md body sections.
 * Priority range 70-100: after agent override(50), before child modifier(200).
 * Matching order matters: earlier patterns match first, remaining content
 * (anything not matched by these patterns) becomes the "role" layer.
 */
const SECTION_PATTERNS: Array<{
  regex: RegExp;
  layerName: string;
  priority: number;
  volatile: boolean;
}> = [
  { regex: /##\s+MUST\s+DO\s*\n([\s\S]*?)(?=\n##\s|\n*$)/i, layerName: 'must', priority: 75, volatile: false },
  { regex: /##\s+SHOULD\s+DO\s*\n([\s\S]*?)(?=\n##\s|\n*$)/i, layerName: 'should', priority: 85, volatile: true },
  { regex: /##\s+WHEN\b[^\n]*\n([\s\S]*?)(?=\n##\s|\n*$)/i, layerName: 'when', priority: 95, volatile: true },
  { regex: /##\s+Output\s+Format\s*\n([\s\S]*?)(?=\n##\s|\n*$)/i, layerName: 'output-format', priority: 90, volatile: true },
  { regex: /##\s+Verification\s+Checklist\s*\n([\s\S]*?)(?=\n##\s|\n*$)/i, layerName: 'checklist', priority: 80, volatile: false },
  { regex: /##\s+Examples?\s*\n([\s\S]*?)(?=\n##\s|\n*$)/i, layerName: 'examples', priority: 100, volatile: true },
];

/**
 * Parse a SKILL.md body into structured PromptLayer objects.
 * Recognizes MUST DO, SHOULD DO, WHEN, Output Format, Verification Checklist,
 * and Examples sections. Unmatched content becomes a "role" layer.
 *
 * Returns empty array when promptContent is empty.
 */
function parseStructuredSections(
  skillId: string,
  promptContent: string,
): PromptLayer[] {
  if (!promptContent || !promptContent.trim()) {
    return [];
  }

  const layers: PromptLayer[] = [];
  let remaining = promptContent;

  // Extract recognized sections
  for (const pattern of SECTION_PATTERNS) {
    const match = remaining.match(pattern.regex);
    if (match && match[1]?.trim()) {
      layers.push({
        name: `skill:${skillId}:${pattern.layerName}`,
        content: match[1].trim(),
        priority: pattern.priority,
        volatile: pattern.volatile,
        cacheKey: pattern.volatile ? '' : `skill:${skillId}:${pattern.layerName}`,
        blockTag: `skill:${skillId}:${pattern.layerName}`,
      });
    }
  }

  // Strip recognized sections to get remaining "role" content
  for (const pattern of SECTION_PATTERNS) {
    remaining = remaining.replace(pattern.regex, '');
  }
  remaining = remaining.replace(/\n{3,}/g, '\n\n').trim();

  if (remaining) {
    layers.push({
      name: `skill:${skillId}:role`,
      content: remaining,
      priority: 70,
      volatile: false,
      cacheKey: `skill:${skillId}:role`,
      blockTag: `skill:${skillId}:role`,
    });
  }

  return layers;
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
      const structuredLayers = parseStructuredSections(skill.manifest.id, skill.promptContent);
      if (structuredLayers.length > 0) {
        promptLayers.push(...structuredLayers);
      } else {
        // Fallback: unstructured body → single layer
        promptLayers.push({
          name: `skill:${skill.manifest.id}`,
          content: skill.promptContent,
          priority: 70 + i,
          cacheKey: `skill:${skill.manifest.id}`,
          volatile: true,
          blockTag: `skill:${skill.manifest.id}`,
        });
      }
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
