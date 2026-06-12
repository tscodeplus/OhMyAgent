/**
 * Skill Creator — generates SKILL.md from templates with variable substitution.
 *
 * Usage:
 *   const result = await createSkill(input, deps);
 *   // → { ok: boolean, skillId?: string, lintResult?: LintResult }
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { lintSkill, type LintResult } from './skill-linter.js';
import type { SkillRegistry } from '../app/types.js';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface CreateSkillInput {
  /** Display name (e.g. "日程管理") */
  name: string;
  /** Description for frontmatter */
  description: string;
  /** Kebab-case slug for the skill directory. Auto-generated if omitted. */
  slug?: string;
  /** Template name (default: "best-practice") */
  template?: string;
  /** Additional requirements for the agent to elaborate */
  requirements?: string;
  /** Optional comma-separated triggers */
  triggers?: string;
  /** Optional space-separated tool names */
  allowedTools?: string;
  /** Optional priority (default: 0) */
  priority?: number;
}

export interface CreateSkillResult {
  ok: boolean;
  skillId?: string;
  lintResult?: LintResult;
  error?: string;
}

export interface SkillCreatorDeps {
  skillsDir: string;
  skillRegistry: SkillRegistry;
  /** List of all registered tool names */
  getToolNames: () => string[];
}

// ── Kebab-case conversion ──────────────────────────────────────────────────────

/**
 * Convert a name to kebab-case. For names without latin characters (e.g. CJK),
 * generates a deterministic short hash so the same name always produces the
 * same slug — essential for skill_create → reload consistency.
 */
function toKebabCase(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  if (slug) return slug;
  // Deterministic fallback: short hash of the name, prefixed for readability
  const hash = createHash('sha256').update(name).digest('hex').slice(0, 8);
  return `sk-${hash}`;
}

// ── Template rendering ─────────────────────────────────────────────────────────

/** Simple {{variable}} template substitution. */
function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, name) => vars[name] ?? `{{${name}}}`);
}

/** YAML-safe quoting for user-supplied strings inserted into frontmatter. */
function yamlQuote(s: string): string {
  // Escape backslashes and double quotes, wrap in double quotes
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// ── Core ───────────────────────────────────────────────────────────────────────

export async function createSkill(
  input: CreateSkillInput,
  deps: SkillCreatorDeps,
): Promise<CreateSkillResult> {
  if (!input.name || typeof input.name !== 'string') {
    return { ok: false, error: 'Missing required parameter: name' };
  }
  if (!input.description || typeof input.description !== 'string') {
    return { ok: false, error: 'Missing required parameter: description' };
  }
  const skillId = input.slug || toKebabCase(input.name);
  const templateName = input.template || 'best-practice';

  // 1. Read template
  const templatePath = join(deps.skillsDir, '_templates', templateName, 'SKILL.md');
  let templateContent: string;
  try {
    templateContent = await readFile(templatePath, 'utf-8');
  } catch {
    return {
      ok: false,
      error: `Template "${templateName}" not found at ${templatePath}`,
    };
  }

  // 2. Build sensible triggers
  // If the name is a kebab-case slug (no CJK/natural language), extract keywords from description
  let triggers = input.triggers || '';
  if (!triggers && /^[a-z0-9-]+$/.test(input.name) && input.description) {
    // Name is a slug — pull trigger keywords from description
    const words = input.description
      .replace(/[，,、\s]+/g, ',')
      .replace(/[。.!！？?]+/g, ',')
      .split(',')
      .filter(w => w.length >= 2 && w.length <= 8)
      .slice(0, 6);
    triggers = [...new Set([input.name, ...words])].join(', ');
  }
  if (!triggers) {
    triggers = input.name;
  }
  const allowedTools = input.allowedTools || '';
  const priority = String(input.priority ?? 0);
  const roleDescription = input.requirements
    ? `${input.description}。${input.requirements}`
    : input.description;

  const rendered = renderTemplate(templateContent, {
    name: yamlQuote(input.name),
    description: yamlQuote(input.description),
    triggers: yamlQuote(triggers),
    tools: allowedTools,
    priority,
    roleDescription: yamlQuote(roleDescription),
  });

  // 3. Create skill directory and write SKILL.md
  const skillDir = join(deps.skillsDir, skillId);
  try {
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), rendered, 'utf-8');
  } catch (err) {
    return {
      ok: false,
      error: `Failed to write skill: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // 4. Reload skills
  await deps.skillRegistry.load(deps.skillsDir);

  // 5. Auto-lint
  const loadedSkill = deps.skillRegistry.getSkillById(skillId);
  if (!loadedSkill) {
    return {
      ok: false,
      error: `Skill "${skillId}" was created but failed to reload. Check SKILL.md syntax.`,
    };
  }

  const lintResult = lintSkill(loadedSkill, deps.getToolNames());

  return {
    ok: lintResult.ok,
    skillId,
    lintResult,
  };
}
