/**
 * skill_create Agent Tool — creates a new skill from a template.
 *
 * Registered by agent-factory when skillRegistry is available.
 */

import { z } from 'zod';
import { zodToTypeBox } from '../../tool-adapter.js';
import { createSkill, type SkillCreatorDeps } from '../../../skills/skill-creator.js';
import type { AgentTool } from '../../../pi-mono/agent/types.js';

export function createSkillCreateTool(deps: SkillCreatorDeps): AgentTool<any> {
  const schema = z.object({
    name: z.string().describe('Display name for the skill (e.g. "日程管理")'),
    description: z.string().describe('Brief description of what the skill does'),
    slug: z.string().optional().describe('Kebab-case directory name (e.g. "reading-list"). Auto-generated if omitted. Must be lowercase letters, numbers, and hyphens only.'),
    template: z.string().optional().describe('ALWAYS use "best-practice" unless the user explicitly asks for a different template. This is the recommended default with full structured sections (MUST/SHOULD/WHEN/Checklist/Examples). Other options: "minimal", "agent-role", "tool-wrapper".'),
    requirements: z.string().optional().describe('Additional capability requirements to elaborate in the skill body'),
    triggers: z.string().optional().describe('Comma-separated trigger words (defaults to skill name)'),
    allowedTools: z.string().optional().describe('Space-separated tool names the skill needs'),
    priority: z.number().optional().describe('Skill priority (default: 0)'),
  });

  return {
    name: 'skill_create',
    label: 'Create Skill',
    description:
      'Create a new skill from a template. Generates a SKILL.md with structured sections (MUST DO, SHOULD DO, WHEN, Verification Checklist), auto-validates with lint, and reloads the skill registry. Use this when the user asks to create a new skill or capability.',
    parameters: zodToTypeBox(schema),
    execute: async (_callId: string, params: unknown) => {
      const args = params as z.infer<typeof schema>;
      const result = await createSkill(
        {
          name: args.name,
          description: args.description,
          slug: args.slug,
          template: args.template,
          requirements: args.requirements,
          triggers: args.triggers,
          allowedTools: args.allowedTools,
          priority: args.priority,
        },
        deps,
      );

      if (!result.ok || result.error) {
        const errorText = result.error || `Lint validation failed with errors.`;
        return {
          content: [{ type: 'text' as const, text: `❌ Failed to create skill: ${errorText}` }],
          details: result,
        };
      }

      const lines: string[] = [
        `✅ Skill "${result.skillId}" created successfully.`,
        '',
        `Lint results:`,
      ];

      if (result.lintResult) {
        for (const issue of result.lintResult.issues) {
          const icon = issue.level === 'error' ? '❌' : issue.level === 'warning' ? '⚠️' : 'ℹ️';
          lines.push(`  ${icon} [${issue.rule}] ${issue.message}`);
        }
        if (result.lintResult.issues.length === 0) {
          lines.push('  ✅ No issues found.');
        }
      }

      lines.push('');
      lines.push(`Users can activate this skill with: $${result.skillId}`);

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
        details: result,
      };
    },
  };
}
