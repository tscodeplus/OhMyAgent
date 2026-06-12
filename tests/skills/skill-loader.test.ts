import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadSkill, loadAllSkills } from '../../src/skills/skill-loader.js';

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'skill-test-'));
  tempDirs.push(dir);
  return dir;
}

function buildSkillMd(frontmatter: Record<string, unknown>, body: string = '# Test\n\nHello world.'): string {
  const yamlLines = Object.entries(frontmatter).map(([k, v]) => {
    if (typeof v === 'string') return `${k}: ${v}`;
    if (Array.isArray(v)) return `${k}: [${v.join(', ')}]`;
    return `${k}: ${JSON.stringify(v)}`;
  });
  return `---\n${yamlLines.join('\n')}\n---\n\n${body}`;
}

async function createSkillDir(content: string | null): Promise<string> {
  const dir = await createTempDir();
  if (content !== null) {
    await writeFile(join(dir, 'SKILL.md'), content);
  }
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

describe('loadSkill', () => {
  it('loads a valid standard skill', async () => {
    const content = buildSkillMd({
      name: 'Test Skill',
      description: 'A test skill',
      metadata: { version: '2.0.0', priority: 10, triggers: 'test', tags: ['utility'] },
      'allowed-tools': 'shell file_read',
    }, '# Test Skill\n\nYou are a test assistant.');

    const dir = await createSkillDir(content);
    const skill = await loadSkill(dir);

    expect(skill.manifest.id).toBe('test-skill');
    expect(skill.manifest.name).toBe('Test Skill');
    expect(skill.manifest.description).toBe('A test skill');
    expect(skill.manifest.version).toBe('2.0.0');
    expect(skill.manifest.priority).toBe(10);
    expect(skill.manifest.triggers).toContain('test');
    expect(skill.manifest.tags).toEqual(['utility']);
    expect(skill.manifest.enabled).toBe(true);
    expect(skill.promptContent).toBe('# Test Skill\n\nYou are a test assistant.');
    expect(skill.tools.allowedTools).toEqual(['shell', 'file_read']);
    expect(skill.path).toBe(dir);
  });

  it('generates triggers from name when not provided', async () => {
    const content = buildSkillMd({
      name: 'Android Operator',
      description: 'Manage Android devices',
    });

    const dir = await createSkillDir(content);
    const skill = await loadSkill(dir);

    expect(skill.manifest.triggers).toContain('android operator');
    expect(skill.manifest.triggers).toContain('android');
    expect(skill.manifest.triggers).toContain('operator');
  });

  it('uses triggers from metadata when provided', async () => {
    const content = buildSkillMd({
      name: 'My Tool',
      description: 'A tool skill',
      metadata: { triggers: 'adb, android, 手机' },
    });

    const dir = await createSkillDir(content);
    const skill = await loadSkill(dir);

    expect(skill.manifest.triggers).toEqual(['adb', 'android', '手机']);
  });

  it('generates kebab-case id from name', async () => {
    const content = buildSkillMd({
      name: 'Hello World Skill',
      description: 'Greets the world',
    });

    const dir = await createSkillDir(content);
    const skill = await loadSkill(dir);

    expect(skill.manifest.id).toBe('hello-world-skill');
  });

  it('generates deterministic hash-based id for CJK names', async () => {
    const content = buildSkillMd({
      name: '日程管理',
      description: '管理日程和提醒',
    });

    const dir = await createSkillDir(content);
    const skill = await loadSkill(dir);

    // Should produce deterministic hash-based id, not 'untitled'
    expect(skill.manifest.id).toMatch(/^sk-[a-f0-9]{8}$/);
    expect(skill.manifest.id).not.toBe('untitled');

    // Same name should produce same id every time
    const dir2 = await createSkillDir(content);
    const skill2 = await loadSkill(dir2);
    expect(skill2.manifest.id).toBe(skill.manifest.id);
  });

  it('generates bigram triggers for CJK names', async () => {
    const content = buildSkillMd({
      name: '日程管理',
      description: '管理日程',
    });

    const dir = await createSkillDir(content);
    const skill = await loadSkill(dir);

    // Full name trigger
    expect(skill.manifest.triggers).toContain('日程管理');
    // Bigram triggers — partial matches for natural CJK queries
    expect(skill.manifest.triggers).toContain('日程');
    expect(skill.manifest.triggers).toContain('程管');
    expect(skill.manifest.triggers).toContain('管理');
  });

  it('preserves multi-word triggers from metadata (comma-split only)', async () => {
    const content = buildSkillMd({
      name: 'Research Tool',
      description: 'Research helper',
      metadata: { triggers: 'research, look up, find information, 研究, 调查' },
    });

    const dir = await createSkillDir(content);
    const skill = await loadSkill(dir);

    // Multi-word phrases preserved
    expect(skill.manifest.triggers).toContain('research');
    expect(skill.manifest.triggers).toContain('look up');
    expect(skill.manifest.triggers).toContain('find information');
    expect(skill.manifest.triggers).toContain('研究');
    expect(skill.manifest.triggers).toContain('调查');
    // Should NOT contain split words
    expect(skill.manifest.triggers).not.toContain('look');
    expect(skill.manifest.triggers).not.toContain('up');
    expect(skill.manifest.triggers).not.toContain('find');
  });

  it('uses default version when metadata.version is invalid', async () => {
    const content = buildSkillMd({
      name: 'Test',
      description: 'A test',
      metadata: { version: 'v1' },
    });

    const dir = await createSkillDir(content);
    const skill = await loadSkill(dir);

    expect(skill.manifest.version).toBe('1.0.0');
  });

  it('uses default priority when not provided', async () => {
    const content = buildSkillMd({
      name: 'Test',
      description: 'A test',
    });

    const dir = await createSkillDir(content);
    const skill = await loadSkill(dir);

    expect(skill.manifest.priority).toBe(0);
  });

  it('parses author from metadata', async () => {
    const content = buildSkillMd({
      name: 'Test',
      description: 'A test',
      metadata: { author: 'Alice' },
    });

    const dir = await createSkillDir(content);
    const skill = await loadSkill(dir);

    expect(skill.manifest.author).toBe('Alice');
  });

  it('sets default memory policy for standard skill', async () => {
    const content = buildSkillMd({
      name: 'Test',
      description: 'A test',
    });

    const dir = await createSkillDir(content);
    const skill = await loadSkill(dir);

    expect(skill.memoryPolicy.scopes).toHaveLength(1);
    expect(skill.memoryPolicy.scopes[0].type).toBe('session');
    expect(skill.memoryPolicy.captureEnabled).toBe(false);
    expect(skill.memoryPolicy.recallEnabled).toBe(false);
  });

  it('reads memory policy from x-ohmyagent extension', async () => {
    const content = `---
name: Test
description: A test
metadata:
  x-ohmyagent:
    memoryPolicy:
      scopes:
        - type: session
          readPolicy: always
          writePolicy: on_demand
      captureEnabled: true
      recallEnabled: true
---

# Test`;

    const dir = await createSkillDir(content);
    const skill = await loadSkill(dir);

    expect(skill.memoryPolicy.scopes).toHaveLength(1);
    expect(skill.memoryPolicy.scopes[0].writePolicy).toBe('on_demand');
    expect(skill.memoryPolicy.captureEnabled).toBe(true);
    expect(skill.memoryPolicy.recallEnabled).toBe(true);
  });

  it('reads deniedTools from x-ohmyagent extension', async () => {
    const content = `---
name: Test
description: A test
allowed-tools: shell file_read
metadata:
  x-ohmyagent:
    deniedTools: ["file_delete"]
---

# Test`;

    const dir = await createSkillDir(content);
    const skill = await loadSkill(dir);

    expect(skill.tools.allowedTools).toEqual(['shell', 'file_read']);
    expect(skill.tools.deniedTools).toEqual(['file_delete']);
  });

  it('empty allowed-tools results in empty array', async () => {
    const content = buildSkillMd({
      name: 'Test',
      description: 'A prompt-only skill',
    });

    const dir = await createSkillDir(content);
    const skill = await loadSkill(dir);

    expect(skill.tools.allowedTools).toEqual([]);
  });

  it('throws when SKILL.md is missing', async () => {
    const dir = await createSkillDir(null);
    await expect(loadSkill(dir)).rejects.toThrow(/SKILL\.md/);
  });

  it('throws when SKILL.md has no frontmatter', async () => {
    const dir = await createSkillDir('# Just markdown\n\nNo frontmatter here.');
    await expect(loadSkill(dir)).rejects.toThrow(/frontmatter/);
  });

  it('throws when frontmatter is missing required fields', async () => {
    const dir = await createSkillDir('---\nname: Test\n---\n\nBody');
    await expect(loadSkill(dir)).rejects.toThrow();
  });
});

describe('loadAllSkills', () => {
  it('loads multiple valid skills', async () => {
    const parentDir = await createTempDir();

    const skill1Dir = join(parentDir, 'alpha');
    await mkdir(skill1Dir);
    await writeFile(join(skill1Dir, 'SKILL.md'), buildSkillMd({
      name: 'Alpha',
      description: 'First skill',
    }));

    const skill2Dir = join(parentDir, 'beta');
    await mkdir(skill2Dir);
    await writeFile(join(skill2Dir, 'SKILL.md'), buildSkillMd({
      name: 'Beta',
      description: 'Second skill',
    }));

    const skills = await loadAllSkills(parentDir);
    expect(skills).toHaveLength(2);

    const ids = skills.map((s) => s.manifest.id).sort();
    expect(ids).toEqual(['alpha', 'beta']);
  });

  it('skips invalid skills without throwing', async () => {
    const parentDir = await createTempDir();

    const goodDir = join(parentDir, 'good');
    await mkdir(goodDir);
    await writeFile(join(goodDir, 'SKILL.md'), buildSkillMd({
      name: 'Good',
      description: 'Valid skill',
    }));

    const badDir = join(parentDir, 'bad');
    await mkdir(badDir);
    await writeFile(join(badDir, 'SKILL.md'), 'No frontmatter here');

    const skills = await loadAllSkills(parentDir);
    expect(skills).toHaveLength(1);
    expect(skills[0].manifest.id).toBe('good');
  });

  it('returns empty array when directory is empty', async () => {
    const parentDir = await createTempDir();
    const skills = await loadAllSkills(parentDir);
    expect(skills).toEqual([]);
  });
});

// ── L3 Resource Scanning ─────────────────────────────────────────────────────

describe('L3 Resource Scanning', () => {
  it('scans references/ directory and collects file paths', async () => {
    const dir = await createTempDir();
    const content = buildSkillMd({ name: 'Ref Skill', description: 'Has references' });

    await writeFile(join(dir, 'SKILL.md'), content);
    await mkdir(join(dir, 'references'));
    await writeFile(join(dir, 'references', 'api.md'), '# API Reference');
    await writeFile(join(dir, 'references', 'examples.md'), '# Examples');

    const skill = await loadSkill(dir);

    expect(skill.resources).toBeDefined();
    expect(skill.resources!.references).toBeDefined();
    expect(skill.resources!.references).toHaveLength(2);
    expect(skill.resources!.references).toContain('references/api.md');
    expect(skill.resources!.references).toContain('references/examples.md');
  });

  it('scans scripts/ directory and collects file paths', async () => {
    const dir = await createTempDir();
    const content = buildSkillMd({ name: 'Script Skill', description: 'Has scripts' });

    await writeFile(join(dir, 'SKILL.md'), content);
    await mkdir(join(dir, 'scripts'));
    await writeFile(join(dir, 'scripts', 'setup.sh'), '#!/bin/sh\necho hello');

    const skill = await loadSkill(dir);

    expect(skill.resources).toBeDefined();
    expect(skill.resources!.scripts).toBeDefined();
    expect(skill.resources!.scripts).toHaveLength(1);
    expect(skill.resources!.scripts![0]).toBe('scripts/setup.sh');
  });

  it('omits resources when no L3 directories exist', async () => {
    const dir = await createTempDir();
    const content = buildSkillMd({ name: 'Plain Skill', description: 'No resources' });

    await writeFile(join(dir, 'SKILL.md'), content);

    const skill = await loadSkill(dir);

    expect(skill.resources).toBeUndefined();
  });

  it('handles empty L3 directories gracefully', async () => {
    const dir = await createTempDir();
    const content = buildSkillMd({ name: 'Empty Dirs', description: 'Empty resource dirs' });

    await writeFile(join(dir, 'SKILL.md'), content);
    await mkdir(join(dir, 'references')); // empty directory
    await mkdir(join(dir, 'scripts'));    // empty directory

    const skill = await loadSkill(dir);

    // Empty dirs should not produce resources entries
    expect(skill.resources).toBeUndefined();
  });

  it('scans assets/ directory', async () => {
    const dir = await createTempDir();
    const content = buildSkillMd({ name: 'Asset Skill', description: 'Has assets' });

    await writeFile(join(dir, 'SKILL.md'), content);
    await mkdir(join(dir, 'assets'));
    await writeFile(join(dir, 'assets', 'logo.png'), 'fake-png');

    const skill = await loadSkill(dir);

    expect(skill.resources).toBeDefined();
    expect(skill.resources!.assets).toBeDefined();
    expect(skill.resources!.assets).toHaveLength(1);
    expect(skill.resources!.assets![0]).toBe('assets/logo.png');
  });

  it('filters out directories, only collects files', async () => {
    const dir = await createTempDir();
    const content = buildSkillMd({ name: 'Nested', description: 'Has nested dirs' });

    await writeFile(join(dir, 'SKILL.md'), content);
    await mkdir(join(dir, 'references'));
    await mkdir(join(dir, 'references', 'subdir')); // nested dir, not file
    await writeFile(join(dir, 'references', 'guide.md'), '# Guide');

    const skill = await loadSkill(dir);

    expect(skill.resources).toBeDefined();
    expect(skill.resources!.references).toHaveLength(1);
    expect(skill.resources!.references![0]).toBe('references/guide.md');
  });

  it('treats YAML null values (empty keys) as absent', async () => {
    const content = [
      '---',
      'name: Test',
      'description: Handles null values in YAML',
      'allowed-tools:',
      'license:',
      '---',
      '',
      '# Body',
    ].join('\n');
    const dir = await createSkillDir(content);
    const skill = await loadSkill(dir);
    expect(skill.manifest.name).toBe('Test');
    expect(skill.tools.allowedTools).toEqual([]);
  });
});
