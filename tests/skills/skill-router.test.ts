import { describe, it, expect } from 'vitest';
import { resolveSkillContext } from '../../src/skills/skill-router.js';
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
      author: overrides.manifest?.author,
      tags: overrides.manifest?.tags,
    },
    promptContent: overrides.promptContent ?? '',
    tools: overrides.tools ?? { allowedTools: [] },
    memoryPolicy: overrides.memoryPolicy ?? {
      scopes: [{ type: 'session' as const, readPolicy: 'always' as const, writePolicy: 'always' as const }],
    },
    path: overrides.path ?? `/fake/${overrides.id}`,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('resolveSkillContext', () => {
  it('matches explicit command $skill-id', () => {
    const skills = [
      makeSkill({ id: 'android-operator', manifest: { triggers: ['adb'], priority: 1 } }),
      makeSkill({ id: 'researcher', manifest: { triggers: ['search'], priority: 2 } }),
    ];

    const results = resolveSkillContext('$android-operator adb devices', skills);

    expect(results).toHaveLength(1);
    expect(results[0].skill.manifest.id).toBe('android-operator');
    expect(results[0].matchType).toBe('explicit');
    expect(results[0].matchedTrigger).toBe('$android-operator');
  });

  it('matches trigger word in message', () => {
    const skills = [
      makeSkill({ id: 'android-operator', manifest: { triggers: ['adb'], priority: 1 } }),
      makeSkill({ id: 'researcher', manifest: { triggers: ['search'], priority: 2 } }),
    ];

    const results = resolveSkillContext('adb shell ls', skills);

    expect(results).toHaveLength(1);
    expect(results[0].skill.manifest.id).toBe('android-operator');
    expect(results[0].matchType).toBe('trigger');
    expect(results[0].matchedTrigger).toBe('adb');
  });

  it('matches case-insensitively', () => {
    const skills = [
      makeSkill({ id: 'android-operator', manifest: { triggers: ['adb'], priority: 1 } }),
    ];

    const results = resolveSkillContext('ADB shell ls', skills);

    expect(results).toHaveLength(1);
    expect(results[0].skill.manifest.id).toBe('android-operator');
    expect(results[0].matchedTrigger).toBe('adb');
  });

  it('sorts results by priority (higher first)', () => {
    const skills = [
      makeSkill({ id: 'low-priority', manifest: { triggers: ['test'], priority: 1 } }),
      makeSkill({ id: 'high-priority', manifest: { triggers: ['test'], priority: 10 } }),
      makeSkill({ id: 'mid-priority', manifest: { triggers: ['test'], priority: 5 } }),
    ];

    const results = resolveSkillContext('test something', skills);

    expect(results).toHaveLength(3);
    expect(results[0].skill.manifest.id).toBe('high-priority');
    expect(results[1].skill.manifest.id).toBe('mid-priority');
    expect(results[2].skill.manifest.id).toBe('low-priority');
  });

  it('returns empty array when no skills match', () => {
    const skills = [
      makeSkill({ id: 'android-operator', manifest: { triggers: ['adb'], priority: 1 } }),
    ];

    const results = resolveSkillContext('hello world', skills);

    expect(results).toHaveLength(0);
  });

  it('excludes disabled skills', () => {
    const skills = [
      makeSkill({ id: 'disabled-skill', manifest: { triggers: ['test'], priority: 5, enabled: false } }),
      makeSkill({ id: 'enabled-skill', manifest: { triggers: ['test'], priority: 1, enabled: true } }),
    ];

    const results = resolveSkillContext('test something', skills);

    expect(results).toHaveLength(1);
    expect(results[0].skill.manifest.id).toBe('enabled-skill');
  });

  it('returns empty array for empty skills list', () => {
    const results = resolveSkillContext('hello', []);
    expect(results).toHaveLength(0);
  });

  it('matches multiple skills on different triggers', () => {
    const skills = [
      makeSkill({ id: 'android-operator', manifest: { triggers: ['adb'], priority: 1 } }),
      makeSkill({ id: 'researcher', manifest: { triggers: ['search'], priority: 2 } }),
    ];

    const results = resolveSkillContext('search for adb devices', skills);

    expect(results).toHaveLength(2);
    // researcher has higher priority
    expect(results[0].skill.manifest.id).toBe('researcher');
    expect(results[1].skill.manifest.id).toBe('android-operator');
  });

  it('does not match trigger as substring of a word', () => {
    const skills = [
      makeSkill({ id: 'test-skill', manifest: { triggers: ['bad'], priority: 1 } }),
    ];

    // "bad" appears inside "badminton" — word boundary should prevent match
    const results = resolveSkillContext('I play badminton', skills);

    expect(results).toHaveLength(0);
  });

  it('handles explicit command with no trailing content', () => {
    const skills = [
      makeSkill({ id: 'android-operator', manifest: { triggers: ['adb'], priority: 1 } }),
    ];

    const results = resolveSkillContext('$android-operator', skills);

    expect(results).toHaveLength(1);
    expect(results[0].matchType).toBe('explicit');
  });
});
