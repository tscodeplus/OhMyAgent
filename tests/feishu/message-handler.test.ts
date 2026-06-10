import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageHandler } from '../../extensions/channel-feishu/message-handler.js';
import type { FeishuMessageContext } from '../../extensions/channel-feishu/feishu-context.js';

describe('MessageHandler', () => {
  let handler: MessageHandler;
  let mockAgentService: {
    execute: ReturnType<typeof vi.fn>;
    abort: ReturnType<typeof vi.fn>;
    isRunning: ReturnType<typeof vi.fn>;
    reset: ReturnType<typeof vi.fn>;
    destroyRuntime: ReturnType<typeof vi.fn>;
    rejectPendingApprovals: ReturnType<typeof vi.fn>;
    steer: ReturnType<typeof vi.fn>;
    followUp: ReturnType<typeof vi.fn>;
    swapCard: ReturnType<typeof vi.fn>;
    onNextAgentEnd: ReturnType<typeof vi.fn>;
  };
  let mockChatQueue: { enqueue: ReturnType<typeof vi.fn> };
  let mockReplyDispatcherFactory: ReturnType<typeof vi.fn>;
  let mockDispatcher: any;

  function makeContext(overrides: Partial<FeishuMessageContext> = {}): FeishuMessageContext {
    return {
      chatId: 'chat-123',
      messageId: 'msg-1',
      senderId: 'user-1',
      text: 'Hello, agent!',
      chatType: 'p2p',
      sessionKey: 'chat-123',
      rawEvent: {},
      messageType: 'text',
      rawContent: '{"text":"Hello, agent!"}',
      resources: [],
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();

    mockDispatcher = {
      onStart: vi.fn(),
      onTextDelta: vi.fn(),
      onComplete: vi.fn(),
      onError: vi.fn(),
    };

    mockAgentService = {
      execute: vi.fn().mockResolvedValue({}),
      abort: vi.fn(),
      isRunning: vi.fn(() => false),
      reset: vi.fn(() => true),
      destroyRuntime: vi.fn(() => true),
      rejectPendingApprovals: vi.fn(() => 0),
      steer: vi.fn(() => true),
      followUp: vi.fn(async () => true),
      swapCard: vi.fn(async () => true),
      onNextAgentEnd: vi.fn(),
    };

    // Mock ChatQueue.enqueue to mimic the real behavior:
    // it catches task errors so they don't propagate to the caller.
    mockChatQueue = {
      enqueue: vi.fn().mockImplementation(async (_key: string, task: () => Promise<void>) => {
        try {
          await task();
        } catch {
          // Real ChatQueue swallows task errors
        }
      }),
    };

    mockReplyDispatcherFactory = vi.fn().mockReturnValue(mockDispatcher);

    handler = new MessageHandler({
      agentService: mockAgentService,
      chatQueue: mockChatQueue,
      commandDeps: {
        agentService: mockAgentService,
      },
      sendTextReply: vi.fn(async () => {}),
    });
  });

  describe('handle', () => {
    it('should enqueue a task in ChatQueue with the session key', async () => {
      const context = makeContext({ sessionKey: 'session-abc' });
      await handler.handle(context);

      expect(mockChatQueue.enqueue).toHaveBeenCalledOnce();
      expect(mockChatQueue.enqueue).toHaveBeenCalledWith('session-abc', expect.any(Function));
    });

    it('should call agentService.execute with the message text and context fields', async () => {
      const context = makeContext({ text: 'test message', sessionKey: 'sess-1' });
      await handler.handle(context);

      expect(mockAgentService.execute).toHaveBeenCalledOnce();
      expect(mockAgentService.execute).toHaveBeenCalledWith('test message', {
        sessionId: 'sess-1',
        chatId: 'chat-123',
        messageId: 'msg-1',
        channel: 'feishu',
        extraTools: [],
      });
    });

    it('should pass chatId and messageId to agentService.execute', async () => {
      const context = makeContext({ chatId: 'chat-456', messageId: 'msg-456', sessionKey: 'session-xyz' });
      await handler.handle(context);

      expect(mockAgentService.execute).toHaveBeenCalledWith(
        'Hello, agent!',
        {
          sessionId: 'session-xyz',
          chatId: 'chat-456',
          messageId: 'msg-456',
          channel: 'feishu',
          extraTools: [],
        },
      );
    });

    it('should handle errors in agent execution gracefully', async () => {
      mockAgentService.execute.mockRejectedValue(new Error('Agent failed'));

      const context = makeContext();
      // The ChatQueue swallows errors, so this should not throw
      await handler.handle(context);

      expect(mockAgentService.execute).toHaveBeenCalledOnce();
    });

    it('should use the session key from context for queueing', async () => {
      const context = makeContext({ sessionKey: 'group-chat:thread-789' });
      await handler.handle(context);

      expect(mockChatQueue.enqueue).toHaveBeenCalledWith(
        'group-chat:thread-789',
        expect.any(Function),
      );
    });

    it('should pass through the text from context to agentService', async () => {
      const context = makeContext({ text: 'What is the weather today?' });
      await handler.handle(context);

      expect(mockAgentService.execute).toHaveBeenCalledWith(
        'What is the weather today?',
        expect.any(Object),
      );
    });
  });
});
