/**
 * E2E Integration Test: Message Flow
 *
 * Tests the complete flow: Feishu message -> Agent processing -> Response
 * with mocked LLM and Feishu API, real internal modules.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Agent } from '../../src/pi-mono/agent/agent.js';
import { AssistantMessageEventStream } from '../../src/pi-mono/ai/utils/event-stream.js';
import { createAgentFactory } from '../../src/agent/agent-factory.js';
import { AgentService } from '../../src/agent/agent-service.js';
import { EventBridge } from '../../src/agent/event-bridge.js';
import { createToolRegistry } from '../../src/tools/registry.js';
import {
  createTestDatabase,
  makeTestConfig,
  makeMockTool,
  createMockDispatcher,
  makeMockModel,
  createTextStreamFn,
  createToolCallStreamFn,
} from './helpers.js';
import type Database from 'better-sqlite3';

// Mock pi-ai-setup to avoid real provider lookups
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

describe('E2E: Message Flow', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDatabase();
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  // ─── Basic text response ─────────────────────────────────────────────────

  it('text message -> agent responds with text', async () => {
    const dispatcher = createMockDispatcher();
    const model = makeMockModel();

    const agent = new Agent({
      initialState: { systemPrompt: 'test', model, tools: [] },
      streamFn: createTextStreamFn('Hello! How can I help you?'),
    });

    const bridge = new EventBridge(dispatcher);
    bridge.start(agent);
    await agent.prompt('Hi there');
    bridge.stop();

    expect(dispatcher.onStart).toHaveBeenCalled();
    expect(dispatcher.onTextDelta).toHaveBeenCalled();
    expect(dispatcher.onComplete).toHaveBeenCalled();

    const textDeltas = dispatcher.calls.filter(c => c.startsWith('onTextDelta:'));
    expect(textDeltas.length).toBeGreaterThan(0);
    const fullText = textDeltas.map(c => c.replace('onTextDelta:', '')).join('');
    expect(fullText).toContain('Hello!');
  });

  // ─── Tool call flow ──────────────────────────────────────────────────────

  it('message with tool call -> tool executes -> result returned', async () => {
    const dispatcher = createMockDispatcher();
    const model = makeMockModel();
    const shellTool = makeMockTool('shell', 'file1.txt\nfile2.txt');

    const agent = new Agent({
      initialState: { systemPrompt: 'test', model, tools: [shellTool] },
      streamFn: createToolCallStreamFn(
        'shell',
        { command: 'ls' },
        'The files are: file1.txt, file2.txt',
      ),
    });

    const bridge = new EventBridge(dispatcher);
    bridge.start(agent);
    await agent.prompt('List files');
    bridge.stop();

    expect(shellTool.execute).toHaveBeenCalled();
    expect(dispatcher.onToolStart).toHaveBeenCalledWith('shell', { command: 'ls' }, expect.any(String));
    expect(dispatcher.onToolEnd).toHaveBeenCalled();
    expect(dispatcher.onComplete).toHaveBeenCalled();

    const textDeltas = dispatcher.calls.filter(c => c.startsWith('onTextDelta:'));
    expect(textDeltas.length).toBeGreaterThan(0);
  });

  // ─── Multiple tools registered ───────────────────────────────────────────

  it('agent has all registered tools available', async () => {
    const config = makeTestConfig();
    const toolRegistry = createToolRegistry();
    toolRegistry.register(makeMockTool('shell'));
    toolRegistry.register(makeMockTool('file_read'));
    toolRegistry.register(makeMockTool('memory-recall'));
    const model = makeMockModel();

    const factory = createAgentFactory({ config, toolRegistry });
    const agent = factory.create({ model });

    expect(agent.state.tools).toHaveLength(3);
    expect(agent.state.tools.map((t: any) => t.name)).toEqual(
      expect.arrayContaining(['shell', 'file_read', 'memory-recall']),
    );
  });

  // ─── System prompt ───────────────────────────────────────────────────────

  it('agent uses default system prompt', () => {
    const config = makeTestConfig();
    const toolRegistry = createToolRegistry();
    const model = makeMockModel();

    const factory = createAgentFactory({ config, toolRegistry });
    const agent = factory.create({ model });

    expect(agent.state.systemPrompt).toContain('You are OhMyAgent, a helpful AI assistant.');
    expect(agent.state.systemPrompt).toContain('## Memory');
  });

  it('agent uses custom system prompt when provided', () => {
    const config = makeTestConfig();
    const toolRegistry = createToolRegistry();
    const model = makeMockModel();

    const factory = createAgentFactory({ config, toolRegistry });
    const agent = factory.create({
      model,
      systemPrompt: 'Custom system prompt for testing.',
    });

    expect(agent.state.systemPrompt).toBe('Custom system prompt for testing.');
  });

  // ─── EventBridge wiring ──────────────────────────────────────────────────

  it('EventBridge forwards all lifecycle events to dispatcher', async () => {
    const dispatcher = createMockDispatcher();
    const model = makeMockModel();

    const agent = new Agent({
      initialState: { systemPrompt: 'test', model, tools: [] },
      streamFn: createTextStreamFn('Response'),
    });

    const bridge = new EventBridge(dispatcher);
    bridge.start(agent);
    await agent.prompt('Test');
    bridge.stop();

    expect(dispatcher.calls[0]).toBe('onStart');
    expect(dispatcher.calls).toContain('onComplete');
  });

  // ─── Error handling ──────────────────────────────────────────────────────

  it('LLM error -> dispatcher.onError called', async () => {
    const dispatcher = createMockDispatcher();
    const model = makeMockModel();

    const agent = new Agent({
      initialState: { systemPrompt: 'test', model, tools: [] },
      streamFn: (_model: any, _context: any, _options?: any) => {
        const stream = new AssistantMessageEventStream();
        stream.push({
          type: 'error',
          reason: 'error',
          error: {
            role: 'assistant',
            content: [{ type: 'text', text: '' }],
            api: 'openai-completions',
            provider: 'test-provider',
            model: 'test-model',
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: 'error',
            errorMessage: 'LLM API timeout',
            timestamp: Date.now(),
          },
        });
        return stream;
      },
    });

    const bridge = new EventBridge(dispatcher);
    bridge.start(agent);
    await agent.prompt('Test error');
    bridge.stop();

    expect(dispatcher.onError).toHaveBeenCalled();
    const errorCalls = dispatcher.calls.filter(c => c.startsWith('onError:'));
    expect(errorCalls.length).toBeGreaterThan(0);
  });

  // ─── AgentService integration ────────────────────────────────────────────

  it('AgentService.execute creates agent, runs prompt, and cleans up', async () => {
    const config = makeTestConfig();
    const toolRegistry = createToolRegistry();
    const dispatcher = createMockDispatcher();
    const model = makeMockModel();

    const factory = createAgentFactory({ config, toolRegistry });
    const service = new AgentService(factory, () => dispatcher);

    // Create a real agent with mocked streamFn
    const agent = new Agent({
      initialState: {
        systemPrompt: 'You are OhMyAgent, a helpful AI assistant.',
        model,
        tools: [],
      },
      streamFn: createTextStreamFn('AgentService response'),
    });

    // Override factory.create to return our pre-configured agent
    const factorySpy = vi.spyOn(factory, 'create').mockReturnValue(agent);

    const result = await service.execute('Hello via AgentService');

    expect(factorySpy).toHaveBeenCalled();
    expect(result).toBe(agent);
    expect(service.isRunning()).toBe(false);
  });

  // ─── Multi-turn conversation ─────────────────────────────────────────────

  it('agent maintains conversation history across prompts', async () => {
    const dispatcher = createMockDispatcher();
    const model = makeMockModel();

    let callCount = 0;
    const agent = new Agent({
      initialState: { systemPrompt: 'test', model, tools: [] },
      streamFn: (_model: any, _context: any, _options?: any) => {
        callCount++;
        const stream = new AssistantMessageEventStream();
        const text = `Response ${callCount}`;
        const message = {
          role: 'assistant' as const,
          content: [{ type: 'text' as const, text }],
          api: 'openai-completions' as const,
          provider: 'test-provider',
          model: 'test-model',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: 'stop' as const,
          timestamp: Date.now(),
        };
        stream.push({ type: 'start', partial: { ...message } });
        stream.push({ type: 'text_start', contentIndex: 0, partial: { ...message } });
        stream.push({ type: 'text_delta', contentIndex: 0, delta: text, partial: { ...message } });
        stream.push({ type: 'text_end', contentIndex: 0, content: text, partial: { ...message } });
        stream.push({ type: 'done', reason: 'stop', message });
        return stream;
      },
    });

    const bridge = new EventBridge(dispatcher);
    bridge.start(agent);

    await agent.prompt('First message');
    await agent.prompt('Second message');
    bridge.stop();

    // Agent should have 4 messages: user1, assistant1, user2, assistant2
    expect(agent.state.messages).toHaveLength(4);
    expect(agent.state.messages[0].role).toBe('user');
    expect(agent.state.messages[1].role).toBe('assistant');
    expect(agent.state.messages[2].role).toBe('user');
    expect(agent.state.messages[3].role).toBe('assistant');
  });

  // ─── Tool not found ──────────────────────────────────────────────────────

  it('tool call for unknown tool -> error result returned', async () => {
    const dispatcher = createMockDispatcher();
    const model = makeMockModel();

    const agent = new Agent({
      initialState: { systemPrompt: 'test', model, tools: [] },
      streamFn: createToolCallStreamFn(
        'nonexistent-tool',
        { arg: 'value' },
        'Done',
      ),
    });

    const bridge = new EventBridge(dispatcher);
    bridge.start(agent);
    await agent.prompt('Use nonexistent tool');
    bridge.stop();

    // Tool execution should have been attempted and failed
    expect(dispatcher.onToolStart).toHaveBeenCalled();
    expect(dispatcher.onToolEnd).toHaveBeenCalled();
    expect(dispatcher.onComplete).toHaveBeenCalled();
  });

  // ─── beforeToolCall hook ─────────────────────────────────────────────────

  it('beforeToolCall hook can block tool execution', async () => {
    const dispatcher = createMockDispatcher();
    const model = makeMockModel();
    const shellTool = makeMockTool('shell', 'output');

    const agent = new Agent({
      initialState: { systemPrompt: 'test', model, tools: [shellTool] },
      streamFn: createToolCallStreamFn(
        'shell',
        { command: 'rm -rf /' },
        'Done',
      ),
      beforeToolCall: async () => ({
        block: true,
        reason: 'Dangerous command blocked',
      }),
    });

    const bridge = new EventBridge(dispatcher);
    bridge.start(agent);
    await agent.prompt('Delete everything');
    bridge.stop();

    // Tool should NOT have executed
    expect(shellTool.execute).not.toHaveBeenCalled();
    // But tool events should still fire
    expect(dispatcher.onToolStart).toHaveBeenCalled();
    expect(dispatcher.onToolEnd).toHaveBeenCalled();
    expect(dispatcher.onComplete).toHaveBeenCalled();
  });
});
