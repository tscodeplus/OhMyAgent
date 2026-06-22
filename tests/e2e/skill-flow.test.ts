/**
 * E2E Integration Test: Skill Flow
 *
 * Tests skill triggering and context injection with real skill registry,
 * real tool registry, mocked LLM.
 *
 * Note: The skill router uses `\b` (word boundary) regex for trigger matching.
 * Chinese characters are not `\w` characters, so Chinese triggers only match
 * when surrounded by ASCII word characters or at string boundaries. English
 * triggers work reliably with `\b`. Tests use English triggers where possible.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createAgentFactory } from '../../src/agent/agent-factory.js';
import { createToolRegistry } from '../../src/tools/registry.js';
import { SkillRegistry } from '../../src/skills/skill-registry.js';
import { resolveSkillContext } from '../../src/skills/skill-router.js';
import { compileSkillContext } from '../../src/skills/skill-compiler.js';
import { loadAllSkills, type LoadedSkill } from '../../src/skills/skill-loader.js';
import {
  makeTestConfig,
  makeMockTool,
  makeMockModel,
} from './helpers.js';
import { join } from 'node:path';

vi.mock('../../src/provider/pi-ai-setup.js', () => ({
  getDefaultModel: vi.fn(() => ({
    id: 'test-model',
    name: 'Test Model',
    api: 'openai-completions',
    provider: 'test-provider',
    baseUrl: '',
    reasoning: false,
    input: [],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 4096,
    maxTokens: 2048,
  })),
}));

const SKILLS_DIR = join(import.meta.dirname, '../../skills');

function makeMockSkill(overrides: Partial<LoadedSkill['manifest']> & { id: string }, tools: string[] = ['file_read']): LoadedSkill {
  return {
    manifest: {
      id: overrides.id,
      name: overrides.name ?? overrides.id,
      description: overrides.description ?? `Mock skill: ${overrides.id}`,
      version: '1.0.0',
      triggers: overrides.triggers ?? [overrides.id],
      priority: overrides.priority ?? 0,
      enabled: true,
    },
    promptContent: `Prompt for ${overrides.id}`,
    tools: { allowedTools: tools },
    memoryPolicy: {
      scopes: [{ type: 'session', readPolicy: 'always', writePolicy: 'always' }],
    },
    path: `/mock/${overrides.id}`,
  };
}

describe('E2E: Skill Flow', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── Skill loading ───────────────────────────────────────────────────────

  it('loads researcher skill from disk', async () => {
    const skills = await loadAllSkills(SKILLS_DIR);
    expect(skills.length).toBeGreaterThanOrEqual(1);
    const ids = skills.map(s => s.manifest.id);
    expect(ids).toContain('researcher');
  });

  // ─── Skill triggering ────────────────────────────────────────────────────

  it('message with "research" -> researcher skill triggered', async () => {
    const skills = await loadAllSkills(SKILLS_DIR);
    const resolved = resolveSkillContext('research TypeScript generics', skills);

    expect(resolved.length).toBeGreaterThanOrEqual(1);
    const match = resolved.find(r => r.skill.manifest.id === 'researcher');
    expect(match).toBeDefined();
    expect(match!.matchType).toBe('trigger');
    expect(match!.matchedTrigger).toBe('research');
  });

  // ─── Explicit skill command ──────────────────────────────────────────────

  it('$researcher command -> explicit skill activation', async () => {
    const skills = await loadAllSkills(SKILLS_DIR);
    const resolved = resolveSkillContext('$researcher look up this topic', skills);

    expect(resolved.length).toBe(1);
    expect(resolved[0].skill.manifest.id).toBe('researcher');
    expect(resolved[0].matchType).toBe('explicit');
  });

  // ─── No skill triggered ──────────────────────────────────────────────────

  it('message without trigger words -> no skill triggered', async () => {
    const skills = await loadAllSkills(SKILLS_DIR);
    const resolved = resolveSkillContext('What is the weather forecast?', skills);
    expect(resolved.length).toBe(0);
  });

  // ─── Skill context applied to agent ──────────────────────────────────────

  it('researcher skill applied -> agent tools filtered and prompt enhanced', async () => {
    const config = makeTestConfig();
    const skillRegistry = new SkillRegistry();
    await skillRegistry.load(SKILLS_DIR);

    const toolRegistry = createToolRegistry();
    toolRegistry.register(makeMockTool('shell'));
    toolRegistry.register(makeMockTool('file_read'));
    toolRegistry.register(makeMockTool('file_search'));
    toolRegistry.register(makeMockTool('memory-recall'));
    toolRegistry.register(makeMockTool('web-search'));

    const factory = createAgentFactory({ config, toolRegistry, skillRegistry });

    const agent = factory.create({
      model: makeMockModel(),
      message: 'research TypeScript generics',
    });

    const toolNames = agent.state.tools.map((t: any) => t.name);
    expect(toolNames).toContain('file_read');
    expect(toolNames).toContain('file_search');
    // shell and web-search stay available — skill allowed-tools is declarative,
    // not restrictive. Tool filtering is handled by the tools profile.
    expect(toolNames).toContain('shell');
    expect(toolNames).toContain('web-search');

    expect(agent.state.systemPrompt).toContain('You are OhMyAgent');
    expect(agent.state.systemPrompt).toContain('research assistant');
  });

  // ─── Multiple skills (with mock skills) ──────────────────────────────────

  it('compile merges tools from multiple skills', () => {
    const skills: LoadedSkill[] = [
      makeMockSkill({ id: 'skill-a', priority: 10 }, ['shell', 'file_read']),
      makeMockSkill({ id: 'skill-b', priority: 5 }, ['file_search', 'memory-recall']),
    ];
    const resolved = resolveSkillContext('skill-a skill-b stuff', skills);
    expect(resolved.length).toBeGreaterThanOrEqual(2);

    const compiled = compileSkillContext(resolved);
    expect(compiled.allowedTools).toContain('shell');
    expect(compiled.allowedTools).toContain('file_read');
    expect(compiled.allowedTools).toContain('file_search');
    expect(compiled.allowedTools).toContain('memory-recall');
  });

  it('skills resolved in priority order', () => {
    const skills: LoadedSkill[] = [
      makeMockSkill({ id: 'low-prio', triggers: ['trigger'], priority: 1 }),
      makeMockSkill({ id: 'high-prio', triggers: ['trigger'], priority: 10 }),
    ];
    const resolved = resolveSkillContext('trigger word here', skills);

    expect(resolved.length).toBe(2);
    expect(resolved[0].skill.manifest.id).toBe('high-prio');
    expect(resolved[1].skill.manifest.id).toBe('low-prio');
  });

  // ─── Skill prompt content ────────────────────────────────────────────────

  it('researcher prompt content is loaded from SKILL.md', async () => {
    const skills = await loadAllSkills(SKILLS_DIR);
    const researcher = skills.find(s => s.manifest.id === 'researcher');
    expect(researcher).toBeDefined();
    expect(researcher!.promptContent.length).toBeGreaterThan(100);
  });

  // ─── Skill memory policy ─────────────────────────────────────────────────

  it('researcher memory policy is loaded correctly', async () => {
    const skills = await loadAllSkills(SKILLS_DIR);
    const researcher = skills.find(s => s.manifest.id === 'researcher');
    expect(researcher).toBeDefined();
    expect(researcher!.memoryPolicy.scopes.length).toBeGreaterThan(0);
  });

  // ─── Researcher: read-only tools ─────────────────────────────────────────

  it('researcher restricts to read-only tools (no shell)', async () => {
    const skills = await loadAllSkills(SKILLS_DIR);
    const researcher = skills.find(s => s.manifest.id === 'researcher');
    expect(researcher).toBeDefined();
    expect(researcher!.tools.allowedTools).not.toContain('shell');
    expect(researcher!.tools.allowedTools).toContain('file_read');
  });

  // ─── Agent factory without skill registry ────────────────────────────────

  it('agent factory without skill registry -> no skill filtering', () => {
    const config = makeTestConfig();
    const toolRegistry = createToolRegistry();
    toolRegistry.register(makeMockTool('shell'));
    toolRegistry.register(makeMockTool('web-search'));

    const factory = createAgentFactory({ config, toolRegistry });
    const agent = factory.create({ model: makeMockModel() });

    // No skill registry → no skill-based filtering: both registered tools stay
    // resolvable. (Tool Search may flag deferrable tools as `deferred` and add a
    // tool_search bridge, but it never removes tools from state.tools.)
    const toolNames = agent.state.tools.map((t: any) => t.name);
    expect(toolNames).toContain('shell');
    expect(toolNames).toContain('web-search');
  });

  // ─── Skill with no message ───────────────────────────────────────────────

  it('agent factory with skill registry but no message -> no skill resolution', async () => {
    const config = makeTestConfig();
    const skillRegistry = new SkillRegistry();
    await skillRegistry.load(SKILLS_DIR);

    const toolRegistry = createToolRegistry();
    toolRegistry.register(makeMockTool('shell'));
    toolRegistry.register(makeMockTool('web-search'));

    const factory = createAgentFactory({ config, toolRegistry, skillRegistry });
    const agent = factory.create({ model: makeMockModel() });

    // No message → no skill resolution → no filtering: both registered tools
    // stay resolvable (Skill tool removed in v7 — skills use file_read).
    const toolNames = agent.state.tools.map((t: any) => t.name);
    expect(toolNames).toContain('shell');
    expect(toolNames).toContain('web-search');
  });

  // ─── Chinese trigger: v7 CJK-aware matching ──────────────────────────────

  it('Chinese triggers match without word boundaries (v7 CJK-aware fix)', async () => {
    const skills = await loadAllSkills(SKILLS_DIR);
    // "研究" in "帮我研究一下" now matches — CJK triggers use substring match
    const resolved = resolveSkillContext('帮我研究一下这个问题', skills);
    const match = resolved.find(r => r.skill.manifest.id === 'researcher');
    expect(match).toBeDefined();
    expect(match!.matchType).toBe('trigger');
    expect(match!.matchedTrigger).toBe('研究');
  });
});
