import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Agent } from '@earendil-works/pi-agent-core';
import { createAgentFactory, resolveProviderApiKey } from '../../src/agent/agent-factory';
import type { AppConfig } from '../../src/app/types';

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

describe('AgentFactory', () => {
  const config = makeMockConfig();

  it('createAgentFactory returns a factory object', () => {
    const registry = makeMockToolRegistry();
    const factory = createAgentFactory({ config, toolRegistry: registry });
    expect(factory).toBeDefined();
    expect(typeof factory.create).toBe('function');
  });

  it('factory.create() returns an Agent instance', () => {
    const registry = makeMockToolRegistry();
    const factory = createAgentFactory({ config, toolRegistry: registry });
    const agent = factory.create();
    expect(agent).toBeInstanceOf(Agent);
  });

  it('agent has the default model set', () => {
    const registry = makeMockToolRegistry();
    const factory = createAgentFactory({ config, toolRegistry: registry });
    const agent = factory.create();
    expect(agent.state.model.id).toBe('test-model');
  });

  it('agent has the correct tools from registry', () => {
    const tools = [makeMockTool('shell'), makeMockTool('web_search')];
    const registry = makeMockToolRegistry(tools);
    const factory = createAgentFactory({ config, toolRegistry: registry });
    const agent = factory.create();
    expect(agent.state.tools).toHaveLength(2);
    expect(agent.state.tools.map((t: any) => t.name)).toEqual(
      expect.arrayContaining(['shell', 'web_search']),
    );
  });

  it('agent has the default system prompt', () => {
    const registry = makeMockToolRegistry();
    const factory = createAgentFactory({ config, toolRegistry: registry });
    const agent = factory.create();
    expect(agent.state.systemPrompt).toContain('You are OhMyAgent, a helpful AI assistant.');
    expect(agent.state.systemPrompt).toContain('## Memory');
    expect(agent.state.systemPrompt).toContain('memory-store');
  });

  it('create() accepts a custom system prompt', () => {
    const registry = makeMockToolRegistry();
    const factory = createAgentFactory({ config, toolRegistry: registry });
    const agent = factory.create({ systemPrompt: 'Custom prompt' });
    expect(agent.state.systemPrompt).toBe('Custom prompt');
  });

  it('create() accepts custom tools', () => {
    const registry = makeMockToolRegistry([makeMockTool('default')]);
    const factory = createAgentFactory({ config, toolRegistry: registry });
    const customTools = [makeMockTool('custom_tool')];
    const agent = factory.create({ tools: customTools });
    expect(agent.state.tools).toHaveLength(1);
    expect(agent.state.tools[0].name).toBe('custom_tool');
    // Should not use registry tools when custom tools are provided
    expect(registry.listAsAgentTools).not.toHaveBeenCalled();
  });

  it('create() accepts a session ID', () => {
    const registry = makeMockToolRegistry();
    const factory = createAgentFactory({ config, toolRegistry: registry });
    const agent = factory.create({ sessionId: 'session-123' });
    expect(agent.sessionId).toBe('session-123');
  });

  it('rebinds v4 registry tools to the current runtime policy context', async () => {
    let capturedPolicyInput: any;
    const v4Definition = {
      name: 'task_get',
      label: 'Task Get',
      description: 'test v4 definition',
      category: 'task',
      parametersSchema: {},
      capability: {
        category: 'task',
        readOnly: true,
        readsFiles: false,
        writesFiles: false,
        usesShell: false,
        usesNetwork: false,
        usesComputerUse: false,
        pathAccess: 'none',
        approvalDefault: 'none',
      },
      execute: async (_args: any, ctx: any) => ({
        content: [
          {
            type: 'text',
            text: `session=${ctx.sessionId};agent=${ctx.agentId};profile=${ctx.policyScope.toolsProfile}`,
          },
        ],
      }),
    };
    const toolPlatformRegistry = {
      getDefinition: vi.fn((name: string) => (name === 'task_get' ? v4Definition : undefined)),
    };
    const policyCenter = {
      evaluateToolCall: vi.fn(async (input: any) => {
        capturedPolicyInput = input;
        return { allowed: true, requiresApproval: false };
      }),
    };
    const registry = makeMockToolRegistry([makeMockTool('task_get')]);
    const factory = createAgentFactory(
      { config, toolRegistry: registry },
      {
        policyCenter: policyCenter as any,
        getServices: () => ({ toolPlatformRegistry }) as any,
        defaultToolsProfile: 'standard',
      },
    );

    const agent = factory.create({
      sessionId: 'feishu:chat-1',
      agentId: 'agent-1',
      channel: 'feishu',
    });
    const tool = agent.state.tools.find((t: any) => t.name === 'task_get')!;
    const result = await tool.execute('call-1', {});

    expect(result.content[0].text).toBe('session=feishu:chat-1;agent=agent-1;profile=standard');
    expect(capturedPolicyInput).toMatchObject({
      toolName: 'task_get',
      sessionId: 'feishu:chat-1',
      agentId: 'agent-1',
      channel: 'feishu',
    });
  });

  it('create() accepts a custom model', () => {
    const registry = makeMockToolRegistry();
    const factory = createAgentFactory({ config, toolRegistry: registry });
    const customModel = {
      id: 'custom-model',
      name: 'Custom',
      api: 'openai',
      provider: 'custom',
      baseUrl: '',
      reasoning: false,
      input: [],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 4096,
    };
    const agent = factory.create({ model: customModel });
    expect(agent.state.model.id).toBe('custom-model');
  });

  it('wraps computer_use with session, agent, model, and access mode context', async () => {
    const computerUseHost = {
      createLease: vi.fn().mockResolvedValue({
        leaseId: 'lease-1',
        appId: 'firefox',
        status: 'active',
      }),
    };
    const registry = makeMockToolRegistry([makeMockTool('computer_use')]);
    const fullConfig = {
      ...config,
      tools: { ...config.tools, toolsProfile: 'full' as const },
    };
    const model = {
      id: 'vision-model',
      name: 'Vision',
      api: 'openai',
      provider: 'test',
      baseUrl: '',
      reasoning: false,
      input: ['text', 'image'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 4096,
    };
    const factory = createAgentFactory({
      config: fullConfig,
      toolRegistry: registry,
      computerUseHost: computerUseHost as any,
    });

    const agent = factory.create({
      sessionId: 'session-123',
      agentId: 'agent-1',
      model,
    });
    const tool = agent.state.tools.find((t: any) => t.name === 'computer_use')!;

    await tool.execute('call-1', { action: 'open_app', target: 'firefox' });

    expect(computerUseHost.createLease).toHaveBeenCalledWith(
      {
        sessionPath: 'session-123',
        agentId: 'agent-1',
        accessMode: 'operate',
        model: {
          provider: 'test',
          id: 'vision-model',
          input: ['text', 'image'],
        },
      },
      { appName: 'firefox' },
    );
  });

  it('wires computer_use send_screenshot to Feishu image delivery when chat context exists', async () => {
    const computerUseHost = {
      createLease: vi.fn().mockResolvedValue({
        leaseId: 'lease-1',
        appId: 'desktop',
        status: 'active',
      }),
      getAppState: vi.fn().mockResolvedValue({
        mode: 'vision-native',
        screenshot: {
          type: 'image',
          mimeType: 'image/png',
          data: Buffer.from('png').toString('base64'),
        },
        display: { width: 1920, height: 1080 },
        elements: [],
        leaseId: 'lease-1',
        providerId: 'windows:local',
        allowedActions: [],
        snapshotId: 'snap-1',
      }),
    };
    const feishuClient = {
      sendApprovalCard: vi.fn(),
      uploadImage: vi.fn().mockResolvedValue({ imageKey: 'img_1' }),
      sendMessage: vi.fn().mockResolvedValue({}),
    };
    const registry = makeMockToolRegistry([makeMockTool('computer_use')]);
    const fullConfig = {
      ...config,
      tools: { ...config.tools, toolsProfile: 'full' as const },
    };
    const factory = createAgentFactory(
      {
        config: fullConfig,
        toolRegistry: registry,
        computerUseHost: computerUseHost as any,
      },
      { feishuClient: feishuClient as any },
    );

    const agent = factory.create({
      sessionId: 'session-123',
      agentId: 'agent-1',
      chatId: 'chat-1',
      channel: 'feishu',
    });
    const tool = agent.state.tools.find((t: any) => t.name === 'computer_use')!;

    const result = await tool.execute('call-1', { action: 'send_screenshot' });

    expect(feishuClient.uploadImage).toHaveBeenCalledWith(Buffer.from('png'), 'message');
    expect(feishuClient.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        receive_id: 'chat-1',
        receive_id_type: 'chat_id',
        msg_type: 'image',
        content: JSON.stringify({ image_key: 'img_1' }),
      }),
    );
    expect(result.details).toMatchObject({ sent: true, snapshotId: 'snap-1' });
  });

  it('uses the channel Computer Use image sender for QQ screenshots', async () => {
    const computerUseHost = {
      getAppState: vi.fn().mockResolvedValue({
        mode: 'vision-native',
        screenshot: {
          type: 'image',
          mimeType: 'image/png',
          data: Buffer.from('png').toString('base64'),
        },
        display: { width: 1920, height: 1080 },
        elements: [],
        leaseId: 'lease-1',
        providerId: 'windows:local',
        allowedActions: [],
        snapshotId: 'snap-1',
      }),
    };
    const feishuClient = {
      sendApprovalCard: vi.fn(),
      uploadImage: vi.fn().mockResolvedValue({ imageKey: 'img_1' }),
      sendMessage: vi.fn().mockResolvedValue({}),
    };
    const registry = makeMockToolRegistry([makeMockTool('computer_use')]);
    const fullConfig = {
      ...config,
      tools: { ...config.tools, toolsProfile: 'full' as const },
    };
    const factory = createAgentFactory(
      {
        config: fullConfig,
        toolRegistry: registry,
        computerUseHost: computerUseHost as any,
      },
      { feishuClient: feishuClient as any },
    );

    const agent = factory.create({
      sessionId: 'session-123',
      agentId: 'agent-1',
      chatId: 'qq-chat-1',
      channel: 'qq',
      computerUseImageSender: vi.fn(async () => 'sent to QQ'),
    });
    const tool = agent.state.tools.find((t: any) => t.name === 'computer_use')!;

    const result = await tool.execute('call-1', { action: 'send_screenshot' });

    expect(feishuClient.uploadImage).not.toHaveBeenCalled();
    expect(result.content).toContainEqual({
      type: 'text',
      text: expect.stringContaining('Screenshot sent. sent to QQ'),
    });
  });

  it('each create() call returns a fresh Agent instance', () => {
    const registry = makeMockToolRegistry();
    const factory = createAgentFactory({ config, toolRegistry: registry });
    const agent1 = factory.create();
    const agent2 = factory.create();
    expect(agent1).not.toBe(agent2);
  });

  it('create() with empty tool registry returns agent with no tools', () => {
    const registry = makeMockToolRegistry([]);
    registry.listAsAgentTools = vi.fn(() => []);
    const factory = createAgentFactory({ config, toolRegistry: registry });
    const agent = factory.create();
    expect(agent.state.tools).toBeDefined();
    // Should have at least default system prompt tools mentioned in it
    expect(agent.state.systemPrompt).toContain('You are OhMyAgent');
  });

  it('create() with no sessionId does not crash', () => {
    const registry = makeMockToolRegistry();
    const factory = createAgentFactory({ config, toolRegistry: registry });
    const agent = factory.create({});
    expect(agent.sessionId).toBeUndefined();
  });

  it('create() with no channel does not crash', () => {
    const registry = makeMockToolRegistry();
    const factory = createAgentFactory({ config, toolRegistry: registry });
    const agent = factory.create({ sessionId: 'test-session' });
    expect(agent).toBeInstanceOf(Agent);
  });
});

describe('resolveProviderApiKey', () => {
  it('returns the custom provider key', () => {
    const config = makeMockConfig();
    config.customProviders = [
      {
        provider: 'agnes',
        apiKey: 'agnes-key',
        baseUrl: 'https://apihub.agnes-ai.com/v1',
        models: [],
      },
    ];
    expect(resolveProviderApiKey(config, 'agnes')).toBe('agnes-key');
  });

  it('returns the provider_keys entry for built-in providers', () => {
    const config = makeMockConfig();
    config.providerKeys = { nvidia: { apiKey: 'nvidia-key', baseUrl: '' } };
    expect(resolveProviderApiKey(config, 'nvidia')).toBe('nvidia-key');
  });

  it('falls back to piAi.apiKey for the primary provider only', () => {
    const config = makeMockConfig(); // piAi.provider = 'deepseek', apiKey = 'test-key'
    expect(resolveProviderApiKey(config, 'deepseek')).toBe('test-key');
    expect(resolveProviderApiKey(config, 'some-other-provider')).toBeUndefined();
  });

  it('prefers custom provider keys over provider_keys and piAi.apiKey', () => {
    const config = makeMockConfig();
    config.customProviders = [
      {
        provider: 'deepseek',
        apiKey: 'custom-key',
        baseUrl: 'https://custom.example.com/v1',
        models: [],
      },
    ];
    config.providerKeys = { deepseek: { apiKey: 'pk-key', baseUrl: '' } };
    expect(resolveProviderApiKey(config, 'deepseek')).toBe('custom-key');
  });
});

// ─── updateConfig ──────────────────────────────────────────────────────────────

describe('AgentFactory updateConfig', () => {
  const config = makeMockConfig();

  it('updateConfig applies new config without errors', () => {
    const registry = makeMockToolRegistry();
    const factory = createAgentFactory({ config, toolRegistry: registry });
    const newConfig = {
      ...config,
      piAi: { ...config.piAi, model: 'new-model' },
    };
    expect(() => factory.updateConfig(newConfig)).not.toThrow();
  });

  it('subsequent create() picks up updated config properties', () => {
    const registry = makeMockToolRegistry();
    const factory = createAgentFactory({ config, toolRegistry: registry });
    const newConfig = {
      ...config,
      tools: {
        ...config.tools,
        shellEnabled: false,
        shellApprovalTimeoutSec: 30,
        shellApprovalTimeoutAction: 'allow' as const,
      },
    };
    factory.updateConfig(newConfig);
    // Should not throw on subsequent create
    const agent = factory.create();
    expect(agent).toBeInstanceOf(Agent);
  });

  it('updateConfig is idempotent when called multiple times', () => {
    const registry = makeMockToolRegistry();
    const factory = createAgentFactory({ config, toolRegistry: registry });
    const newConfig = { ...config, piAi: { ...config.piAi, apiKey: 'updated-key' } };
    factory.updateConfig(newConfig);
    factory.updateConfig(newConfig);
    factory.updateConfig(config); // revert
    expect(() => factory.create()).not.toThrow();
  });
});

// ─── Approval resolution methods ───────────────────────────────────────────────

describe('AgentFactory approval resolution', () => {
  const config = makeMockConfig();

  it('resolveApproval returns false when no pending approvals', () => {
    const registry = makeMockToolRegistry();
    const factory = createAgentFactory({ config, toolRegistry: registry });
    const result = factory.resolveApproval('nonexistent-request', 'approve_once');
    expect(result).toBe(false);
  });

  it('resolveFirstPendingApproval returns false when no session has pending approvals', () => {
    const registry = makeMockToolRegistry();
    const factory = createAgentFactory({ config, toolRegistry: registry });
    const result = factory.resolveFirstPendingApproval('session-nonexistent', 'approve_once');
    expect(result).toBe(false);
  });

  it('resolveAllPendingApprovals returns 0 when no pending approvals', () => {
    const registry = makeMockToolRegistry();
    const factory = createAgentFactory({ config, toolRegistry: registry });
    const count = factory.resolveAllPendingApprovals('session-nonexistent', 'approve_once');
    expect(count).toBe(0);
  });

  it('rejectPendingApprovals returns 0 when no pending approvals', () => {
    const registry = makeMockToolRegistry();
    const factory = createAgentFactory({ config, toolRegistry: registry });
    const count = factory.rejectPendingApprovals('session-nonexistent');
    expect(count).toBe(0);
  });

  it('rejectPendingApprovals handles all reason types', () => {
    const registry = makeMockToolRegistry();
    const factory = createAgentFactory({ config, toolRegistry: registry });
    expect(factory.rejectPendingApprovals('session-1', 'stopped_by_user')).toBe(0);
    expect(factory.rejectPendingApprovals('session-1', 'steered')).toBe(0);
  });
});

// ─── User question methods ─────────────────────────────────────────────────────

describe('AgentFactory user question resolution', () => {
  const config = makeMockConfig();

  it('resolveUserQuestion returns false when no user question store configured', () => {
    const registry = makeMockToolRegistry();
    const factory = createAgentFactory({ config, toolRegistry: registry });
    const result = factory.resolveUserQuestion('req-1', 'answer');
    expect(result).toBe(false);
  });

  it('resolveFirstPendingQuestion returns false when no store', () => {
    const registry = makeMockToolRegistry();
    const factory = createAgentFactory({ config, toolRegistry: registry });
    const result = factory.resolveFirstPendingQuestion('session-1', 'answer');
    expect(result).toBe(false);
  });

  it('rejectPendingQuestions returns 0 when no store', () => {
    const registry = makeMockToolRegistry();
    const factory = createAgentFactory({ config, toolRegistry: registry });
    const count = factory.rejectPendingQuestions('session-1');
    expect(count).toBe(0);
  });

  it('resolveUserQuestion uses the store when configured', () => {
    const userQuestionStore = {
      resolve: vi.fn((_id: string, _answer: string) => true),
      findPendingForSession: vi.fn((_sessionKey: string) => 'req-1'),
      rejectAllForSession: vi.fn((_sessionKey: string, _reason: string) => 2),
    };
    const registry = makeMockToolRegistry();
    const factory = createAgentFactory(
      { config, toolRegistry: registry },
      { userQuestionStore: userQuestionStore as any },
    );

    const result = factory.resolveUserQuestion('req-1', 'My answer');
    expect(result).toBe(true);
    expect(userQuestionStore.resolve).toHaveBeenCalledWith('req-1', 'My answer');
  });

  it('resolveFirstPendingQuestion delegates to store', () => {
    const userQuestionStore = {
      resolve: vi.fn((_id: string, _answer: string) => true),
      findPendingForSession: vi.fn((_sessionKey: string) => 'req-1'),
      rejectAllForSession: vi.fn((_sessionKey: string, _reason: string) => 2),
    };
    const registry = makeMockToolRegistry();
    const factory = createAgentFactory(
      { config, toolRegistry: registry },
      { userQuestionStore: userQuestionStore as any },
    );

    const result = factory.resolveFirstPendingQuestion('session-1', 'Answer');
    expect(result).toBe(true);
    expect(userQuestionStore.findPendingForSession).toHaveBeenCalledWith('session-1');
    expect(userQuestionStore.resolve).toHaveBeenCalledWith('req-1', 'Answer');
  });

  it('resolveFirstPendingQuestion returns false when no pending question', () => {
    const userQuestionStore = {
      resolve: vi.fn(),
      findPendingForSession: vi.fn(() => null),
      rejectAllForSession: vi.fn(),
    };
    const registry = makeMockToolRegistry();
    const factory = createAgentFactory(
      { config, toolRegistry: registry },
      { userQuestionStore: userQuestionStore as any },
    );

    const result = factory.resolveFirstPendingQuestion('session-1', 'Answer');
    expect(result).toBe(false);
  });

  it('rejectPendingQuestions delegates to store', () => {
    const userQuestionStore = {
      resolve: vi.fn(),
      findPendingForSession: vi.fn(),
      rejectAllForSession: vi.fn((_key: string, _reason: string) => 3),
    };
    const registry = makeMockToolRegistry();
    const factory = createAgentFactory(
      { config, toolRegistry: registry },
      { userQuestionStore: userQuestionStore as any },
    );

    const count = factory.rejectPendingQuestions('session-1');
    expect(count).toBe(3);
    expect(userQuestionStore.rejectAllForSession).toHaveBeenCalledWith(
      'session-1',
      'User sent a new message',
    );
  });
});

// ─── getAutoCompressConfig ─────────────────────────────────────────────────────

describe('AgentFactory getAutoCompressConfig', () => {
  it('returns undefined when autoCompress is disabled', () => {
    const config = makeMockConfig();
    const registry = makeMockToolRegistry();
    const factory = createAgentFactory({ config, toolRegistry: registry });
    const result = factory.getAutoCompressConfig();
    expect(result).toBeUndefined();
  });

  it('returns config when autoCompress is enabled', () => {
    const config = {
      ...makeMockConfig(),
      memory: {
        ...makeMockConfig().memory,
        autoCompress: {
          enabled: true,
          maxTokensRatio: 0.7,
          minCompressionRatio: 0.3,
          model: { primary: 'gpt-4', fallback_models: ['gpt-3.5-turbo'] },
        },
      },
      fallbackModels: ['claude-3-haiku'],
    };
    const registry = makeMockToolRegistry();
    const factory = createAgentFactory({ config, toolRegistry: registry });
    const result = factory.getAutoCompressConfig();
    expect(result).toBeDefined();
    expect(result!.compressModelRef).toBe('gpt-4');
    expect(result!.compressFallbackRefs).toEqual(['gpt-3.5-turbo']);
    expect(result!.contextWindow).toBeGreaterThan(0);
  });

  it('returns compress config with providerKeys and customProviders merged', () => {
    const config = {
      ...makeMockConfig(),
      providerKeys: {
        openai: { apiKey: 'sk-openai', baseUrl: 'https://openai.example.com' },
      },
      customProviders: [
        { provider: 'custom-vendor', apiKey: 'ck-custom', baseUrl: 'https://custom.example.com' },
      ],
      memory: {
        ...makeMockConfig().memory,
        autoCompress: {
          enabled: true,
          maxTokensRatio: 0.7,
          minCompressionRatio: 0.3,
        },
      },
    };
    const registry = makeMockToolRegistry();
    const factory = createAgentFactory({ config, toolRegistry: registry });
    const result = factory.getAutoCompressConfig();
    expect(result).toBeDefined();
    expect(result!.apiKeys.openai).toBe('sk-openai');
    expect(result!.apiKeys['custom-vendor']).toBe('ck-custom');
    expect(result!.baseUrls.openai).toBe('https://openai.example.com');
    expect(result!.baseUrls['custom-vendor']).toBe('https://custom.example.com');
  });

  it('returns undefined when autoCompress model is undefined but enabled', () => {
    const config = {
      ...makeMockConfig(),
      memory: {
        ...makeMockConfig().memory,
        autoCompress: { enabled: true, maxTokensRatio: 0.7, minCompressionRatio: 0.3 },
      },
    };
    const registry = makeMockToolRegistry();
    const factory = createAgentFactory({ config, toolRegistry: registry });
    const result = factory.getAutoCompressConfig();
    expect(result).toBeDefined();
    expect(result!.compressModelRef).toBeUndefined();
    expect(result!.compressFallbackRefs).toBeUndefined();
  });
});

// ─── Error handling & boundary conditions ──────────────────────────────────

describe('AgentFactory error handling', () => {
  const config = makeMockConfig();

  it('handles undefined options gracefully', () => {
    const registry = makeMockToolRegistry();
    const factory = createAgentFactory({ config, toolRegistry: registry });
    const agent = factory.create(undefined as any);
    expect(agent).toBeInstanceOf(Agent);
  });

  it('handles null options gracefully', () => {
    const registry = makeMockToolRegistry();
    const factory = createAgentFactory({ config, toolRegistry: registry });
    const agent = factory.create(null as any);
    expect(agent).toBeInstanceOf(Agent);
  });

  it('handles empty string sessionId', () => {
    const registry = makeMockToolRegistry();
    const factory = createAgentFactory({ config, toolRegistry: registry });
    const agent = factory.create({ sessionId: '' });
    expect(agent).toBeInstanceOf(Agent);
  });

  it('handles empty string agentId', () => {
    const registry = makeMockToolRegistry();
    const factory = createAgentFactory({ config, toolRegistry: registry });
    const agent = factory.create({ agentId: '' });
    expect(agent).toBeInstanceOf(Agent);
  });

  it('handles empty string message for skill activation', () => {
    const registry = makeMockToolRegistry();
    const factory = createAgentFactory({ config, toolRegistry: registry });
    const agent = factory.create({ message: '', sessionId: 's1' });
    expect(agent).toBeInstanceOf(Agent);
  });

  it('create() is safe across many sequential calls', () => {
    const registry = makeMockToolRegistry();
    const factory = createAgentFactory({ config, toolRegistry: registry });
    for (let i = 0; i < 10; i++) {
      const agent = factory.create();
      expect(agent).toBeInstanceOf(Agent);
    }
  });

  it('handles config with undefined optional fields', () => {
    const partialConfig = {
      ...makeMockConfig(),
      providerKeys: undefined,
      customProviders: undefined,
      uiLanguage: undefined,
    } as unknown as AppConfig;
    const registry = makeMockToolRegistry();
    const factory = createAgentFactory({ config: partialConfig, toolRegistry: registry });
    const agent = factory.create({ sessionId: 's1' });
    expect(agent).toBeInstanceOf(Agent);
  });

  it('handles config with empty providerKeys and customProviders', () => {
    const config = {
      ...makeMockConfig(),
      providerKeys: {},
      customProviders: [],
    };
    const registry = makeMockToolRegistry();
    const factory = createAgentFactory({ config, toolRegistry: registry });
    expect(() => factory.create({ sessionId: 's1' })).not.toThrow();
  });

  it('rejectPendingApprovals does not throw without approvalRequestRepo', () => {
    const registry = makeMockToolRegistry();
    const factory = createAgentFactory({ config, toolRegistry: registry });
    expect(() => factory.rejectPendingApprovals('session-1', 'stopped_by_user')).not.toThrow();
    expect(() => factory.rejectPendingApprovals('session-1', 'steered')).not.toThrow();
  });
});

// ─── Config injection ──────────────────────────────────────────────────────

describe('AgentFactory config injection', () => {
  it('wires personaStore without errors', () => {
    const personaStore = { toContextString: vi.fn(() => 'test persona') };
    const registry = makeMockToolRegistry();
    const factory = createAgentFactory({
      config: makeMockConfig(),
      toolRegistry: registry,
      personaStore: personaStore as any,
    });
    const agent = factory.create({ sessionId: 'session-1' });
    expect(agent).toBeInstanceOf(Agent);
  });

  it('wires memoryRetriever without errors', () => {
    const memoryRetriever = { retrieve: vi.fn() };
    const registry = makeMockToolRegistry();
    const factory = createAgentFactory({
      config: makeMockConfig(),
      toolRegistry: registry,
      memoryRetriever,
    });
    const agent = factory.create({ sessionId: 'session-1' });
    expect(agent).toBeInstanceOf(Agent);
  });

  it('sets ohmyagent_agentName from agentConfig.name', () => {
    const agentManager = {
      get: vi.fn(() => ({
        id: 'agent-custom',
        name: 'CustomAgentName',
        system_prompt: 'Custom prompt',
        model: { primary: '', fallback: [], reasoning_level: '', transport: '', max_retry: 0 },
        tools: { profile: 'minimal' as const },
      })),
      getDefault: vi.fn(() => undefined),
      resolveTools: vi.fn(() => []),
    };
    const registry = makeMockToolRegistry();
    const factory = createAgentFactory({
      config: makeMockConfig(),
      toolRegistry: registry,
      agentManager: agentManager as any,
    });
    const agent = factory.create({ agentId: 'agent-custom', sessionId: 's1' });
    expect((agent as any).ohmyagent_agentName).toBe('CustomAgentName');
  });

  it('does not set ohmyagent_agentName when agentManager is absent', () => {
    const registry = makeMockToolRegistry();
    const factory = createAgentFactory({
      config: makeMockConfig(),
      toolRegistry: registry,
    });
    const agent = factory.create({ agentId: 'some-id', sessionId: 's1' });
    expect((agent as any).ohmyagent_agentName).toBeUndefined();
  });

  it('uses agentConfig system_prompt when agentManager provides it', () => {
    const agentManager = {
      get: vi.fn(() => ({
        id: 'agent-prompt',
        name: 'PromptAgent',
        system_prompt: 'You are a specialized agent for testing',
        model: { primary: '', fallback: [], reasoning_level: '', transport: '', max_retry: 0 },
        tools: { profile: 'standard' as const },
      })),
      getDefault: vi.fn(() => undefined),
      resolveTools: vi.fn(() => []),
    };
    const registry = makeMockToolRegistry();
    const factory = createAgentFactory({
      config: makeMockConfig(),
      toolRegistry: registry,
      agentManager: agentManager as any,
    });
    const agent = factory.create({ agentId: 'agent-prompt', sessionId: 's1' });
    expect(agent.state.systemPrompt).toBe('You are a specialized agent for testing');
  });

  it('falls back to default system prompt when agentConfig lacks system_prompt', () => {
    const agentManager = {
      get: vi.fn(() => ({
        id: 'agent-noprompt',
        name: 'NoPrompt',
        model: { primary: '', fallback: [], reasoning_level: '', transport: '', max_retry: 0 },
        tools: { profile: 'standard' as const },
      })),
      getDefault: vi.fn(() => undefined),
      resolveTools: vi.fn(() => []),
    };
    const registry = makeMockToolRegistry();
    const factory = createAgentFactory({
      config: makeMockConfig(),
      toolRegistry: registry,
      agentManager: agentManager as any,
    });
    const agent = factory.create({ agentId: 'agent-noprompt', sessionId: 's1' });
    // No legacy default fallback: blank prompt means "no agent override
    // layer", so the system prompt comes from the PromptManager base layer
    // (which already contains the identity + Task Execution + Memory sections).
    expect(agent.state.systemPrompt).toBe('');
  });

  it('falls back to getDefault when agentId is not found in agentManager', () => {
    const defaultCfg = {
      id: 'default-agent',
      name: 'DefaultAgent',
      system_prompt: 'Default agent prompt',
      model: { primary: '', fallback: [], reasoning_level: '', transport: '', max_retry: 0 },
      tools: { profile: 'standard' as const },
    };
    const agentManager = {
      get: vi.fn(() => undefined),
      getDefault: vi.fn(() => defaultCfg),
      resolveTools: vi.fn(() => []),
    };
    const registry = makeMockToolRegistry();
    const factory = createAgentFactory({
      config: makeMockConfig(),
      toolRegistry: registry,
      agentManager: agentManager as any,
    });
    const agent = factory.create({ agentId: 'unknown-id', sessionId: 's1' });
    expect(agent).toBeInstanceOf(Agent);
    expect(agentManager.getDefault).toHaveBeenCalled();
  });

  it('prefers explicit options.systemPrompt over agentConfig and default', () => {
    const agentManager = {
      get: vi.fn(() => ({
        id: 'agent-sysprompt',
        name: 'SysPromptAgent',
        system_prompt: 'Config level prompt',
        model: { primary: '', fallback: [], reasoning_level: '', transport: '', max_retry: 0 },
        tools: { profile: 'standard' as const },
      })),
      getDefault: vi.fn(() => undefined),
      resolveTools: vi.fn(() => []),
    };
    const registry = makeMockToolRegistry();
    const factory = createAgentFactory({
      config: makeMockConfig(),
      toolRegistry: registry,
      agentManager: agentManager as any,
    });
    const agent = factory.create({
      agentId: 'agent-sysprompt',
      sessionId: 's1',
      systemPrompt: 'Explicit override prompt',
    });
    expect(agent.state.systemPrompt).toBe('Explicit override prompt');
  });

  it('prefers explicit options.model over default model', () => {
    const customModel = {
      id: 'explicit-model',
      name: 'Explicit Model',
      api: 'openai',
      provider: 'test',
      baseUrl: '',
      reasoning: false,
      input: [],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 16384,
      maxTokens: 8192,
    };
    const registry = makeMockToolRegistry();
    const factory = createAgentFactory({ config: makeMockConfig(), toolRegistry: registry });
    const agent = factory.create({ model: customModel });
    expect(agent.state.model.id).toBe('explicit-model');
    expect(agent.state.model.contextWindow).toBe(16384);
  });

  it('prefers explicit options.tools over toolRegistry tools', () => {
    const registry = makeMockToolRegistry([makeMockTool('registry_tool')]);
    const factory = createAgentFactory({ config: makeMockConfig(), toolRegistry: registry });
    const customTools = [makeMockTool('explicit_tool')];
    const agent = factory.create({ tools: customTools });
    expect(agent.state.tools).toHaveLength(1);
    expect(agent.state.tools[0].name).toBe('explicit_tool');
    expect(registry.listAsAgentTools).not.toHaveBeenCalled();
  });

  it('passes through extraTools appended to the final tool list', () => {
    // Use 'shell' which is in all profile tool lists to survive profile filtering
    const baseTools = [makeMockTool('shell')];
    const extraTools = [makeMockTool('extra_tool')];
    const registry = makeMockToolRegistry(baseTools);
    const factory = createAgentFactory({ config: makeMockConfig(), toolRegistry: registry });
    const agent = factory.create({ extraTools });
    const names = agent.state.tools.map((t: any) => t.name);
    expect(names).toContain('shell');
    expect(names).toContain('extra_tool');
  });

  it('resolves tools from agentConfig when agentManager is available', () => {
    // Use 'shell' which is in all profiles to survive profile filtering
    const resolvedTools = [makeMockTool('shell')];
    const agentManager = {
      get: vi.fn(() => ({
        id: 'agent-resolved',
        name: 'ResolvedAgent',
        system_prompt: 'Resolved tools agent',
        model: { primary: '', fallback: [], reasoning_level: '', transport: '', max_retry: 0 },
        tools: { profile: 'minimal' as const },
      })),
      getDefault: vi.fn(() => undefined),
      resolveTools: vi.fn(() => resolvedTools),
    };
    const registry = makeMockToolRegistry([makeMockTool('default_tool')]);
    const factory = createAgentFactory({
      config: makeMockConfig(),
      toolRegistry: registry,
      agentManager: agentManager as any,
    });
    const agent = factory.create({ agentId: 'agent-resolved', sessionId: 's1' });
    const names = agent.state.tools.map((t: any) => t.name);
    expect(names).toEqual(['shell']);
    expect(agentManager.resolveTools).toHaveBeenCalled();
  });

  it('uses historyMessages as initial messages', () => {
    const registry = makeMockToolRegistry();
    const factory = createAgentFactory({ config: makeMockConfig(), toolRegistry: registry });
    const history = [
      { role: 'user', content: 'Hello', timestamp: 1000 },
      { role: 'assistant', content: 'Hi there!', timestamp: 1001 },
    ];
    const agent = factory.create({ sessionId: 's1', historyMessages: history });
    expect(agent.state.messages).toHaveLength(2);
    expect(agent.state.messages[0].role).toBe('user');
    expect(agent.state.messages[1].content).toBe('Hi there!');
  });
});
