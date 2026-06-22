import { describe, it, expect } from 'vitest';
import { loadAllSkills } from '../../src/skills/skill-loader.js';
import { join } from 'node:path';

const SKILLS_DIR = join(import.meta.dirname!, '../../skills');

describe('Built-in skills', () => {
  it('researcher skill loads successfully', async () => {
    const skills = await loadAllSkills(SKILLS_DIR);
    expect(skills.length).toBeGreaterThanOrEqual(1);
    const ids = skills.map((s) => s.manifest.id);
    expect(ids).toContain('researcher');
  });

  it('all skills load and have valid manifests', async () => {
    const skills = await loadAllSkills(SKILLS_DIR);
    for (const skill of skills) {
      expect(skill.manifest.id).toBeTruthy();
      expect(skill.manifest.name).toBeTruthy();
      expect(skill.manifest.description).toBeTruthy();
      expect(skill.manifest.triggers.length).toBeGreaterThan(0);
      expect(skill.manifest.enabled).toBe(true);
    }
  });

  it('researcher triggers match correctly', async () => {
    const skills = await loadAllSkills(SKILLS_DIR);
    const researcher = skills.find((s) => s.manifest.id === 'researcher')!;
    expect(researcher.manifest.triggers).toContain('research');
    expect(researcher.manifest.triggers).toContain('研究');
    expect(researcher.manifest.triggers).toContain('调查');
    expect(researcher.manifest.triggers).toContain('收集信息');
    expect(researcher.manifest.triggers).toContain('调研');
  });

  it('researcher limits to read-only tools', async () => {
    const skills = await loadAllSkills(SKILLS_DIR);
    const researcher = skills.find((s) => s.manifest.id === 'researcher')!;
    expect(researcher.tools.allowedTools).not.toContain('shell');
    expect(researcher.tools.allowedTools).toContain('file_read');
    expect(researcher.tools.allowedTools).toContain('file_search');
  });

  it('researcher has valid prompt content', async () => {
    const skills = await loadAllSkills(SKILLS_DIR);
    const researcher = skills.find((s) => s.manifest.id === 'researcher')!;
    expect(researcher.promptContent.length).toBeGreaterThan(50);
  });

  it('researcher has tools configuration', async () => {
    const skills = await loadAllSkills(SKILLS_DIR);
    const researcher = skills.find((s) => s.manifest.id === 'researcher')!;
    expect(researcher.tools.allowedTools.length).toBeGreaterThan(0);
  });

  it('researcher has memory policy', async () => {
    const skills = await loadAllSkills(SKILLS_DIR);
    const researcher = skills.find((s) => s.manifest.id === 'researcher')!;
    expect(researcher.memoryPolicy.scopes.length).toBeGreaterThan(0);
  });
});
