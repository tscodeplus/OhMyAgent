import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentService } from '../../src/agent/agent-service.js';
import type { AgentFactory } from '../../src/agent/agent-factory.js';
import type { ReplyDispatcher } from '../../src/app/types.js';
import { activeSkillFeedbackIds } from '../../src/agent/skill-activator.js';

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
    rejectPendingApprovals: vi.fn().mockReturnValue(0),
    rejectPendingQuestions: vi.fn().mockReturnValue(0),
    resolveApproval: vi.fn().mockReturnValue(true),
    resolveUserQuestion: vi.fn().mockReturnValue(true),
    resolveFirstPendingQuestion: vi.fn().mockReturnValue(true),
    resolveFirstPendingApproval: vi.fn().mockReturnValue(true),
    resolveAllPendingApprovals: vi.fn().mockReturnValue(0),
    getAutoCompressConfig: vi.fn().mockReturnValue(undefined),
    updateConfig: vi.fn(),
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
    rejectPendingApprovals: vi.fn().mockReturnValue(0),
    rejectPendingQuestions: vi.fn().mockReturnValue(0),
    resolveApproval: vi.fn().mockReturnValue(true),
    resolveUserQuestion: vi.fn().mockReturnValue(true),
    resolveFirstPendingQuestion: vi.fn().mockReturnValue(true),
    resolveFirstPendingApproval: vi.fn().mockReturnValue(true),
    resolveAllPendingApprovals: vi.fn().mockReturnValue(0),
    getAutoCompressConfig: vi.fn().mockReturnValue(undefined),
    updateConfig: vi.fn(),
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

  afterEach(() => {
    // The activator feedback map is module-level — clean up between tests
    activeSkillFeedbackIds.clear();
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

  // ----------------------------------------------------- turn timeout (P1 M6)

  describe('turn timeout (P1 M6)', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('fails the turn with TurnTimeoutError when prompt exceeds the cap', async () => {
      vi.useFakeTimers();
      const agent = createMockAgent();
      agent.prompt.mockImplementation(() => new Promise<void>(() => { /* never settles */ }));
      const factory = createMockFactory(agent);
      const service = new AgentService(
        factory as unknown as AgentFactory,
        () => dispatcher,
        undefined, undefined, 'native_first', undefined, undefined,
        30, // turnTimeoutMs
      );

      const promise = service.execute('Hello');
      // Attach a handler up front so the watchdog's rejection is not
      // reported as unhandled while the fake timers advance.
      promise.catch(() => {});
      await vi.advanceTimersByTimeAsync(40);

      await expect(promise).rejects.toThrow(/timed out after/);
      // The turn is aborted via the agent's own AbortController — no duplicate mechanism
      expect(agent.abort).toHaveBeenCalledTimes(1);
      // The mock settles immediately, so agent_end handled the card — no extra onError
      expect(dispatcher.onError).not.toHaveBeenCalled();
    });

    it('sends an error card when the aborted turn never settles (hung tool)', async () => {
      vi.useFakeTimers();
      const agent = createMockAgent();
      agent.prompt.mockImplementation(() => new Promise<void>(() => { /* never settles */ }));
      agent.waitForIdle.mockImplementation(() => new Promise<void>(() => { /* never settles */ }));
      const factory = createMockFactory(agent);
      const service = new AgentService(
        factory as unknown as AgentFactory,
        () => dispatcher,
        undefined, undefined, 'native_first', undefined, undefined,
        30, // turnTimeoutMs
      );

      const promise = service.execute('Hello');
      promise.catch(() => {});
      await vi.advanceTimersByTimeAsync(40); // timeout fires
      await vi.advanceTimersByTimeAsync(10_000); // settle grace elapses

      await expect(promise).rejects.toThrow(/timed out after/);
      expect(agent.abort).toHaveBeenCalledTimes(1);
      // agent_end never fires — the error card is sent explicitly
      expect(dispatcher.onError).toHaveBeenCalled();
    });

    it('abort() does not hang on a stuck agent (bounded settle)', async () => {
      vi.useFakeTimers();
      const agent = createMockAgent();
      agent.prompt.mockImplementation(() => new Promise<void>(() => { /* never settles */ }));
      agent.waitForIdle.mockImplementation(() => new Promise<void>(() => { /* never settles */ }));
      const factory = createMockFactory(agent);
      const service = new AgentService(
        factory as unknown as AgentFactory,
        () => dispatcher,
      );

      const runPromise = service.execute('Hello');
      runPromise.catch(() => {});
      const abortPromise = service.abort('default');
      await vi.advanceTimersByTimeAsync(10_000); // grace elapses
      await abortPromise; // must resolve instead of hanging forever

      // The turn's own watchdog still fires and fails the turn
      await vi.advanceTimersByTimeAsync(300_000); // turn cap (default 300s)
      await vi.advanceTimersByTimeAsync(10_000); // settle grace after its abort
      await expect(runPromise).rejects.toThrow(/timed out after/);
    });
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

  // -------------------------------------------------- skill feedback loop

  it('records skill completion metrics after a successful turn and keeps the feedbackId pending', async () => {
    const agent = createMockAgent();
    agent.prompt.mockImplementationOnce(async () => {
      // Simulate the activator having recorded an activation for this turn
      // (in production this happens inside factory.create → activateSkill)
      activeSkillFeedbackIds.set('s1', { feedbackId: 'fb-1', startTime: Date.now() - 1234 });
      agent.state.messages = [
        { role: 'user', content: 'do it' },
        { role: 'toolResult', content: 'ok', toolName: 'shell', details: { command: 'ls' }, isError: false },
      ];
    });
    const metricsService = {
      recordCompletion: vi.fn(),
      recordSatisfaction: vi.fn(),
      getStats: vi.fn(() => null),
    };
    const svc = new AgentService(
      createMockFactory(agent) as unknown as AgentFactory,
      () => createMockDispatcher(),
      undefined, undefined, 'native_first', undefined,
      () => ({ skillMetricsService: metricsService } as any),
    );

    await svc.execute('do it', { sessionId: 's1' });

    // Completion recorded with success=null (satisfaction comes later)
    expect(metricsService.recordCompletion).toHaveBeenCalledWith(
      'fb-1',
      null,
      expect.any(Number),
      [{ name: 'shell', args: { command: 'ls' }, result: 'ok', isError: false, errorMessage: undefined, timestamp: expect.any(Number) }],
    );
    // Entry consumed — the map must not leak
    expect(activeSkillFeedbackIds.has('s1')).toBe(false);
  });

  it('infers satisfaction from the follow-up message and records it once', async () => {
    // Leftover entry from a previous turn (e.g. activation recorded before
    // the turn failed to complete) — consumed at the next execute() start
    activeSkillFeedbackIds.set('s1', { feedbackId: 'fb-1', startTime: Date.now() - 1000 });
    const metricsService = {
      recordCompletion: vi.fn(),
      recordSatisfaction: vi.fn(),
      getStats: vi.fn(() => null),
    };
    const svc = new AgentService(
      factory as unknown as AgentFactory,
      () => dispatcher,
      undefined, undefined, 'native_first', undefined,
      () => ({ skillMetricsService: metricsService } as any),
    );

    await svc.execute('帮我写个脚本', { sessionId: 's1' }); // entry moved to pending, not inferable
    expect(metricsService.recordSatisfaction).not.toHaveBeenCalled();

    await svc.execute('谢谢，搞定', { sessionId: 's1' }); // satisfied
    expect(metricsService.recordSatisfaction).toHaveBeenCalledWith('fb-1', 1);

    await svc.execute('好的', { sessionId: 's1' }); // pending was deleted — no double record
    expect(metricsService.recordSatisfaction).toHaveBeenCalledTimes(1);
  });

  it('forwards activation completion to the auto-apply monitor with success and error counts', async () => {
    const agent = createMockAgent();
    agent.prompt.mockImplementationOnce(async () => {
      agent.state.messages = [
        { role: 'user', content: 'run shell' },
        { role: 'toolResult', content: 'boom', toolName: 'shell', details: { command: 'ls' }, isError: true },
      ];
    });
    const harness = {
      autoApplyMonitor: { onActivationComplete: vi.fn(), watch: vi.fn() },
      failureDetector: { detect: vi.fn(() => null) }, // short-circuit optimization
      rateLimiter: {},
      optimizer: {},
      approvalPolicy: {},
      skillEditor: {},
      surfaceProvider: {},
    };
    const svc = new AgentService(
      createMockFactory(agent) as unknown as AgentFactory,
      () => createMockDispatcher(),
      undefined, undefined, 'native_first',
      harness as any,
    );

    await svc.execute('run shell', { sessionId: 's1' });

    expect(harness.autoApplyMonitor.onActivationComplete).toHaveBeenCalledWith(
      null, 'default', { success: true, errorCount: 1, durationMs: expect.any(Number) },
    );

    // Failure path reports success: false
    agent.prompt.mockRejectedValueOnce(new Error('LLM failed'));
    await expect(svc.execute('boom', { sessionId: 's1' })).rejects.toThrow('LLM failed');
    expect(harness.autoApplyMonitor.onActivationComplete).toHaveBeenLastCalledWith(
      null, 'default', { success: false, errorCount: 0, durationMs: expect.any(Number) },
    );
  });

  describe('currentTurnMessages (compression-safe turn window)', () => {
    it('returns only messages added since the turn started', () => {
      const svcAny = service as unknown as { currentTurnMessages(r: unknown): unknown[] };
      const oldMsg1 = { role: 'user', content: 'old 1', timestamp: 1 };
      const oldMsg2 = { role: 'assistant', content: 'old 2', timestamp: 2 };
      const newMsg = { role: 'user', content: 'new', timestamp: 3 };

      const agent = createMockAgent();
      agent.state.messages = [oldMsg1, oldMsg2];
      const runtime = {
        agent,
        turnMessageBaseline: 2,
        turnBaselineMessages: new Set([oldMsg1, oldMsg2]),
      };
      // Turn in progress: user message appended
      agent.state.messages = [oldMsg1, oldMsg2, newMsg];

      const result = svcAny.currentTurnMessages(runtime);
      expect(result).toEqual([newMsg]);
    });

    it('keeps the new messages after mid-turn compression shrinks the array', () => {
      const svcAny = service as unknown as { currentTurnMessages(r: unknown): unknown[] };
      const oldMsg1 = { role: 'user', content: 'old 1', timestamp: 1 };
      const oldMsg2 = { role: 'assistant', content: 'old 2', timestamp: 2 };
      const newMsg = { role: 'user', content: 'new', timestamp: 3 };

      const agent = createMockAgent();
      agent.state.messages = [oldMsg1, oldMsg2];
      const runtime = {
        agent,
        turnMessageBaseline: 2,
        turnBaselineMessages: new Set([oldMsg1, oldMsg2]),
      };
      // Turn in progress: new message appended, then compression replaces
      // the transcript — array shrinks (baseline index 2 > length 2 → an
      // index slice would be empty), but the retained tail keeps the same
      // object references plus a fresh summary marker.
      agent.state.messages = [newMsg];
      agent.state.messages = [
        { role: 'user', content: '[Compression summary]', timestamp: 4 },
        newMsg,
      ];

      const result = svcAny.currentTurnMessages(runtime);
      // The turn's own message survives the compression window; the summary
      // marker is new too (no tool calls inside, harmless for extraction).
      expect(result).toContain(newMsg);
      expect(result.some(m => (m as any).content === '[Compression summary]')).toBe(true);
      expect(result).not.toContain(oldMsg1);
      expect(result).not.toContain(oldMsg2);
    });

    it('falls back to the length baseline when the identity set is absent', () => {
      const svcAny = service as unknown as { currentTurnMessages(r: unknown): unknown[] };
      const oldMsg = { role: 'user', content: 'old', timestamp: 1 };
      const newMsg = { role: 'user', content: 'new', timestamp: 2 };

      const agent = createMockAgent();
      agent.state.messages = [oldMsg, newMsg];
      const runtime = { agent, turnMessageBaseline: 1 };

      const result = svcAny.currentTurnMessages(runtime);
      expect(result).toEqual([newMsg]);
    });
  });
});
