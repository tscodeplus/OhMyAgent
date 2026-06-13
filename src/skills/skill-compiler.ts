import type { ResolvedSkill } from './skill-router.js';
import type { SkillMemoryScope, ApprovalOverride, ToolProfileId, LoadedSkill } from '../app/types.js';
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
  /** Conflict reports for multi-skill activation (P1-2) */
  conflicts: ConflictReport[];
}

// ── P1-2: Conflict Detection & Resolution ──────────────────────────────────────

export interface ConflictReport {
  level: 'info' | 'warning' | 'error';
  type: 'tool_conflict' | 'trigger_overlap' | 'declared_conflict';
  skills: string[];
  detail: string;
  resolution?: string;
}

/**
 * Extended skill metadata defined in the frontmatter `metadata.x-ohmyagent` block.
 * Parsed by the skill loader and stored on the manifest for the compiler to use.
 */
export interface OhMyAgentMetadata {
  /** Skill IDs that compose well with this skill (cooperative multi-skill activation). */
  composesWith?: string[];
  /** Skill IDs that conflict with this skill (mutually exclusive). */
  conflicts?: string[];
  /** Minimum priority required for a co-activated skill (default: none). */
  minCompanionPriority?: number;
}

/**
 * Detect conflicts between multiple activated skills.
 *
 * Rules:
 * 1. Tool conflict: Skill A allows a tool that Skill B denies → deny wins
 * 2. Declared conflict: Skill A declares `conflicts: [B]` → both flagged
 * 3. Trigger overlap: Skills share trigger keywords → info-level warning
 */
export function detectConflicts(skills: LoadedSkill[]): ConflictReport[] {
  const reports: ConflictReport[] = [];

  if (skills.length < 2) return reports;

  // ── Rule 1: Tool conflicts (deny-priority) ──────────────────────────────
  for (let i = 0; i < skills.length; i++) {
    for (let j = i + 1; j < skills.length; j++) {
      const a = skills[i]!;
      const b = skills[j]!;

      // A allows + B denies same tool → conflict
      for (const allowed of a.tools.allowedTools) {
        if (b.tools.deniedTools?.includes(allowed)) {
          reports.push({
            level: 'warning',
            type: 'tool_conflict',
            skills: [a.manifest.id, b.manifest.id],
            detail: `${a.manifest.id} allows "${allowed}" but ${b.manifest.id} denies it — deny wins`,
            resolution: `Tool "${allowed}" will be denied (safety-first)`,
          });
        }
      }
      for (const allowed of b.tools.allowedTools) {
        if (a.tools.deniedTools?.includes(allowed)) {
          reports.push({
            level: 'warning',
            type: 'tool_conflict',
            skills: [b.manifest.id, a.manifest.id],
            detail: `${b.manifest.id} allows "${allowed}" but ${a.manifest.id} denies it — deny wins`,
            resolution: `Tool "${allowed}" will be denied (safety-first)`,
          });
        }
      }
    }
  }

  // ── Rule 2: Declared conflicts from metadata.x-ohmyagent ──────────────
  const idSet = new Set(skills.map(s => s.manifest.id));
  for (const skill of skills) {
    const meta = (skill.manifest as any)._ohmyagentMeta as OhMyAgentMetadata | undefined;
    if (meta?.conflicts) {
      for (const conflictId of meta.conflicts) {
        if (idSet.has(conflictId)) {
          reports.push({
            level: 'error',
            type: 'declared_conflict',
            skills: [skill.manifest.id, conflictId],
            detail: `${skill.manifest.id} declares a conflict with ${conflictId} (metadata.x-ohmyagent.conflicts)`,
            resolution: `Consider deactivating one of these skills. The higher-priority skill (${skill.manifest.id}, P${skill.manifest.priority}) takes precedence.`,
          });
        }
      }
    }

    // Check composesWith: log cooperative pairings
    if (meta?.composesWith) {
      const companions = meta.composesWith.filter(cid => idSet.has(cid));
      for (const cid of companions) {
        reports.push({
          level: 'info',
          type: 'declared_conflict',
          skills: [skill.manifest.id, cid],
          detail: `${skill.manifest.id} declares compatibility with ${cid} (metadata.x-ohmyagent.composesWith)`,
          resolution: 'Cooperative pairing — both skills active.',
        });
      }
    }
  }

  // ── Rule 3: Trigger overlap detection ──────────────────────────────────
  for (let i = 0; i < skills.length; i++) {
    for (let j = i + 1; j < skills.length; j++) {
      const a = skills[i]!;
      const b = skills[j]!;
      const aTriggers = new Set(a.manifest.triggers.map(t => t.toLowerCase()));
      const bTriggers = new Set(b.manifest.triggers.map(t => t.toLowerCase()));
      const overlap = [...aTriggers].filter(t => bTriggers.has(t));

      if (overlap.length > 0) {
        reports.push({
          level: 'info',
          type: 'trigger_overlap',
          skills: [a.manifest.id, b.manifest.id],
          detail: `Shared triggers: ${overlap.join(', ')}`,
          resolution: `Higher priority skill resolves first. Consider differentiating triggers.`,
        });
      }
    }
  }

  return reports;
}

/**
 * Resolve tool conflicts using deny-priority strategy.
 * When skill A allows a tool and skill B denies it, the tool is removed from the allowed set.
 */
export function resolveToolConflicts(
  allowedTools: string[],
  deniedTools: string[],
): string[] {
  if (deniedTools.length === 0) return allowedTools;
  const denied = new Set(deniedTools);
  return allowedTools.filter(t => !denied.has(t));
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

// ── P2-3: Few-Shot Example Sub-Parsing ─────────────────────────────────────────

/**
 * Parse the ## Examples section into Good/Bad sub-examples.
 * Each sub-example becomes its own PromptLayer so Good examples get
 * higher weight than Bad (avoidance) examples.
 *
 * Format:
 *   ## Examples
 *
 *   ### Good: <description>
 *   User: ...
 *   Assistant: ...
 *
 *   ### Bad: <description>
 *   User: ...
 *   Assistant: ... ❌
 */
function parseExamplesSection(
  skillId: string,
  examplesContent: string,
): PromptLayer[] {
  if (!examplesContent || !examplesContent.trim()) return [];

  const layers: PromptLayer[] = [];
  const blocks = examplesContent.split(/(?=###\s+(?:Good|Bad):)/i);

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    const isGood = /^###\s+Good:/i.test(trimmed);
    const isBad = /^###\s+Bad:/i.test(trimmed);

    if (isGood) {
      layers.push({
        name: `skill:${skillId}:example-good`,
        content: trimmed,
        priority: 115, // Slightly higher than base examples
        volatile: true,
        cacheKey: '',
        blockTag: `skill:${skillId}:example-good`,
      });
    } else if (isBad) {
      layers.push({
        name: `skill:${skillId}:example-bad`,
        content: trimmed.replace(/❌/g, '') + '\n[Above is an anti-pattern — DO NOT follow this approach]',
        priority: 125, // Lowest — trim first
        volatile: true,
        cacheKey: '',
        blockTag: `skill:${skillId}:example-bad`,
      });
    } else {
      // Unlabeled example block — treat as general example
      layers.push({
        name: `skill:${skillId}:example`,
        content: trimmed,
        priority: 120,
        volatile: true,
        cacheKey: '',
        blockTag: `skill:${skillId}:example`,
      });
    }
  }

  return layers;
}

/**
 * Parse a SKILL.md body into structured PromptLayer objects.
 * Recognizes MUST DO, SHOULD DO, WHEN, Output Format, Verification Checklist,
 * and Examples sections. Unmatched content becomes a "role" layer.
 *
 * The Examples section is further parsed for Good/Bad sub-examples (P2-3).
 *
 * Returns empty array when promptContent is empty.
 */
export function parseStructuredSections(
  skillId: string,
  promptContent: string,
): PromptLayer[] {
  if (!promptContent || !promptContent.trim()) {
    return [];
  }

  const layers: PromptLayer[] = [];
  let remaining = promptContent;

  // Extract recognized sections (skip Examples — handled specially by P2-3)
  const nonExamplePatterns = SECTION_PATTERNS.filter(p => p.layerName !== 'examples');
  for (const pattern of nonExamplePatterns) {
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

  // P2-3: Parse Examples section for Good/Bad sub-examples
  const examplesPattern = SECTION_PATTERNS.find(p => p.layerName === 'examples')!;
  const examplesMatch = remaining.match(examplesPattern.regex);
  if (examplesMatch && examplesMatch[1]?.trim()) {
    const exampleLayers = parseExamplesSection(skillId, examplesMatch[1].trim());
    layers.push(...exampleLayers);
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
 * Compilation rules (updated P1-2):
 * - allowedTools: union of all skills' allowedTools, minus denied tools (deny-priority)
 * - deniedTools: union of all skills' deniedTools
 * - promptContent: concatenate all skills' promptContent with `---` separator (legacy)
 * - promptLayers: one PromptLayer per resolved skill (v5 layered approach)
 * - memoryScopes: merge all skills' memory scopes
 * - approvalOverrides: merge all skills' approval overrides (later skills override earlier)
 * - conflicts: detect and report conflicts between co-activated skills
 */
export function compileSkillContext(resolved: ResolvedSkill[]): CompiledSkillContext {
  const result: CompiledSkillContext = {
    allowedTools: [],
    deniedTools: [],
    promptContent: '',
    promptLayers: [],
    memoryScopes: [],
    approvalOverrides: {},
    conflicts: [],
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

  // P1-2: Detect and report conflicts
  const rawSkills = resolved.map(r => r.skill);
  result.conflicts = detectConflicts(rawSkills);

  // P1-2: Resolve tool conflicts (deny-priority)
  result.allowedTools = resolveToolConflicts(
    deduplicate(allAllowedTools),
    deduplicate(allDeniedTools),
  );
  result.deniedTools = deduplicate(allDeniedTools);
  result.promptContent = allPromptParts.join('\n---\n');
  result.promptLayers = promptLayers;
  result.memoryScopes = allMemoryScopes;
  result.approvalOverrides = approvalOverrides;
  result.toolsProfile = effectiveProfile;

  return result;
}
