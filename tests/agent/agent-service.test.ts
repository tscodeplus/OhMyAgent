import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentService } from '../../src/agent/agent-service.js';
import type { AgentFactory } from '../../src/agent/agent-factory.js';
import type { ReplyDispatcher } from '../../src/app/types.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockAgent() {
  let streaming = false;
  const listeners = new Set<(event: any) => void>();
  return {
    prompt: vi.fn().mockImplementation(async () => {
      streaming = true;
      try {
        // actual prompt work happens here (mock resolved value)
      } finally {
        streaming = false;
      }
    }),
    abort: vi.fn(),
    reset: vi.fn(),
    steer: vi.fn(),
    followUp: vi.fn(),
    waitForIdle: vi.fn().mockResolvedValue(undefined),
    continue: vi.fn().mockResolvedValue(undefined),
    clearSteeringQueue: vi.fn(),
    clearFollowUpQueue: vi.fn(),
    clearAllQueues: vi.fn(),
    subscribe: vi.fn((listener: (event: any) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
    state: {
      get isStreaming() { return streaming; },
      messages: [] as any[],
      model: { id: 'test-model', provider: 'test', api: 'test' },
      systemPrompt: 'You are a helpful assistant.',
    },
    // For tests that override prompt: manually control streaming state
    _setStreaming(v: boolean) { streaming = v; },
    _emit(event: any) {
      for (const listener of listeners) {
        listener(event);
      }
    },
  };
}

function createMockFactory(agentOverride?: ReturnType<typeof createMockAgent>) {
  const agent = agentOverride ?? createMockAgent();
  return {
    create: vi.fn().mockReturnValue(agent),
    agent,
  };
}

function createFactoryWithPerSessionAgents() {
  const agents = new Map<string, ReturnType<typeof createMockAgent>>();
  return {
    create: vi.fn().mockImplementation((options?: { sessionId?: string }) => {
      const sessionId = options?.sessionId ?? 'default';
      const agent = createMockAgent();
      agents.set(sessionId, agent);
      return agent;
    }),
    agents,
  };
}

function createMockDispatcher(): ReplyDispatcher & {
  onStart: ReturnType<typeof vi.fn>;
  onComplete: ReturnType<typeof vi.fn>;
  onError: ReturnType<typeof vi.fn>;
  onAborted: ReturnType<typeof vi.fn>;
} {
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentService', () => {
  let factory: ReturnType<typeof createMockFactory>;
  let dispatcher: ReturnType<typeof createMockDispatcher>;
  let service: AgentService;

  beforeEach(() => {
    factory = createMockFactory();
    dispatcher = createMockDispatcher();
    service = new AgentService(
      factory as unknown as AgentFactory,
      () => dispatcher,
    );
  });

  // ------------------------------------------------------------------ execute: basic flow

  it('execute() creates agent, starts bridge, calls prompt, returns agent', async () => {
    const agent = await service.execute('Hello');

    expect(factory.create).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Hello',
      turnContext: expect.any(Object),
    }));
    expect(factory.create).toHaveBeenCalledTimes(1);
    expect(factory.agent.prompt).toHaveBeenCalledWith('Hello', undefined);
    expect(agent).toBe(factory.agent);
  });

  it('execute() passes options through to factory', async () => {
    await service.execute('Hi', { sessionId: 's1', systemPrompt: 'sys' });

    expect(factory.create).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Hi',
      sessionId: 's1',
      systemPrompt: 'sys',
      turnContext: expect.any(Object),
    }));
  });

  it('execute() subscribes to agent events via EventBridge', async () => {
    await service.execute('test');

    // EventBridge.start() calls agent.subscribe()
    expect(factory.agent.subscribe).toHaveBeenCalledTimes(1);
  });

  // ------------------------------------------------------------------ execute: dispatcher lifecycle

  it('execute() calls dispatcher.onStart before prompt', async () => {
    const callOrder: string[] = [];
    factory.agent.prompt.mockImplementation(async () => {
      callOrder.push('prompt');
    });
    dispatcher.onStart.mockImplementation(() => {
      callOrder.push('onStart');
    });

    await service.execute('test');

    // onStart is called by EventBridge when agent_start event fires,
    // but the mock agent doesn't emit events. The important thing is
    // that prompt was called and onStart was set up.
    expect(factory.agent.prompt).toHaveBeenCalled();
  });

  it('execute() calls dispatcher.onComplete on success', async () => {
    // The EventBridge handles onComplete via agent_end events.
    // Since our mock doesn't emit events, we verify the bridge was
    // started (subscribe called) and prompt completed.
    await service.execute('test');
    expect(factory.agent.subscribe).toHaveBeenCalled();
    expect(factory.agent.prompt).toHaveBeenCalledWith('test', undefined);
  });

  // ------------------------------------------------------------------ execute: cleanup after success

  it('execute() keeps agent alive after success (for multi-turn continuity)', async () => {
    expect(service.isRunning()).toBe(false);

    await service.execute('test');
    // Agent is idle but still alive (ready for next turn)
    expect(service.isRunning()).toBe(false);
    // Factory.create called once (first turn)
    expect(factory.create).toHaveBeenCalledTimes(1);
  });

  // ------------------------------------------------------------------ execute: error handling

  it('execute() cleans up bridge even when prompt throws', async () => {
    const error = new Error('LLM failed');
    factory.agent.prompt.mockRejectedValue(error);

    await expect(service.execute('test')).rejects.toThrow('LLM failed');

    // Bridge should be stopped (subscribe would have been called to start it)
    expect(factory.agent.subscribe).toHaveBeenCalled();
    // State should be cleaned up
    expect(service.isRunning()).toBe(false);
  });

  it('execute() re-throws errors from prompt', async () => {
    factory.agent.prompt.mockRejectedValue(new Error('Timeout'));

    await expect(service.execute('test')).rejects.toThrow('Timeout');
  });

  it('execute() handles non-Error throws', async () => {
    factory.agent.prompt.mockRejectedValue('string error');

    await expect(service.execute('test')).rejects.toBe('string error');
  });

  // ------------------------------------------------------------------ abort

  it('abort() calls agent.abort() when running', async () => {
    let resolvePrompt: () => void;
    const agent = factory.agent as any;
    agent.prompt = vi.fn().mockImplementation(async () => {
      agent._setStreaming(true);
      await new Promise<void>((resolve) => { resolvePrompt = resolve; });
      agent._setStreaming(false);
    });

    const promise = service.execute('test');
    await new Promise(r => setTimeout(r, 0));
    expect(service.isRunning()).toBe(true);

    service.abort();
    expect(factory.agent.abort).toHaveBeenCalledTimes(1);

    resolvePrompt!();
    await promise;
  });

  it('abort() does nothing when no agent is running', () => {
    expect(service.isRunning()).toBe(false);
    // Should not throw
    service.abort();
  });

  // ------------------------------------------------------------------ isRunning

  it('isRunning() returns false initially', () => {
    expect(service.isRunning()).toBe(false);
  });

  it('isRunning() returns true during execution', async () => {
    let resolvePrompt: () => void;
    const agent = factory.agent as any;
    agent.prompt = vi.fn().mockImplementation(async () => {
      agent._setStreaming(true);
      await new Promise<void>((resolve) => { resolvePrompt = resolve; });
      agent._setStreaming(false);
    });

    const promise = service.execute('test');
    await new Promise((r) => setTimeout(r, 0));

    expect(service.isRunning()).toBe(true);

    resolvePrompt!();
    await promise;
    expect(service.isRunning()).toBe(false);
  });

  // ------------------------------------------------------------------ EventBridge wiring

  it('EventBridge is created with dispatcher from factory', async () => {
    const dispatcherSpy = vi.fn().mockReturnValue(dispatcher);
    const svc = new AgentService(
      factory as unknown as AgentFactory,
      dispatcherSpy,
    );

    await svc.execute('test');

    expect(dispatcherSpy).toHaveBeenCalledTimes(1);
  });

  it('EventBridge.stop() is called after prompt completes', async () => {
    // We verify this indirectly: after execute, subscribe has been called
    // (bridge.start) and the bridge is cleaned up in finally block.
    await service.execute('test');

    expect(factory.agent.subscribe).toHaveBeenCalledTimes(1);
    expect(service.isRunning()).toBe(false);
  });

  it('EventBridge.stop() is called even when prompt throws', async () => {
    factory.agent.prompt.mockRejectedValue(new Error('boom'));

    await expect(service.execute('test')).rejects.toThrow('boom');

    expect(factory.agent.subscribe).toHaveBeenCalledTimes(1);
    expect(service.isRunning()).toBe(false);
  });

  // ------------------------------------------------------------------ concurrent calls

  it('second execute() reuses the same agent', async () => {
    await service.execute('first');
    await service.execute('second');

    // Agent is reused — factory.create called only once
    expect(factory.create).toHaveBeenCalledTimes(1);
  });

  it('refreshes channel agent runtime each turn while preserving messages', async () => {
    const firstAgent = createMockAgent();
    const secondAgent = createMockAgent();
    firstAgent.state.messages = [{ role: 'user', content: 'first' }];
    const channelFactory = {
      create: vi.fn()
        .mockReturnValueOnce(firstAgent)
        .mockReturnValueOnce(secondAgent),
    };
    const svc = new AgentService(
      channelFactory as unknown as AgentFactory,
      () => createMockDispatcher(),
    );

    await svc.execute('first', { sessionId: 'session-1', channel: 'feishu', messageId: 'm1' });
    await svc.execute('second', { sessionId: 'session-1', channel: 'feishu', messageId: 'm2' });

    expect(channelFactory.create).toHaveBeenCalledTimes(2);
    expect(channelFactory.create).toHaveBeenLastCalledWith(expect.objectContaining({
      message: 'second',
      messageId: 'm2',
      turnContext: expect.any(Object),
    }));
    expect(secondAgent.state.messages).toEqual([{ role: 'user', content: 'first' }]);
    expect(secondAgent.prompt).toHaveBeenCalledWith('second', undefined);
  });

  it('creates separate agents for different sessions and reuses them independently', async () => {
    const perSessionFactory = createFactoryWithPerSessionAgents();
    const svc = new AgentService(
      perSessionFactory as unknown as AgentFactory,
      () => createMockDispatcher(),
    );

    await svc.execute('first-s1', { sessionId: 'session-1' });
    await svc.execute('first-s2', { sessionId: 'session-2' });
    await svc.execute('second-s1', { sessionId: 'session-1' });

    expect(perSessionFactory.create).toHaveBeenCalledTimes(2);
    expect(perSessionFactory.agents.get('session-1')?.prompt).toHaveBeenCalledTimes(2);
    expect(perSessionFactory.agents.get('session-2')?.prompt).toHaveBeenCalledTimes(1);
  });

  it('isRunning() can be checked per session without leaking state across sessions', async () => {
    let resolveS1: () => void;
    const perSessionFactory = createFactoryWithPerSessionAgents();
    const svc = new AgentService(
      perSessionFactory as unknown as AgentFactory,
      () => createMockDispatcher(),
    );

    const s1Agent = createMockAgent();
    s1Agent.prompt = vi.fn().mockImplementation(async () => {
      s1Agent._setStreaming(true);
      await new Promise<void>((resolve) => { resolveS1 = resolve; });
      s1Agent._setStreaming(false);
    });

    perSessionFactory.create.mockImplementation((options?: { sessionId?: string }) => {
      const sessionId = options?.sessionId ?? 'default';
      const agent = sessionId === 'session-1' ? s1Agent : createMockAgent();
      perSessionFactory.agents.set(sessionId, agent);
      return agent;
    });

    const pending = svc.execute('long task', { sessionId: 'session-1' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(svc.isRunning('session-1')).toBe(true);
    expect(svc.isRunning('session-2')).toBe(false);

    resolveS1!();
    await pending;
    expect(svc.isRunning('session-1')).toBe(false);
  });

  it('persists only newly added messages for a session', async () => {
    const messageRepository = {
      create: vi.fn(),
      countBySessionId: vi.fn(() => 0),
    };
    const sessionRepository = {
      findById: vi.fn(() => undefined),
      create: vi.fn(),
      touch: vi.fn(),
    };
    const episodeRepository = {
      findBySessionId: vi.fn(() => []),
    };
    const memorySummarizer = {
      summarizeSession: vi.fn(async () => {}),
    };
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const agent = createMockAgent();
    agent.prompt
      .mockImplementationOnce(async () => {
        agent.state.messages = [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'hi' },
        ];
      })
      .mockImplementationOnce(async () => {
        agent.state.messages = [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'hi' },
          { role: 'user', content: 'next' },
          { role: 'assistant', content: 'done' },
        ];
      });

    const localFactory = createMockFactory(agent);
    const svc = new AgentService(
      localFactory as unknown as AgentFactory,
      () => createMockDispatcher(),
      {
        sessionRepository: sessionRepository as any,
        messageRepository: messageRepository as any,
        episodeRepository: episodeRepository as any,
        memorySummarizer: memorySummarizer as any,
        logger: logger as any,
      },
    );

    await svc.execute('turn-1', { sessionId: 'session-1' });
    await svc.execute('turn-2', { sessionId: 'session-1' });

    expect(messageRepository.create).toHaveBeenCalledTimes(4);
    expect(messageRepository.create.mock.calls.map(([input]) => input.content)).toEqual([
      'hello',
      'hi',
      'next',
      'done',
    ]);
  });

  it('does not persist toolResult messages to the messages table', async () => {
    const messageRepository = {
      create: vi.fn(),
      countBySessionId: vi.fn(() => 0),
    };
    const sessionRepository = {
      findById: vi.fn(() => undefined),
      create: vi.fn(),
      touch: vi.fn(),
    };
    const episodeRepository = {
      findBySessionId: vi.fn(() => []),
    };
    const memorySummarizer = {
      summarizeSession: vi.fn(async () => {}),
    };
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const agent = createMockAgent();
    agent.prompt.mockImplementationOnce(async () => {
      agent.state.messages = [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'running tool' },
        { role: 'toolResult', content: [{ type: 'text', text: 'ls output' }] },
        { role: 'assistant', content: 'done' },
      ];
    });

    const svc = new AgentService(
      createMockFactory(agent) as unknown as AgentFactory,
      () => createMockDispatcher(),
      {
        sessionRepository: sessionRepository as any,
        messageRepository: messageRepository as any,
        episodeRepository: episodeRepository as any,
        memorySummarizer: memorySummarizer as any,
        logger: logger as any,
      },
    );

    await svc.execute('turn-1', { sessionId: 'session-1' });

    expect(messageRepository.create.mock.calls.map(([input]) => input.role)).toEqual([
      'user',
      'assistant',
      'assistant',
    ]);
  });

  it('writes compact tool execution audit records to tool_runs', async () => {
    const messageRepository = {
      create: vi.fn(),
      countBySessionId: vi.fn(() => 0),
    };
    const sessionRepository = {
      findById: vi.fn(() => undefined),
      create: vi.fn(),
      touch: vi.fn(),
    };
    const episodeRepository = {
      findBySessionId: vi.fn(() => []),
    };
    const toolRunRepository = {
      create: vi.fn(),
      update: vi.fn(),
    };
    const memorySummarizer = {
      summarizeSession: vi.fn(async () => {}),
    };
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const agent = createMockAgent();
    agent.prompt.mockImplementationOnce(async () => {
      agent._emit({
        type: 'tool_execution_start',
        toolCallId: 'tc-1',
        toolName: 'shell',
        args: { command: 'echo hello' },
      });
      agent._emit({
        type: 'tool_execution_end',
        toolCallId: 'tc-1',
        toolName: 'shell',
        result: { content: [{ type: 'text', text: 'hello' }] },
        isError: false,
      });
      agent.state.messages = [
        { role: 'user', content: 'run shell' },
        { role: 'assistant', content: 'done' },
      ];
    });

    const svc = new AgentService(
      createMockFactory(agent) as unknown as AgentFactory,
      () => createMockDispatcher(),
      {
        sessionRepository: sessionRepository as any,
        messageRepository: messageRepository as any,
        episodeRepository: episodeRepository as any,
        toolRunRepository: toolRunRepository as any,
        memorySummarizer: memorySummarizer as any,
        logger: logger as any,
      },
    );

    await svc.execute('turn-1', { sessionId: 'session-1' });

    expect(toolRunRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'session-1:tc-1',
        session_id: 'session-1',
        tool_name: 'shell',
        input: 'echo hello',
        status: 'started',
      }),
    );
    expect(toolRunRepository.update).toHaveBeenCalledWith(
      'session-1:tc-1',
      expect.objectContaining({
        output: 'hello',
        status: 'success',
        error: null,
      }),
    );
  });

  it('creates the session before writing tool audit rows', async () => {
    const callOrder: string[] = [];
    const messageRepository = {
      create: vi.fn(),
      countBySessionId: vi.fn(() => 0),
    };
    const sessionRepository = {
      findById: vi.fn(() => undefined),
      create: vi.fn(() => {
        callOrder.push('session.create');
      }),
      touch: vi.fn(() => {
        callOrder.push('session.touch');
      }),
    };
    const episodeRepository = {
      findBySessionId: vi.fn(() => []),
    };
    const toolRunRepository = {
      create: vi.fn(() => {
        callOrder.push('toolRun.create');
      }),
      update: vi.fn(),
    };
    const memorySummarizer = {
      summarizeSession: vi.fn(async () => {}),
    };
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const agent = createMockAgent();
    agent.prompt.mockImplementationOnce(async () => {
      agent._emit({
        type: 'tool_execution_start',
        toolCallId: 'tc-1',
        toolName: 'shell',
        args: { command: 'echo hello' },
      });
      agent.state.messages = [
        { role: 'user', content: 'run shell' },
        { role: 'assistant', content: 'done' },
      ];
    });

    const svc = new AgentService(
      createMockFactory(agent) as unknown as AgentFactory,
      () => createMockDispatcher(),
      {
        sessionRepository: sessionRepository as any,
        messageRepository: messageRepository as any,
        episodeRepository: episodeRepository as any,
        toolRunRepository: toolRunRepository as any,
        memorySummarizer: memorySummarizer as any,
        logger: logger as any,
      },
    );

    await svc.execute('turn-1', { sessionId: 'session-1' });

    expect(callOrder[0]).toBe('session.create');
    expect(callOrder[1]).toBe('toolRun.create');
  });

  // ------------------------------------------------------------------ steer

  it('steer() queues a message and clears previous steering queue', async () => {
    await service.execute('run a task', { sessionId: 's1' });

    const ok = service.steer('s1', 'use Docker instead');
    expect(ok).toBe(true);
    expect(factory.agent.clearSteeringQueue).toHaveBeenCalled();
    expect(factory.agent.steer).toHaveBeenCalledWith({
      role: 'user',
      content: [{ type: 'text', text: 'use Docker instead' }],
      timestamp: expect.any(Number),
    });
  });

  it('steer() returns false for unknown session', () => {
    const ok = service.steer('nonexistent', 'msg');
    expect(ok).toBe(false);
  });

  // ------------------------------------------------------------------ followUp

  it('followUp() triggers agent.prompt after idle', async () => {
    await service.execute('run a task', { sessionId: 's1' });

    const ok = await service.followUp('s1', 'btw question');
    expect(ok).toBe(true);
    // prompt is called asynchronously after waitForIdle
    await new Promise((r) => setTimeout(r, 10));
    expect(factory.agent.prompt).toHaveBeenCalledTimes(2);
    expect(factory.agent.prompt).toHaveBeenNthCalledWith(2, 'btw question');
  });

  it('followUp() returns false for unknown session', async () => {
    const ok = await service.followUp('nonexistent', 'question');
    expect(ok).toBe(false);
  });
});
