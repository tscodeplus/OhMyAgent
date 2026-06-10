import { describe, it, expect } from 'vitest';
import { compileSkillContext } from '../../src/skills/skill-compiler.js';
import type { ResolvedSkill } from '../../src/skills/skill-router.js';
import type { LoadedSkill } from '../../src/skills/skill-loader.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSkill(overrides: Partial<LoadedSkill> & { id: string }): LoadedSkill {
  return {
    manifest: {
      id: overrides.id,
      name: overrides.manifest?.name ?? overrides.id,
      description: overrides.manifest?.description ?? `Description of ${overrides.id}`,
      version: '1.0.0',
      triggers: overrides.manifest?.triggers ?? [],
      priority: overrides.manifest?.priority ?? 0,
      enabled: overrides.manifest?.enabled ?? true,
    },
    promptContent: overrides.promptContent ?? '',
    tools: overrides.tools ?? { allowedTools: [] },
    memoryPolicy: overrides.memoryPolicy ?? {
      scopes: [{ type: 'session' as const, readPolicy: 'always' as const, writePolicy: 'always' as const }],
    },
    path: overrides.path ?? `/fake/${overrides.id}`,
  };
}

function makeResolved(
  skill: LoadedSkill,
  matchType: 'explicit' | 'trigger' = 'trigger'
): ResolvedSkill {
  return { skill, matchType };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('compileSkillContext', () => {
  it('returns empty context for empty input', () => {
    const result = compileSkillContext([]);

    expect(result.allowedTools).toEqual([]);
    expect(result.deniedTools).toEqual([]);
    expect(result.promptContent).toBe('');
    expect(result.memoryScopes).toEqual([]);
    expect(result.approvalOverrides).toEqual({});
  });

  it('compiles a single skill', () => {
    const skill = makeSkill({
      id: 'single',
      promptContent: 'You are a helper.',
      tools: { allowedTools: ['web_search'] },
      memoryPolicy: {
        scopes: [{ type: 'session', readPolicy: 'always', writePolicy: 'always' }],
      },
    });

    const result = compileSkillContext([makeResolved(skill)]);

    expect(result.allowedTools).toEqual(['web_search']);
    expect(result.deniedTools).toEqual([]);
    expect(result.promptContent).toBe('You are a helper.');
    expect(result.memoryScopes).toHaveLength(1);
  });

  it('unions allowedTools without duplicates', () => {
    const skill1 = makeSkill({
      id: 'skill1',
      tools: { allowedTools: ['web_search', 'file_read'] },
    });
    const skill2 = makeSkill({
      id: 'skill2',
      tools: { allowedTools: ['file_read', 'code_execute'] },
    });

    const result = compileSkillContext([
      makeResolved(skill1),
      makeResolved(skill2),
    ]);

    expect(result.allowedTools).toEqual(['web_search', 'file_read', 'code_execute']);
  });

  it('unions deniedTools', () => {
    const skill1 = makeSkill({
      id: 'skill1',
      tools: { allowedTools: ['a'], deniedTools: ['dangerous_tool'] },
    });
    const skill2 = makeSkill({
      id: 'skill2',
      tools: { allowedTools: ['b'], deniedTools: ['risky_tool', 'dangerous_tool'] },
    });

    const result = compileSkillContext([
      makeResolved(skill1),
      makeResolved(skill2),
    ]);

    expect(result.deniedTools).toEqual(['dangerous_tool', 'risky_tool']);
  });

  it('concatenates promptContent with --- separator', () => {
    const skill1 = makeSkill({
      id: 'skill1',
      promptContent: 'You are a coding assistant.',
    });
    const skill2 = makeSkill({
      id: 'skill2',
      promptContent: 'You are a researcher.',
    });

    const result = compileSkillContext([
      makeResolved(skill1),
      makeResolved(skill2),
    ]);

    expect(result.promptContent).toBe(
      'You are a coding assistant.\n---\nYou are a researcher.'
    );
  });

  it('merges memory scopes from all skills', () => {
    const skill1 = makeSkill({
      id: 'skill1',
      memoryPolicy: {
        scopes: [{ type: 'session', readPolicy: 'always', writePolicy: 'always' }],
      },
    });
    const skill2 = makeSkill({
      id: 'skill2',
      memoryPolicy: {
        scopes: [
          { type: 'user', readPolicy: 'on_demand', writePolicy: 'never' },
          { type: 'global', readPolicy: 'always', writePolicy: 'never' },
        ],
      },
    });

    const result = compileSkillContext([
      makeResolved(skill1),
      makeResolved(skill2),
    ]);

    expect(result.memoryScopes).toHaveLength(3);
    expect(result.memoryScopes[0].type).toBe('session');
    expect(result.memoryScopes[1].type).toBe('user');
    expect(result.memoryScopes[2].type).toBe('global');
  });

  it('handles skills with empty promptContent gracefully', () => {
    const skill1 = makeSkill({ id: 'skill1', promptContent: '' });
    const skill2 = makeSkill({ id: 'skill2', promptContent: 'Real prompt.' });

    const result = compileSkillContext([
      makeResolved(skill1),
      makeResolved(skill2),
    ]);

    // Empty prompt is still joined (empty string between separators is acceptable)
    expect(result.promptContent).toContain('Real prompt.');
  });

  it('handles skills without deniedTools', () => {
    const skill1 = makeSkill({
      id: 'skill1',
      tools: { allowedTools: ['a'] },
    });
    const skill2 = makeSkill({
      id: 'skill2',
      tools: { allowedTools: ['b'], deniedTools: ['c'] },
    });

    const result = compileSkillContext([
      makeResolved(skill1),
      makeResolved(skill2),
    ]);

    expect(result.deniedTools).toEqual(['c']);
  });
});
