/**
 * skill_test Agent Tool — validates a skill's trigger matching against test messages.
 *
 * Registered by agent-factory when skillRegistry is available.
 */

import { z } from 'zod';
import { zodToTypeBox } from '../../tool-adapter.js';
import { testSkillMatch } from '../../../skills/skill-tester.js';
import type { AgentTool } from '../../../pi-mono/agent/types.js';
import type { SkillRegistry } from '../../../app/types.js';

export interface SkillTestToolDeps {
  skillRegistry: SkillRegistry;
  /** List of all registered tool names (for allowed-tools validation). */
  getToolNames: () => string[];
}

export function createSkillTestTool(deps: SkillTestToolDeps): AgentTool<any> {
  const schema = z.object({
    skillId: z.string().describe('The skill ID (kebab-case) to test'),
    message: z.string().describe('A test user message to verify trigger matching (e.g. "帮我看看明天的日程")'),
  });

  return {
    name: 'skill_test',
    label: 'Skill Test',
    description:
      'Test whether a skill matches a given user message. Checks trigger matching, tool availability, prompt injection preview, and lint status. Use this after creating or modifying a skill to verify it activates correctly.',
    parameters: zodToTypeBox(schema),
    execute: async (_callId: string, params: unknown) => {
      const args = params as { skillId: string; message: string };
      if (!args.skillId || typeof args.skillId !== 'string') {
        return {
          content: [{ type: 'text' as const, text: 'Missing required parameter: skillId. Provide the kebab-case skill ID to test.' }],
          details: { matched: false },
        };
      }
      if (!args.message || typeof args.message !== 'string') {
        return {
          content: [{ type: 'text' as const, text: 'Missing required parameter: message. Provide a test user message to check trigger matching.' }],
          details: { matched: false },
        };
      }

      const skill = deps.skillRegistry.getSkillById(args.skillId);
      if (!skill) {
        return {
          content: [{ type: 'text' as const, text: `Skill "${args.skillId}" not found.` }],
          details: { matched: false, skillId: args.skillId },
        };
      }

      const toolNames = deps.getToolNames();
      const result = testSkillMatch(skill, args.message, toolNames);

      return {
        content: [{ type: 'text' as const, text: result.diagnostic }],
        details: {
          matched: result.matched,
          matchType: result.matchType,
          matchedTrigger: result.matchedTrigger,
          triggersTested: result.triggersTested,
          toolCheck: result.toolCheck,
          lintOk: result.lintResult.ok,
        },
      };
    },
  };
}
