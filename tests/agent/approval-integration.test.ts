import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAgentFactory } from '../../src/agent/agent-factory';
import { createFeishuApprovalUiPort } from '../../extensions/channel-feishu/render/approval-ui-port-feishu.js';
import type { AppConfig, ApprovalGate, ApprovalRequest, ApprovalDecision } from '../../src/app/types';

// ─── Mocks ───

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

vi.mock('../../extensions/channel-feishu/render/approval-card-renderer.js', () => ({
  renderApprovalCard: vi.fn((request: any) => ({
    elements: [
      {
        tag: 'action',
        actions: [
          { tag: 'button', value: { action: 'approve_once', requestId: request.id } },
          { tag: 'button', value: { action: 'approve_always', requestId: request.id } },
          { tag: 'button', value: { action: 'reject_once', requestId: request.id } },
          { tag: 'button', value: { action: 'reject_always', requestId: request.id } },
        ],
      },
    ],
  })),
  renderApprovalQueueCard: vi.fn(() => ({
    elements: [],
  })),
  assessCommandRisk: vi.fn(() => 'medium'),
}));

// ─── Helpers ───

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
    execute: async () => ({
      content: [{ type: 'text', text: 'ok' }],
      details: null,
    }),
  };
}

function makeMockApprovalGate(
  decisions: Record<string, ApprovalDecision> = {},
): ApprovalGate {
  return {
    evaluate: vi.fn(async (request: ApprovalRequest) => {
      if (request.command) {
        const key = request.command.raw;
        if (key in decisions) return decisions[key];
      }
      return 'requires_approval' as ApprovalDecision;
    }),
    recordDecision: vi.fn(async () => {}),
    getPolicy: vi.fn(async () => null),
  };
}

function makeMockFeishuClient() {
  const sendApprovalCard = vi.fn(async () => 'approval-msg-1');
  const feishuClient = {
    sendApprovalCard,
    updateMessage: vi.fn(async () => {}),
  };
  const approvalPort = createFeishuApprovalUiPort({
    feishuClient: feishuClient as any,
  });
  return { feishuClient, approvalPort };
}

// ─── Tests ───

describe('Approval Integration in AgentFactory', () => {
  const config = makeMockConfig();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('factory without approval gate — agent has no beforeToolCall hook', () => {
    const registry = makeMockToolRegistry([makeMockTool('shell')]);
    const factory = createAgentFactory({ config, toolRegistry: registry });
    const agent = factory.create();
    expect(agent.beforeToolCall).toBeUndefined();
  });

  it('factory with approval gate — agent has beforeToolCall hook', () => {
    const registry = makeMockToolRegistry([makeMockTool('shell')]);
    const gate = makeMockApprovalGate();
    const factory = createAgentFactory(
      { config, toolRegistry: registry },
      { approvalGate: gate },
    );
    const agent = factory.create();
    expect(agent.beforeToolCall).toBeDefined();
  });

  it('non-shell tool bypasses approval check', async () => {
    const registry = makeMockToolRegistry([makeMockTool('web_search')]);
    const gate = makeMockApprovalGate();
    const factory = createAgentFactory(
      { config, toolRegistry: registry },
      { approvalGate: gate },
    );
    const agent = factory.create();

    // Simulate beforeToolCall for a non-shell tool
    const hook = agent.beforeToolCall!;
    const result = await hook({
      assistantMessage: {
        role: 'assistant',
        content: [],
        timestamp: Date.now(),
      } as any,
      toolCall: {
        type: 'toolCall',
        name: 'web_search',
        id: 'tc-1',
        args: { query: 'test' },
      } as any,
      args: { query: 'test' },
      context: {
        systemPrompt: '',
        messages: [],
        tools: [],
      },
    });

    // Should not block — proceed with tool execution
    expect(result).toBeUndefined();
    expect(gate.evaluate).not.toHaveBeenCalled();
  });

  it('shell command with allow — tool proceeds', async () => {
    const registry = makeMockToolRegistry([makeMockTool('shell')]);
    const gate = makeMockApprovalGate({
      'ls -la': 'approved',
    });
    const factory = createAgentFactory(
      { config, toolRegistry: registry },
      { approvalGate: gate },
    );
    const agent = factory.create();

    const hook = agent.beforeToolCall!;
    const result = await hook({
      assistantMessage: {
        role: 'assistant',
        content: [],
        timestamp: Date.now(),
      } as any,
      toolCall: {
        type: 'toolCall',
        name: 'shell',
        id: 'tc-1',
        args: { command: 'ls -la' },
      } as any,
      args: { command: 'ls -la' },
      context: {
        systemPrompt: '',
        messages: [],
        tools: [],
      },
    });

    expect(result).toBeUndefined();
    expect(gate.evaluate).toHaveBeenCalled();
  });

  it('shell command with deny — tool blocked with reason', async () => {
    const registry = makeMockToolRegistry([makeMockTool('shell')]);
    const gate = makeMockApprovalGate({
      'rm -rf /': 'rejected',
    });
    const factory = createAgentFactory(
      { config, toolRegistry: registry },
      { approvalGate: gate },
    );
    const agent = factory.create();

    const hook = agent.beforeToolCall!;
    const result = await hook({
      assistantMessage: {
        role: 'assistant',
        content: [],
        timestamp: Date.now(),
      } as any,
      toolCall: {
        type: 'toolCall',
        name: 'shell',
        id: 'tc-1',
        args: { command: 'rm -rf /' },
      } as any,
      args: { command: 'rm -rf /' },
      context: {
        systemPrompt: '',
        messages: [],
        tools: [],
      },
    });

    expect(result).toEqual({
      block: true,
      reason: 'Command denied by policy',
    });
  });

  it('shell command requiring approval — resolves via resolveApproval (approved)', async () => {
    const registry = makeMockToolRegistry([makeMockTool('shell')]);
    const gate = makeMockApprovalGate({
      'adb install app.apk': 'requires_approval',
    });
    const { feishuClient, approvalPort } = makeMockFeishuClient();
    const factory = createAgentFactory(
      { config, toolRegistry: registry },
      {
        approvalGate: gate,
        feishuClient,
        approvalPort,
        approvalTimeoutMs: 5000,
      },
    );
    const agent = factory.create({ chatId: 'chat-123', sessionId: 'sess-1' });

    // Start the hook — it will block waiting for approval
    const hook = agent.beforeToolCall!;
    const hookPromise = hook({
      assistantMessage: {
        role: 'assistant',
        content: [],
        timestamp: Date.now(),
      } as any,
      toolCall: {
        type: 'toolCall',
        name: 'shell',
        id: 'tc-1',
        args: { command: 'adb install app.apk' },
      } as any,
      args: { command: 'adb install app.apk' },
      context: {
        systemPrompt: '',
        messages: [],
        tools: [],
      },
    });

    // Give the hook a tick to start and generate the request ID
    await new Promise((r) => setTimeout(r, 50));

    // Verify Feishu card was sent
    expect(feishuClient.sendApprovalCard).toHaveBeenCalledOnce();

    // Resolve all pending approvals — the factory uses generateId so we can't
    // predict the exact ID. Instead, we hook into the pending store via the factory.
    // Since we can't access the private store, we use a different approach:
    // resolveApproval returns false for unknown IDs, so let's test that.
    const unknownResult = factory.resolveApproval('nonexistent', 'approved');
    expect(unknownResult).toBe(false);

    // We need to resolve the actual pending ID. Let's intercept it by monitoring
    // the sendApprovalCard call which includes the requestId in the card value.
    const cardArg = feishuClient.sendApprovalCard.mock.calls[0][1] as any;
    // Extract requestId from the card's button value
    const actionBlock = cardArg.elements?.find((e: any) => e.tag === 'action');
    const approveButton = actionBlock?.actions?.find(
      (a: any) => a.value?.action === 'approve_once',
    );
    const requestId = approveButton?.value?.requestId;

    expect(requestId).toBeDefined();

    // Now resolve the approval
    const resolved = factory.resolveApproval(requestId, 'approved');
    expect(resolved).toBe(true);

    // The hook should complete without blocking
    const result = await hookPromise;
    expect(result).toBeUndefined(); // proceed
  });

  it('shell command requiring approval — resolves via resolveApproval (rejected)', async () => {
    const registry = makeMockToolRegistry([makeMockTool('shell')]);
    const gate = makeMockApprovalGate({
      'adb install app.apk': 'requires_approval',
    });
    const { feishuClient, approvalPort } = makeMockFeishuClient();
    const factory = createAgentFactory(
      { config, toolRegistry: registry },
      {
        approvalGate: gate,
        feishuClient,
        approvalPort,
        approvalTimeoutMs: 5000,
      },
    );
    const agent = factory.create({ chatId: 'chat-123', sessionId: 'sess-1' });

    const hook = agent.beforeToolCall!;
    const hookPromise = hook({
      assistantMessage: {
        role: 'assistant',
        content: [],
        timestamp: Date.now(),
      } as any,
      toolCall: {
        type: 'toolCall',
        name: 'shell',
        id: 'tc-1',
        args: { command: 'adb install app.apk' },
      } as any,
      args: { command: 'adb install app.apk' },
      context: {
        systemPrompt: '',
        messages: [],
        tools: [],
      },
    });

    await new Promise((r) => setTimeout(r, 50));

    // Extract requestId from the approval card
    const cardArg = feishuClient.sendApprovalCard.mock.calls[0][1] as any;
    const actionBlock = cardArg.elements?.find((e: any) => e.tag === 'action');
    const approveButton = actionBlock?.actions?.find(
      (a: any) => a.value?.action === 'approve_once',
    );
    const requestId = approveButton?.value?.requestId;

    // Reject the approval
    factory.resolveApproval(requestId, 'rejected');

    const result = await hookPromise;
    expect(result).toEqual({
      block: true,
      reason: 'Command rejected by user',
    });
  });

  it('approval timeout — command is rejected', async () => {
    const registry = makeMockToolRegistry([makeMockTool('shell')]);
    const gate = makeMockApprovalGate({
      'adb install app.apk': 'requires_approval',
    });
    const { feishuClient, approvalPort } = makeMockFeishuClient();
    const factory = createAgentFactory(
      { config, toolRegistry: registry },
      {
        approvalGate: gate,
        feishuClient,
        approvalPort,
        approvalTimeoutMs: 100, // very short timeout for test
      },
    );
    const agent = factory.create({ chatId: 'chat-123', sessionId: 'sess-1' });

    const hook = agent.beforeToolCall!;
    const result = await hook({
      assistantMessage: {
        role: 'assistant',
        content: [],
        timestamp: Date.now(),
      } as any,
      toolCall: {
        type: 'toolCall',
        name: 'shell',
        id: 'tc-1',
        args: { command: 'adb install app.apk' },
      } as any,
      args: { command: 'adb install app.apk' },
      context: {
        systemPrompt: '',
        messages: [],
        tools: [],
      },
    });

    // Timeout should cause rejection
    expect(result).toEqual({
      block: true,
      reason: 'Command rejected by user',
    });
  });

  it('approval gate not configured — no check performed', () => {
    const registry = makeMockToolRegistry([makeMockTool('shell')]);
    const factory = createAgentFactory({ config, toolRegistry: registry });
    const agent = factory.create();
    expect(agent.beforeToolCall).toBeUndefined();
  });

  it('resolveApproval returns false for unknown request ID', () => {
    const registry = makeMockToolRegistry([makeMockTool('shell')]);
    const gate = makeMockApprovalGate();
    const factory = createAgentFactory(
      { config, toolRegistry: registry },
      { approvalGate: gate },
    );
    expect(factory.resolveApproval('nonexistent-id', 'approved')).toBe(false);
  });

  it('shell command with args normalization', async () => {
    const registry = makeMockToolRegistry([makeMockTool('shell')]);
    const evaluateSpy = vi.fn(async () => 'approved' as ApprovalDecision);
    const gate = { ...makeMockApprovalGate(), evaluate: evaluateSpy };
    const factory = createAgentFactory(
      { config, toolRegistry: registry },
      { approvalGate: gate },
    );
    const agent = factory.create({ sessionId: 'sess-test' });

    const hook = agent.beforeToolCall!;
    await hook({
      assistantMessage: {
        role: 'assistant',
        content: [],
        timestamp: Date.now(),
      } as any,
      toolCall: {
        type: 'toolCall',
        name: 'shell',
        id: 'tc-1',
        args: { command: '  adb   devices  ' },
      } as any,
      args: { command: '  adb   devices  ' },
      context: {
        systemPrompt: '',
        messages: [],
        tools: [],
      },
    });

    // Verify the command was normalized before evaluation
    expect(evaluateSpy).toHaveBeenCalledOnce();
    const callArgs = evaluateSpy.mock.calls[0][0] as ApprovalRequest;
    expect(callArgs.kind).toBe('shell');
    expect(callArgs.command).toBeDefined();
    expect(callArgs.command!.program).toBe('adb');
    expect(callArgs.command!.args).toEqual(['devices']);
  });

  it('minimal profile blocks direct tee even when approval gate would approve', async () => {
    const registry = makeMockToolRegistry([makeMockTool('shell')]);
    const gate = makeMockApprovalGate({ 'tee output.txt': 'approved' });
    const factory = createAgentFactory(
      { config, toolRegistry: registry },
      { approvalGate: gate, defaultToolsProfile: 'minimal' },
    );
    const agent = factory.create();

    const result = await agent.beforeToolCall!({
      assistantMessage: { role: 'assistant', content: [], timestamp: Date.now() } as any,
      toolCall: {
        type: 'toolCall',
        name: 'shell',
        id: 'tc-1',
        args: { command: 'tee output.txt' },
      } as any,
      args: { command: 'tee output.txt' },
      context: { systemPrompt: '', messages: [], tools: [] },
    });

    expect(result).toEqual({
      block: true,
      reason: 'Program "tee" is blocked by read-only shell mode (toolsProfile: minimal)',
    });
    expect(gate.evaluate).not.toHaveBeenCalled();
  });

  it('minimal profile blocks find deletion before approval evaluation', async () => {
    const registry = makeMockToolRegistry([makeMockTool('shell')]);
    const gate = makeMockApprovalGate({ 'find . -delete': 'approved' });
    const factory = createAgentFactory(
      { config, toolRegistry: registry },
      { approvalGate: gate, defaultToolsProfile: 'minimal' },
    );
    const agent = factory.create();

    const result = await agent.beforeToolCall!({
      assistantMessage: { role: 'assistant', content: [], timestamp: Date.now() } as any,
      toolCall: {
        type: 'toolCall',
        name: 'shell',
        id: 'tc-1',
        args: { command: 'find . -delete' },
      } as any,
      args: { command: 'find . -delete' },
      context: { systemPrompt: '', messages: [], tools: [] },
    });

    expect(result).toEqual({
      block: true,
      reason: 'find -delete is blocked by read-only shell mode (toolsProfile: minimal)',
    });
    expect(gate.evaluate).not.toHaveBeenCalled();
  });

  it('minimal profile blocks pipe to tee before approval evaluation', async () => {
    const registry = makeMockToolRegistry([makeMockTool('shell')]);
    const gate = makeMockApprovalGate({ 'echo hello | tee output.txt': 'approved' });
    const factory = createAgentFactory(
      { config, toolRegistry: registry },
      { approvalGate: gate, defaultToolsProfile: 'minimal' },
    );
    const agent = factory.create();

    const result = await agent.beforeToolCall!({
      assistantMessage: { role: 'assistant', content: [], timestamp: Date.now() } as any,
      toolCall: {
        type: 'toolCall',
        name: 'shell',
        id: 'tc-1',
        args: { command: 'echo hello | tee output.txt' },
      } as any,
      args: { command: 'echo hello | tee output.txt' },
      context: { systemPrompt: '', messages: [], tools: [] },
    });

    expect(result).toEqual({
      block: true,
      reason: 'pipe to tee is blocked by read-only shell mode (toolsProfile: minimal)',
    });
    expect(gate.evaluate).not.toHaveBeenCalled();
  });
});
