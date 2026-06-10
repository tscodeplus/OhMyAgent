import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Agent } from '@earendil-works/pi-agent-core';
import { createAgentFactory } from '../../src/agent/agent-factory';
import type { AppConfig } from '../../src/app/types';
import type { SkillRegistry } from '../../src/skills/skill-registry';
import type { LoadedSkill } from '../../src/skills/skill-loader';
import type { ResolvedSkill } from '../../src/skills/skill-router';
import type { CompiledSkillContext } from '../../src/skills/skill-compiler';

// Mock getDefaultModel to avoid real provider lookups
vi.mock('../../src/provider/pi-ai-setup.js', () => ({
  getDefaultModel: vi.fn(() => ({
    id: 'test-model',
    name: 'Test Model',
    api: 'openai',
    provider: 'test-provider',
    baseUrl: '',
    reasoning: false,
    input: [],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 4096,
    maxTokens: 2048,
  })),
}));

function makeMockConfig(): AppConfig {
  return {
    feishu: {
      appId: 'app-id',
      appSecret: 'app-secret',
      verificationToken: '',
      encryptKey: '',
      wsEnabled: true,
    },
    piAi: {
      provider: 'deepseek',
      model: 'deepseek-chat',
      reasoningModel: 'deepseek-reasoner',
      apiKey: 'test-key',
    },
    embedding: {
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'emb-key',
      model: 'test-emb',
      dimension: 1024,
    },
    database: { path: './data/test.db' },
    tools: {
      shellEnabled: true,
      defaultTimeoutMs: 60000,
      maxOutputLength: 12000,
      shellApprovalWhitelist: [],
      shellApprovalMode: 'balanced',
      fileRead: {
        allowedRoots: [],
        deniedPatterns: [],
        allowPathTraversal: false,
        allowHomeReference: false,
      },
    },
    memory: {
      autoRecall: false,
      autoRecallFrequency: 'first',
      autoCapture: false,
      recallTopK: 3,
      captureMaxChars: 500,
      summarizeInterval: 20,
      outputLanguage: 'Auto',
    },
    fallbackModels: [],
    rateLimit: {
      webhookMaxRequests: 100,
      webhookWindowMs: 60000,
    },
    toolSearch: { enabled: 'off' as const },
  };
}

function makeMockToolRegistry(tools: any[] = []) {
  return {
    register: vi.fn(),
    get: vi.fn(),
    list: vi.fn(() => tools),
    listAsAgentTools: vi.fn(() => tools),
    has: vi.fn(),
    unregister: vi.fn(),
    names: vi.fn(),
  };
}

function makeMockTool(name: string) {
  return {
    name,
    label: name,
    description: `Tool ${name}`,
    parameters: {},
    execute: async () => ({ content: [{ type: 'text', text: 'ok' }], details: null }),
  };
}

function makeMockSkillRegistry(overrides?: {
  resolve?: (message: string) => ResolvedSkill[];
  compile?: (resolved: ResolvedSkill[]) => CompiledSkillContext;
  skills?: LoadedSkill[];
}): SkillRegistry {
  const skills = overrides?.skills ?? [];
  return {
    load: vi.fn(),
    isLoaded: () => true,
    resolve: overrides?.resolve ?? vi.fn(() => []),
    compile: overrides?.compile ?? vi.fn(() => ({
      allowedTools: [],
      deniedTools: [],
      promptContent: '',
      promptLayers: [],
      memoryScopes: [],
      approvalOverrides: {},
    })),
    getSkills: () => skills,
    getSkillById: (id: string) => skills.find(s => s.manifest.id === id),
  } as unknown as SkillRegistry;
}

function makeResolvedSkill(overrides?: Partial<ResolvedSkill>): ResolvedSkill {
  return {
    skill: {
      manifest: {
        id: 'test-skill',
        name: 'Test Skill',
        description: 'A test skill',
        triggers: ['test'],
        priority: 0,
        enabled: true,
      },
      promptContent: '',
      tools: { allowedTools: [] },
      memoryPolicy: { scopes: [] },
      path: '/tmp/test-skill',
    },
    matchType: 'trigger',
    matchedTrigger: 'test',
    ...overrides,
  } as ResolvedSkill;
}

describe('Skill Integration in AgentFactory', () => {
  const config = makeMockConfig();

  describe('skillRegistry not provided', () => {
    it('creates agent normally without skill integration', () => {
      const registry = makeMockToolRegistry([
        makeMockTool('shell'),
        makeMockTool('web_search'),
      ]);
      const factory = createAgentFactory({ config, toolRegistry: registry });
      const agent = factory.create();
      expect(agent).toBeInstanceOf(Agent);
      expect(agent.state.tools).toHaveLength(2);
      expect(agent.state.systemPrompt).toContain('You are OhMyAgent, a helpful AI assistant.');
    });
  });

  describe('skillRegistry provided but no message', () => {
    it('does not trigger skill resolution when message is absent', () => {
      const skillRegistry = makeMockSkillRegistry();
      const registry = makeMockToolRegistry([
        makeMockTool('shell'),
        makeMockTool('web_search'),
      ]);
      const factory = createAgentFactory({
        config,
        toolRegistry: registry,
        skillRegistry,
      });
      const agent = factory.create();
      expect(skillRegistry.resolve).not.toHaveBeenCalled();
      expect(agent.state.tools).toHaveLength(2);
    });
  });

  describe('no skills resolved', () => {
    it('does not modify tools or prompt when no skills match', () => {
      const resolveMock = vi.fn(() => []);
      const compileMock = vi.fn();
      const skillRegistry = makeMockSkillRegistry({
        resolve: resolveMock,
        compile: compileMock,
      });
      const registry = makeMockToolRegistry([
        makeMockTool('shell'),
        makeMockTool('web_search'),
      ]);
      const factory = createAgentFactory({
        config,
        toolRegistry: registry,
        skillRegistry,
      });
      const agent = factory.create({ message: 'hello world' });
      expect(resolveMock).toHaveBeenCalledWith('hello world');
      expect(compileMock).not.toHaveBeenCalled();
      expect(agent.state.tools).toHaveLength(2);
      expect(agent.state.systemPrompt).toContain('You are OhMyAgent, a helpful AI assistant.');
    });
  });

  describe('skills resolved - tool filtering', () => {
    it('filters tools by allowedTools from compiled skill context', () => {
      const resolved = [makeResolvedSkill()];
      const resolveMock = vi.fn(() => resolved);
      const compileMock = vi.fn(() => ({
        allowedTools: ['shell'],
        deniedTools: [],
        promptContent: '',
        memoryScopes: [],
        approvalOverrides: {},
      }));
      const skillRegistry = makeMockSkillRegistry({
        resolve: resolveMock,
        compile: compileMock,
      });
      const registry = makeMockToolRegistry([
        makeMockTool('shell'),
        makeMockTool('web_search'),
        makeMockTool('file_ops'),
      ]);
      const factory = createAgentFactory({
        config,
        toolRegistry: registry,
        skillRegistry,
      });
      const agent = factory.create({ message: 'use adb to take a screenshot' });
      expect(resolveMock).toHaveBeenCalledWith('use adb to take a screenshot');
      expect(compileMock).toHaveBeenCalledWith(resolved);
      expect(agent.state.tools).toHaveLength(2);
      expect(agent.state.tools[0].name).toBe('shell');
      expect(agent.state.tools[1].name).toBe('web_search');
    });
  });

  describe('skills resolved - system prompt enhancement', () => {
    it('appends skill promptContent to the system prompt', () => {
      const resolved = [makeResolvedSkill()];
      const resolveMock = vi.fn(() => resolved);
      const compileMock = vi.fn(() => ({
        allowedTools: ['shell'],
        deniedTools: [],
        promptContent: 'You are an Android operator. Use adb commands.',
        memoryScopes: [],
        approvalOverrides: {},
      }));
      const skillRegistry = makeMockSkillRegistry({
        resolve: resolveMock,
        compile: compileMock,
      });
      const registry = makeMockToolRegistry([makeMockTool('shell')]);
      const factory = createAgentFactory({
        config,
        toolRegistry: registry,
        skillRegistry,
      });
      const agent = factory.create({ message: 'take a screenshot' });
      expect(agent.state.systemPrompt).toContain('You are OhMyAgent, a helpful AI assistant.');
      expect(agent.state.systemPrompt).toContain('You are an Android operator. Use adb commands.');
    });

    it('uses custom system prompt as base when provided', () => {
      const resolved = [makeResolvedSkill()];
      const resolveMock = vi.fn(() => resolved);
      const compileMock = vi.fn(() => ({
        allowedTools: ['shell'],
        deniedTools: [],
        promptContent: 'Skill prompt here.',
        memoryScopes: [],
        approvalOverrides: {},
      }));
      const skillRegistry = makeMockSkillRegistry({
        resolve: resolveMock,
        compile: compileMock,
      });
      const registry = makeMockToolRegistry([makeMockTool('shell')]);
      const factory = createAgentFactory({
        config,
        toolRegistry: registry,
        skillRegistry,
      });
      const agent = factory.create({
        message: 'hello',
        systemPrompt: 'Custom base prompt',
      });
      expect(agent.state.systemPrompt).toBe(
        'Custom base prompt\n\nSkill prompt here.',
      );
    });

    it('does not modify prompt when promptContent is empty', () => {
      const resolved = [makeResolvedSkill()];
      const resolveMock = vi.fn(() => resolved);
      const compileMock = vi.fn(() => ({
        allowedTools: ['shell'],
        deniedTools: [],
        promptContent: '',
        memoryScopes: [],
        approvalOverrides: {},
      }));
      const skillRegistry = makeMockSkillRegistry({
        resolve: resolveMock,
        compile: compileMock,
      });
      const registry = makeMockToolRegistry([makeMockTool('shell')]);
      const factory = createAgentFactory({
        config,
        toolRegistry: registry,
        skillRegistry,
      });
      const agent = factory.create({ message: 'hello' });
      expect(agent.state.systemPrompt).toContain('You are OhMyAgent, a helpful AI assistant.');
    });
  });

  describe('multiple skills resolved', () => {
    it('tools are the union of all allowedTools from multiple skills', () => {
      const skill1 = makeResolvedSkill({
        skill: {
          ...makeResolvedSkill().skill,
          tools: { allowedTools: ['shell'] },
        },
      });
      const skill2 = makeResolvedSkill({
        skill: {
          ...makeResolvedSkill().skill,
          tools: { allowedTools: ['web_search'] },
        },
      });
      const resolved = [skill1, skill2];
      const resolveMock = vi.fn(() => resolved);
      const compileMock = vi.fn(() => ({
        allowedTools: ['shell', 'web_search'],
        deniedTools: [],
        promptContent: 'Combined skill prompt.',
        memoryScopes: [],
        approvalOverrides: {},
      }));
      const skillRegistry = makeMockSkillRegistry({
        resolve: resolveMock,
        compile: compileMock,
      });
      const registry = makeMockToolRegistry([
        makeMockTool('shell'),
        makeMockTool('web_search'),
        makeMockTool('file_ops'),
      ]);
      const factory = createAgentFactory({
        config,
        toolRegistry: registry,
        skillRegistry,
      });
      const agent = factory.create({ message: 'do something complex' });
      expect(compileMock).toHaveBeenCalledWith(resolved);
      expect(agent.state.tools).toHaveLength(2);
      expect(agent.state.tools.map((t: any) => t.name)).toEqual(
        expect.arrayContaining(['shell', 'web_search']),
      );
    });

    it('promptContent from multiple skills is concatenated', () => {
      const resolved = [makeResolvedSkill(), makeResolvedSkill()];
      const resolveMock = vi.fn(() => resolved);
      const compileMock = vi.fn(() => ({
        allowedTools: ['shell'],
        deniedTools: [],
        promptContent: 'First skill.\n---\nSecond skill.',
        memoryScopes: [],
        approvalOverrides: {},
      }));
      const skillRegistry = makeMockSkillRegistry({
        resolve: resolveMock,
        compile: compileMock,
      });
      const registry = makeMockToolRegistry([makeMockTool('shell')]);
      const factory = createAgentFactory({
        config,
        toolRegistry: registry,
        skillRegistry,
      });
      const agent = factory.create({ message: 'hello' });
      expect(agent.state.systemPrompt).toContain('First skill.');
      expect(agent.state.systemPrompt).toContain('Second skill.');
    });
  });

  describe('allowedTools is empty array', () => {
    it('does not filter tools when allowedTools is empty', () => {
      const resolved = [makeResolvedSkill()];
      const resolveMock = vi.fn(() => resolved);
      const compileMock = vi.fn(() => ({
        allowedTools: [],
        deniedTools: [],
        promptContent: 'Some prompt.',
        memoryScopes: [],
        approvalOverrides: {},
      }));
      const skillRegistry = makeMockSkillRegistry({
        resolve: resolveMock,
        compile: compileMock,
      });
      const registry = makeMockToolRegistry([
        makeMockTool('shell'),
        makeMockTool('web_search'),
      ]);
      const factory = createAgentFactory({
        config,
        toolRegistry: registry,
        skillRegistry,
      });
      const agent = factory.create({ message: 'hello' });
      expect(agent.state.tools).toHaveLength(2);
    });
  });

  describe('custom tools override with skill integration', () => {
    it('skill filtering applies to custom tools when provided', () => {
      const resolved = [makeResolvedSkill()];
      const resolveMock = vi.fn(() => resolved);
      const compileMock = vi.fn(() => ({
        allowedTools: ['custom_tool'],
        deniedTools: [],
        promptContent: 'Use the custom tool.',
        memoryScopes: [],
        approvalOverrides: {},
      }));
      const skillRegistry = makeMockSkillRegistry({
        resolve: resolveMock,
        compile: compileMock,
      });
      const registry = makeMockToolRegistry([]);
      const factory = createAgentFactory({
        config,
        toolRegistry: registry,
        skillRegistry,
      });
      const agent = factory.create({
        message: 'hello',
        tools: [makeMockTool('custom_tool'), makeMockTool('other_tool')],
      });
      expect(agent.state.tools).toHaveLength(2);
      expect(agent.state.tools[0].name).toBe('custom_tool');
    });
  });
});
