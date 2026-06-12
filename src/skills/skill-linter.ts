/**
 * Skill Linter — validates SKILL.md correctness and completeness.
 *
 * Usage:
 *   const result = lintSkill(loadedSkill, toolNames);
 *   // → { ok: boolean, issues: LintIssue[] }
 */

import type { LoadedSkill } from './skill-loader.js';

// ── Types ──────────────────────────────────────────────────────────────────────

export type LintLevel = 'error' | 'warning' | 'info';

export interface LintIssue {
  level: LintLevel;
  rule: string;
  message: string;
  /** Associated field or section name */
  field?: string;
}

export interface LintResult {
  /** false if any error-level issue exists */
  ok: boolean;
  issues: LintIssue[];
}

// ── Kebab-case check ───────────────────────────────────────────────────────────

const KEBAB_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// ── Recognized structured sections ─────────────────────────────────────────────

const RECOGNIZED_SECTIONS = ['MUST DO', 'SHOULD DO', 'WHEN', 'Output Format', 'Verification Checklist', 'Examples'];

// ── Core ───────────────────────────────────────────────────────────────────────

/**
 * Lint a loaded skill and return issues.
 *
 * @param skill - The loaded skill to validate.
 * @param toolNames - Names of all registered tools (for allowed-tools validation).
 */
export function lintSkill(skill: LoadedSkill, toolNames: string[]): LintResult {
  const issues: LintIssue[] = [];

  // ── Frontmatter errors ───────────────────────────────────────────────────

  if (!skill.manifest.name || skill.manifest.name.length === 0) {
    issues.push({ level: 'error', rule: 'frontmatter.name', message: 'name is required', field: 'name' });
  }

  if (!skill.manifest.description || skill.manifest.description.length === 0) {
    issues.push({ level: 'error', rule: 'frontmatter.description', message: 'description is required', field: 'description' });
  }

  if (!KEBAB_RE.test(skill.manifest.id)) {
    issues.push({
      level: 'error',
      rule: 'name.kebab-case',
      message: `Skill id "${skill.manifest.id}" must be lowercase kebab-case (e.g. "my-skill")`,
      field: 'name',
    });
  }

  if (!skill.manifest.triggers || skill.manifest.triggers.length === 0) {
    issues.push({
      level: 'error',
      rule: 'triggers.required',
      message: 'At least one trigger word is required for skill activation',
      field: 'triggers',
    });
  }

  // ── Frontmatter warnings ─────────────────────────────────────────────────

  if (skill.manifest.description && skill.manifest.description.length < 20) {
    issues.push({
      level: 'warning',
      rule: 'description.too-short',
      message: `Description is only ${skill.manifest.description.length} chars — consider a more detailed description (≥20 chars) for better trigger matching`,
      field: 'description',
    });
  }

  // ── Tools warnings ───────────────────────────────────────────────────────

  for (const tool of skill.tools.allowedTools) {
    if (!toolNames.includes(tool)) {
      issues.push({
        level: 'warning',
        rule: 'tools.unknown',
        message: `Tool "${tool}" is not registered in the tool registry`,
        field: 'allowed-tools',
      });
    }
  }

  // ── Body warnings ────────────────────────────────────────────────────────

  const body = skill.promptContent || '';

  if (body.trim().length === 0) {
    issues.push({
      level: 'warning',
      rule: 'body.empty',
      message: 'Body is empty — no behavioral instructions for the agent',
      field: 'body',
    });
  } else if (body.length < 50) {
    issues.push({
      level: 'warning',
      rule: 'body.too-short',
      message: `Body is only ${body.length} chars — instructions may be insufficient for reliable behavior`,
      field: 'body',
    });
  }

  // ── Structured sections info ─────────────────────────────────────────────

  const missingSections = RECOGNIZED_SECTIONS.filter(
    (section) => !new RegExp(`##\\s+${section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(body),
  );

  if (missingSections.length > 0) {
    const sectionList = missingSections.slice(0, 3).join(', ');
    const extra = missingSections.length > 3 ? ` +${missingSections.length - 3} more` : '';
    issues.push({
      level: 'info',
      rule: 'sections.missing',
      message: `Missing recommended sections: ${sectionList}${extra}. Consider adding these to improve LLM compliance.`,
      field: 'body',
    });
  }

  // ── Result ───────────────────────────────────────────────────────────────

  const hasErrors = issues.some((i) => i.level === 'error');
  return { ok: !hasErrors, issues };
}
