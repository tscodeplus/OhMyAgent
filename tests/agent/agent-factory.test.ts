import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Agent } from '@earendil-works/pi-agent-core';
import { createAgentFactory } from '../../src/agent/agent-factory';
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
        content: [{ type: 'text', text: `session=${ctx.sessionId};agent=${ctx.agentId};profile=${ctx.policyScope.toolsProfile}` }],
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
        screenshot: { type: 'image', mimeType: 'image/png', data: Buffer.from('png').toString('base64') },
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
    const factory = createAgentFactory({
      config: fullConfig,
      toolRegistry: registry,
      computerUseHost: computerUseHost as any,
    }, { feishuClient: feishuClient as any });

    const agent = factory.create({
      sessionId: 'session-123',
      agentId: 'agent-1',
      chatId: 'chat-1',
      channel: 'feishu',
    });
    const tool = agent.state.tools.find((t: any) => t.name === 'computer_use')!;

    const result = await tool.execute('call-1', { action: 'send_screenshot' });

    expect(feishuClient.uploadImage).toHaveBeenCalledWith(Buffer.from('png'), 'message');
    expect(feishuClient.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      receive_id: 'chat-1',
      receive_id_type: 'chat_id',
      msg_type: 'image',
      content: JSON.stringify({ image_key: 'img_1' }),
    }));
    expect(result.details).toMatchObject({ sent: true, snapshotId: 'snap-1' });
  });

  it('uses the channel Computer Use image sender for QQ screenshots', async () => {
    const computerUseHost = {
      getAppState: vi.fn().mockResolvedValue({
        mode: 'vision-native',
        screenshot: { type: 'image', mimeType: 'image/png', data: Buffer.from('png').toString('base64') },
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
    const factory = createAgentFactory({
      config: fullConfig,
      toolRegistry: registry,
      computerUseHost: computerUseHost as any,
    }, { feishuClient: feishuClient as any });

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
});
