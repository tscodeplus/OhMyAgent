import { describe, it, expect, beforeEach } from 'vitest';
import { SkillRegistry } from '../../src/skills/skill-registry.js';
import { join } from 'node:path';

const SKILLS_DIR = join(import.meta.dirname!, '../../skills');

describe('SkillRegistry', () => {
  let registry: SkillRegistry;

  beforeEach(async () => {
    registry = new SkillRegistry();
    await registry.load(SKILLS_DIR);
  });

  it('loads researcher skill', () => {
    const skills = registry.getSkills();
    expect(skills.length).toBeGreaterThanOrEqual(1);
    const ids = skills.map((s) => s.manifest.id);
    expect(ids).toContain('researcher');
  });

  it('isLoaded() returns true after load()', () => {
    expect(registry.isLoaded()).toBe(true);
  });

  it('getSkillById() returns correct skill', () => {
    const skill = registry.getSkillById('researcher');
    expect(skill).toBeDefined();
    expect(skill!.manifest.id).toBe('researcher');
    expect(skill!.manifest.name).toBe('Researcher');
  });

  it('getSkillById() returns undefined for unknown ID', () => {
    const skill = registry.getSkillById('nonexistent-skill');
    expect(skill).toBeUndefined();
  });

  it('resolve() matches researcher by trigger "research"', () => {
    const resolved = registry.resolve('帮我 research 一下这个话题');
    expect(resolved.length).toBeGreaterThanOrEqual(1);
    const match = resolved.find((r) => r.skill.manifest.id === 'researcher');
    expect(match).toBeDefined();
    expect(match!.matchType).toBe('trigger');
    expect(match!.matchedTrigger).toBe('research');
  });

  it('resolve() matches explicit command $researcher', () => {
    const resolved = registry.resolve('$researcher look up this topic');
    expect(resolved).toHaveLength(1);
    expect(resolved[0].skill.manifest.id).toBe('researcher');
    expect(resolved[0].matchType).toBe('explicit');
  });

  it('resolve() returns empty for unmatched message', () => {
    const resolved = registry.resolve('what is the weather today');
    expect(resolved).toHaveLength(0);
  });

  it('compile() produces correct context from resolved skills', () => {
    const resolved = registry.resolve('帮我 research 一下');
    const compiled = registry.compile(resolved);
    expect(compiled.allowedTools).toContain('file_read');
    expect(compiled.allowedTools).toContain('file_search');
    expect(compiled.promptContent).toContain('research assistant');
    expect(compiled.memoryScopes.length).toBeGreaterThan(0);
  });

  it('compile() with empty resolved returns empty context', () => {
    const compiled = registry.compile([]);
    expect(compiled.allowedTools).toHaveLength(0);
    expect(compiled.promptContent).toBe('');
  });

  it('returns empty when resolve() called before load()', () => {
    const unloaded = new SkillRegistry();
    expect(unloaded.resolve('test')).toEqual([]);
  });

  it('returns empty array when getSkills() called before load()', () => {
    const unloaded = new SkillRegistry();
    expect(unloaded.getSkills()).toEqual([]);
  });

  it('returns undefined when getSkillById() called before load()', () => {
    const unloaded = new SkillRegistry();
    expect(unloaded.getSkillById('test')).toBeUndefined();
  });
});
