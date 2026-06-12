/**
 * skill_lint Agent Tool — validates a skill's SKILL.md for correctness.
 *
 * Registered by agent-factory when skillRegistry is available.
 */

import { z } from 'zod';
import { zodToTypeBox } from '../../tool-adapter.js';
import { lintSkill } from '../../../skills/skill-linter.js';
import type { AgentTool } from '../../../pi-mono/agent/types.js';
import type { SkillRegistry } from '../../../app/types.js';

export interface SkillLintToolDeps {
  skillRegistry: SkillRegistry;
  /** List of all registered tool names (for allowed-tools validation). */
  getToolNames: () => string[];
}

export function createSkillLintTool(deps: SkillLintToolDeps): AgentTool<any> {
  const schema = z.object({
    skillId: z.string().describe('The skill ID (kebab-case) to validate'),
  });

  return {
    name: 'skill_lint',
    label: 'Skill Lint',
    description:
      'Validate a skill SKILL.md for correctness. Checks frontmatter fields, trigger words, tool references, body length, and structured section completeness. Returns a list of issues with severity levels (error/warning/info).',
    parameters: zodToTypeBox(schema),
    execute: async (_callId: string, params: unknown) => {
      const args = params as { skillId: string };
      if (!args.skillId || typeof args.skillId !== 'string') {
        return {
          content: [{ type: 'text' as const, text: 'Missing required parameter: skillId. Provide the kebab-case skill ID to validate.' }],
          details: { ok: false, skillId: String(args.skillId ?? 'undefined'), issues: [] },
        };
      }
      const skill = deps.skillRegistry.getSkillById(args.skillId);
      if (!skill) {
        return {
          content: [{ type: 'text' as const, text: `Skill "${args.skillId}" not found.` }],
          details: { ok: false, skillId: args.skillId, issues: [] },
        };
      }

      const toolNames = deps.getToolNames();
      const result = lintSkill(skill, toolNames);

      if (result.issues.length === 0) {
        return {
          content: [{ type: 'text' as const, text: `✅ Skill "${args.skillId}" passed all checks with no issues.` }],
          details: result,
        };
      }

      const lines: string[] = [`Skill "${args.skillId}" lint results:`];
      const errors = result.issues.filter((i) => i.level === 'error');
      const warnings = result.issues.filter((i) => i.level === 'warning');
      const infos = result.issues.filter((i) => i.level === 'info');

      if (errors.length > 0) {
        lines.push(`\n❌ Errors (${errors.length}):`);
        for (const e of errors) lines.push(`  - [${e.rule}] ${e.message}`);
      }
      if (warnings.length > 0) {
        lines.push(`\n⚠️ Warnings (${warnings.length}):`);
        for (const w of warnings) lines.push(`  - [${w.rule}] ${w.message}`);
      }
      if (infos.length > 0) {
        lines.push(`\nℹ️ Info (${infos.length}):`);
        for (const i of infos) lines.push(`  - [${i.rule}] ${i.message}`);
      }

      if (!result.ok) {
        lines.push(`\n❌ Lint failed with ${errors.length} error(s).`);
      }

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
        details: result,
      };
    },
  };
}
