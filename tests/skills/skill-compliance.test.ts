import { describe, it, expect } from 'vitest';
import { SkillComplianceTracker } from '../../src/skills/skill-compliance.js';
import type { LoadedSkill } from '../../src/skills/skill-loader.js';

function makeSkill(opts: {
  promptContent: string;
  allowedTools?: string[];
  deniedTools?: string[];
  surface?: 'default' | 'strict';
}): LoadedSkill {
  return {
    manifest: {
      id: 'test-skill',
      name: 'Test Skill',
      description: 'test',
      version: '1.0.0',
      triggers: [],
      priority: 1,
      enabled: true,
    },
    promptContent: opts.promptContent,
    tools: {
      allowedTools: opts.allowedTools ?? [],
      ...(opts.deniedTools ? { deniedTools: opts.deniedTools } : {}),
      ...(opts.surface ? { surface: opts.surface } : {}),
    },
    memoryPolicy: { scopes: [] },
    path: '/tmp/test-skill',
  };
}

describe('SkillComplianceTracker', () => {
  describe('Rule 1 — MUST DO tool mentions', () => {
    it('does not flag ordinary prose that merely contains "use"/"user"', () => {
      const skill = makeSkill({
        promptContent: [
          '## MUST DO',
          "- If the result isn't what the user wanted, analyze what went wrong and retry",
          '- Only use the injected variables: `doc`, `console`, `fs`',
          '',
        ].join('\n'),
      });
      const tracker = new SkillComplianceTracker();
      const result = tracker.check('test-skill', [{ name: 'image_generation', args: {} }], skill);
      expect(result.violations).toEqual([]);
    });

    it('flags a genuine snake_case tool mention that was not called', () => {
      const skill = makeSkill({
        promptContent: ['## MUST DO', '- Use `file_read` to scan all SKILL.md files', ''].join(
          '\n',
        ),
      });
      const tracker = new SkillComplianceTracker();
      const result = tracker.check('test-skill', [{ name: 'image_generation', args: {} }], skill);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]!.rule).toBe('must-tool-not-called');
      expect(result.violations[0]!.message).toContain('file_read');
    });

    it('does not flag when the required tool was called', () => {
      const skill = makeSkill({
        promptContent: ['## MUST DO', '- Use `file_read` to scan all SKILL.md files', ''].join(
          '\n',
        ),
      });
      const tracker = new SkillComplianceTracker();
      const result = tracker.check('test-skill', [{ name: 'file_read', args: {} }], skill);
      expect(result.violations).toEqual([]);
    });
  });

  describe('Rule 2 — tool constraints', () => {
    it('allows tool_search for a default-surface skill even when not in allowed-tools', () => {
      const skill = makeSkill({
        promptContent: '## MUST DO\n- Generate the image\n',
        allowedTools: ['image_generation', 'file_write', 'file_read'],
      });
      const tracker = new SkillComplianceTracker();
      const result = tracker.check('test-skill', [{ name: 'tool_search', args: {} }], skill);
      expect(result.violations).toEqual([]);
    });

    it('does not treat default-surface allowed-tools as an exclusive whitelist', () => {
      const skill = makeSkill({
        promptContent: '## MUST DO\n- Generate the image\n',
        allowedTools: ['image_generation'],
      });
      const tracker = new SkillComplianceTracker();
      const result = tracker.check('test-skill', [{ name: 'file_read', args: {} }], skill);
      expect(result.violations).toEqual([]);
    });

    it('flags non-allowed tools in strict surface mode', () => {
      const skill = makeSkill({
        promptContent: '## MUST DO\n- Generate the image\n',
        allowedTools: ['image_generation'],
        surface: 'strict',
      });
      const tracker = new SkillComplianceTracker();
      const result = tracker.check('test-skill', [{ name: 'shell', args: {} }], skill);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]!.rule).toBe('unauthorized-tool');
    });

    it('still allows forced-core bridges in strict surface mode', () => {
      const skill = makeSkill({
        promptContent: '## MUST DO\n- Generate the image\n',
        allowedTools: ['image_generation'],
        surface: 'strict',
      });
      const tracker = new SkillComplianceTracker();
      const result = tracker.check('test-skill', [{ name: 'tool_search', args: {} }], skill);
      expect(result.violations).toEqual([]);
    });

    it('flags denied tools in default surface mode', () => {
      const skill = makeSkill({
        promptContent: '## MUST DO\n- Generate the image\n',
        allowedTools: ['image_generation'],
        deniedTools: ['shell'],
      });
      const tracker = new SkillComplianceTracker();
      const result = tracker.check('test-skill', [{ name: 'shell', args: {} }], skill);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]!.rule).toBe('denied-tool');
    });
  });
});
