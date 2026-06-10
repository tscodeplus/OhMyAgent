import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventBridge } from '../../src/agent/event-bridge.js';
import type { ReplyDispatcher } from '../../src/app/types.js';

/**
 * Minimal mock of pi-mono Agent that exposes a subscribe() method.
 * The real Agent class subscribes a listener and returns an unsubscribe fn.
 */
function createMockAgent() {
  let listener: ((event: any, signal: AbortSignal) => void | Promise<void>) | undefined;

  return {
    subscribe: vi.fn(
      (cb: (event: any, signal: AbortSignal) => void | Promise<void>) => {
        listener = cb;
        return () => {
          listener = undefined;
        };
      },
    ),
    /** Helper: emit an event as if the real Agent did. */
    async emit(event: any) {
      if (!listener) throw new Error('No listener subscribed');
      await listener(event, new AbortController().signal);
    },
  };
}

function createMockDispatcher(): ReplyDispatcher {
  return {
    onStart: vi.fn(),
    onTextDelta: vi.fn(),
    onReasoningDelta: vi.fn(),
    onToolStart: vi.fn(),
    onToolEnd: vi.fn(),
    setApprovalStatus: vi.fn(),
    setModel: vi.fn(),
    onComplete: vi.fn(),
    onError: vi.fn(),
    onAborted: vi.fn(),
  };
}

describe('EventBridge', () => {
  let agent: ReturnType<typeof createMockAgent>;
  let dispatcher: ReplyDispatcher;
  let bridge: EventBridge;

  beforeEach(() => {
    agent = createMockAgent();
    dispatcher = createMockDispatcher();
    bridge = new EventBridge(dispatcher);
  });

  // ------------------------------------------------------------------ start / stop
  it('start() subscribes to the agent', () => {
    bridge.start(agent as any);
    expect(agent.subscribe).toHaveBeenCalledTimes(1);
  });

  it('stop() unsubscribes from the agent', () => {
    bridge.start(agent as any);
    bridge.stop();
    // After stop, emitting should throw because the listener was removed
    return expect(agent.emit({ type: 'agent_start' })).rejects.toThrow('No listener subscribed');
  });

  it('calling stop() multiple times is safe', () => {
    bridge.start(agent as any);
    bridge.stop();
    bridge.stop(); // should not throw
  });

  // ------------------------------------------------------------------ agent_start
  it('agent_start -> onStart()', async () => {
    bridge.start(agent as any);
    await agent.emit({ type: 'agent_start' });
    expect(dispatcher.onStart).toHaveBeenCalledTimes(1);
  });

  // ------------------------------------------------------------------ message_update: text
  it('message_update with text_delta -> onTextDelta(delta)', async () => {
    bridge.start(agent as any);
    await agent.emit({
      type: 'message_update',
      message: { role: 'assistant', content: [] },
      assistantMessageEvent: {
        type: 'text_delta',
        contentIndex: 0,
        delta: 'Hello',
        partial: { role: 'assistant', content: [] },
      },
    });
    expect(dispatcher.onTextDelta).toHaveBeenCalledWith('Hello');
    expect(dispatcher.onReasoningDelta).not.toHaveBeenCalled();
  });

  // ------------------------------------------------------------------ message_update: thinking
  it('message_update with thinking_delta -> onReasoningDelta(delta)', async () => {
    bridge.start(agent as any);
    await agent.emit({
      type: 'message_update',
      message: { role: 'assistant', content: [] },
      assistantMessageEvent: {
        type: 'thinking_delta',
        contentIndex: 0,
        delta: 'Let me think...',
        partial: { role: 'assistant', content: [] },
      },
    });
    expect(dispatcher.onReasoningDelta).toHaveBeenCalledWith('Let me think...');
    expect(dispatcher.onTextDelta).not.toHaveBeenCalled();
  });

  // ------------------------------------------------------------------ message_update: ignored sub-types
  it('message_update with non-delta sub-types is ignored', async () => {
    bridge.start(agent as any);
    await agent.emit({
      type: 'message_update',
      message: { role: 'assistant', content: [] },
      assistantMessageEvent: {
        type: 'text_start',
        contentIndex: 0,
        partial: { role: 'assistant', content: [] },
      },
    });
    expect(dispatcher.onTextDelta).not.toHaveBeenCalled();
    expect(dispatcher.onReasoningDelta).not.toHaveBeenCalled();
  });

  // ------------------------------------------------------------------ tool_execution_start
  it('tool_execution_start -> onToolStart(name, args)', async () => {
    bridge.start(agent as any);
    const args = { command: 'ls -la' };
    await agent.emit({
      type: 'tool_execution_start',
      toolCallId: 'tc-1',
      toolName: 'shell',
      args,
    });
    expect(dispatcher.onToolStart).toHaveBeenCalledWith('shell', args, 'tc-1');
  });

  // ------------------------------------------------------------------ tool_execution_end
  it('tool_execution_end -> onToolEnd(name, result)', async () => {
    bridge.start(agent as any);
    const result = { content: [{ type: 'text', text: 'done' }], details: null };
    await agent.emit({
      type: 'tool_execution_end',
      toolCallId: 'tc-1',
      toolName: 'shell',
      result,
      isError: false,
    });
    expect(dispatcher.onToolEnd).toHaveBeenCalledWith('shell', result, false, 'tc-1');
  });

  // ------------------------------------------------------------------ agent_end: success
  it('agent_end with successful message -> onComplete(usage)', async () => {
    bridge.start(agent as any);
    await agent.emit({
      type: 'agent_end',
      messages: [
        {
          role: 'assistant',
          stopReason: 'stop',
          usage: {
            input: 100,
            output: 50,
            cacheRead: 10,
            cacheWrite: 5,
            totalTokens: 165,
            cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
          },
          content: [],
          api: 'openai-chat',
          provider: 'openai',
          model: 'gpt-4o',
          timestamp: Date.now(),
        },
      ],
    });
    expect(dispatcher.onComplete).toHaveBeenCalledWith({
      input: 100,
      output: 50,
      cacheRead: 10,
      cacheWrite: 5,
      totalTokens: 165,
      cost: 0.003,
      cacheHitRate: 10 / 115,
    });
    expect(dispatcher.onError).not.toHaveBeenCalled();
  });

  // ------------------------------------------------------------------ agent_end: no messages
  it('agent_end with empty messages -> onComplete(undefined)', async () => {
    bridge.start(agent as any);
    await agent.emit({ type: 'agent_end', messages: [] });
    expect(dispatcher.onComplete).toHaveBeenCalledWith(undefined);
  });

  // ------------------------------------------------------------------ agent_end: error
  it('agent_end with error stopReason -> onError(error)', async () => {
    bridge.start(agent as any);
    await agent.emit({
      type: 'agent_end',
      messages: [
        {
          role: 'assistant',
          stopReason: 'error',
          errorMessage: 'Rate limit exceeded',
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          content: [],
          api: 'openai-chat',
          provider: 'openai',
          model: 'gpt-4o',
          timestamp: Date.now(),
        },
      ],
    });
    expect(dispatcher.onError).toHaveBeenCalledTimes(1);
    const err = (dispatcher.onError as any).mock.calls[0][0];
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('Rate limit exceeded');
    expect(dispatcher.onComplete).not.toHaveBeenCalled();
  });

  // ------------------------------------------------------------------ agent_end: aborted
  it('agent_end with aborted stopReason -> onAborted()', async () => {
    bridge.start(agent as any);
    await agent.emit({
      type: 'agent_end',
      messages: [
        {
          role: 'assistant',
          stopReason: 'aborted',
          content: [],
          api: 'openai-chat',
          provider: 'openai',
          model: 'gpt-4o',
          timestamp: Date.now(),
        },
      ],
    });
    expect(dispatcher.onAborted).toHaveBeenCalledTimes(1);
    expect(dispatcher.onComplete).not.toHaveBeenCalled();
    expect(dispatcher.onError).not.toHaveBeenCalled();
  });

  // ------------------------------------------------------------------ agent_end: error without message
  it('agent_end with error and no errorMessage -> onError with default', async () => {
    bridge.start(agent as any);
    await agent.emit({
      type: 'agent_end',
      messages: [
        {
          role: 'assistant',
          stopReason: 'error',
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          content: [],
          api: 'openai-chat',
          provider: 'openai',
          model: 'gpt-4o',
          timestamp: Date.now(),
        },
      ],
    });
    const err = (dispatcher.onError as any).mock.calls[0][0];
    expect(err.message).toBe('Agent error');
  });

  // ------------------------------------------------------------------ multiple events in sequence
  it('forwards a full agent lifecycle in order', async () => {
    bridge.start(agent as any);

    await agent.emit({ type: 'agent_start' });
    await agent.emit({
      type: 'message_update',
      message: { role: 'assistant', content: [] },
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Hi', partial: {} },
    });
    await agent.emit({
      type: 'tool_execution_start',
      toolCallId: 'tc-1',
      toolName: 'search',
      args: { q: 'test' },
    });
    await agent.emit({
      type: 'tool_execution_end',
      toolCallId: 'tc-1',
      toolName: 'search',
      result: { content: [], details: null },
      isError: false,
    });
    await agent.emit({
      type: 'message_update',
      message: { role: 'assistant', content: [] },
      assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: '...', partial: {} },
    });
    await agent.emit({
      type: 'agent_end',
      messages: [
        {
          role: 'assistant',
          stopReason: 'stop',
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          content: [],
          api: 'openai-chat',
          provider: 'openai',
          model: 'gpt-4o',
          timestamp: Date.now(),
        },
      ],
    });

    expect(dispatcher.onStart).toHaveBeenCalledTimes(1);
    expect(dispatcher.onTextDelta).toHaveBeenCalledWith('Hi');
    expect(dispatcher.onToolStart).toHaveBeenCalledWith('search', { q: 'test' }, 'tc-1');
    expect(dispatcher.onToolEnd).toHaveBeenCalledWith('search', { content: [], details: null }, false, 'tc-1');
    expect(dispatcher.onReasoningDelta).toHaveBeenCalledWith('...');
    expect(dispatcher.onComplete).toHaveBeenCalledTimes(1);
  });

  it('routes onStart failures through onError instead of throwing', async () => {
    const startError = new Error('placeholder failed');
    dispatcher = createMockDispatcher();
    dispatcher.onStart = vi.fn().mockRejectedValue(startError);
    dispatcher.onError = vi.fn().mockResolvedValue(undefined);
    bridge = new EventBridge(dispatcher);
    bridge.start(agent as any);

    await expect(agent.emit({ type: 'agent_start' })).resolves.toBeUndefined();
    expect(dispatcher.onError).toHaveBeenCalledWith(startError);
  });

  it('swallows onComplete failures after invoking onError', async () => {
    const completeError = new Error('complete failed');
    dispatcher = createMockDispatcher();
    dispatcher.onComplete = vi.fn().mockRejectedValue(completeError);
    dispatcher.onError = vi.fn().mockResolvedValue(undefined);
    bridge = new EventBridge(dispatcher);
    bridge.start(agent as any);

    await expect(agent.emit({ type: 'agent_end', messages: [] })).resolves.toBeUndefined();
    expect(dispatcher.onError).toHaveBeenCalledWith(completeError);
  });
});
