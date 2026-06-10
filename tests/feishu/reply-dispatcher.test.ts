import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReplyDispatcher } from '../../extensions/channel-feishu/render/reply-dispatcher.js';

// ─── Mock StreamingCardController ───

vi.mock('../../extensions/channel-feishu/render/streaming-card-controller.js', () => {
  return {
    StreamingCardController: vi.fn().mockImplementation(() => ({
      createPlaceholder: vi.fn().mockResolvedValue(undefined),
      appendDelta: vi.fn(),
      markToolRunning: vi.fn(),
      markToolComplete: vi.fn(),
      setApprovalStatus: vi.fn(),
      setApprovalRecords: vi.fn(),
      getMessageId: vi.fn().mockReturnValue('reply-msg-1'),
      complete: vi.fn().mockResolvedValue(undefined),
      fail: vi.fn(),
      getState: vi.fn().mockReturnValue('idle'),
    })),
  };
});

describe('ReplyDispatcher', () => {
  let dispatcher: ReplyDispatcher;
  let mockController: any;

  const mockFeishuClient = {
    createCard: vi.fn(),
    sendCardByCardId: vi.fn(),
    streamCardContent: vi.fn(),
    setCardStreamingMode: vi.fn(),
    updateCard: vi.fn(),
    addReaction: vi.fn().mockResolvedValue('reaction-1'),
    removeReaction: vi.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    vi.clearAllMocks();

    dispatcher = new ReplyDispatcher({
      feishuClient: mockFeishuClient,
      chatId: 'test-chat-id',
    });

    // Access the mocked controller instance
    const { StreamingCardController } = await import(
      '../../extensions/channel-feishu/render/streaming-card-controller.js'
    );
    mockController = (StreamingCardController as any).mock.results[0].value;
  });

  it('should create a StreamingCardController on construction', async () => {
    const { StreamingCardController } = await import(
      '../../extensions/channel-feishu/render/streaming-card-controller.js'
    );
    expect(StreamingCardController).toHaveBeenCalledWith({
      feishuClient: mockFeishuClient,
      chatId: 'test-chat-id',
    });
  });

  describe('onStart', () => {
    it('should call controller.createPlaceholder', async () => {
      await dispatcher.onStart();
      expect(mockController.createPlaceholder).toHaveBeenCalledOnce();
    });

    it('should add a typing reaction when messageId is provided', async () => {
      dispatcher = new ReplyDispatcher({
        feishuClient: mockFeishuClient,
        chatId: 'test-chat-id',
        messageId: 'msg-123',
      });

      const { StreamingCardController } = await import(
        '../../extensions/channel-feishu/render/streaming-card-controller.js'
      );
      mockController = (StreamingCardController as any).mock.results.at(-1).value;

      await dispatcher.onStart();
      expect(mockFeishuClient.addReaction).toHaveBeenCalledWith('msg-123', 'Typing');
      expect(mockController.createPlaceholder).toHaveBeenCalledOnce();
    });
  });

  describe('onTextDelta', () => {
    it('should call controller.appendDelta with the delta', () => {
      dispatcher.onTextDelta('Hello, ');
      expect(mockController.appendDelta).toHaveBeenCalledWith('Hello, ');
    });

    it('should call controller.appendDelta for each delta', () => {
      dispatcher.onTextDelta('Hello');
      dispatcher.onTextDelta(' World');
      expect(mockController.appendDelta).toHaveBeenCalledTimes(2);
      expect(mockController.appendDelta).toHaveBeenNthCalledWith(1, 'Hello');
      expect(mockController.appendDelta).toHaveBeenNthCalledWith(2, ' World');
    });
  });

  describe('onReasoningDelta', () => {
    it('is a no-op (reasoning is not rendered in streaming cards)', () => {
      dispatcher.onReasoningDelta('reasoning content');
      expect(mockController.appendDelta).not.toHaveBeenCalled();
    });
  });

  describe('onToolStart', () => {
    it('should call controller.markToolRunning with name, args and toolCallId', () => {
      dispatcher.onToolStart('shell', { command: 'ls' });
      expect(mockController.markToolRunning).toHaveBeenCalledWith(
        'shell',
        { command: 'ls' },
        undefined,
      );
    });

    it('forwards the toolCallId when provided', () => {
      dispatcher.onToolStart('web_search', { query: 'test' }, 'call-1');
      expect(mockController.markToolRunning).toHaveBeenCalledWith(
        'web_search',
        { query: 'test' },
        'call-1',
      );
    });
  });

  describe('onToolEnd', () => {
    it('should call controller.markToolComplete with the tool name', () => {
      dispatcher.onToolEnd('shell', { output: 'done' });
      expect(mockController.markToolComplete).toHaveBeenCalledWith('shell', undefined);
    });

    it('should not pass result to the controller', () => {
      dispatcher.onToolEnd('web_search', { results: [] });
      expect(mockController.markToolComplete).toHaveBeenCalledWith('web_search', undefined);
    });
  });

  describe('setApprovalStatus', () => {
    it('is a no-op (feishu approval cards are standalone, not embedded)', () => {
      dispatcher.setApprovalStatus('等待 1 项审批');
      expect(mockController.setApprovalStatus).not.toHaveBeenCalled();
    });
  });

  describe('approval history helpers', () => {
    it('setApprovalRecords is a no-op for feishu standalone cards', () => {
      dispatcher.setApprovalRecords([
        {
          requestId: 'req-1',
          command: 'rm /tmp/1.txt',
          risk: 'high',
          status: 'approved',
          decision: 'approve_once',
          updatedAt: 1,
        },
      ], true);
      expect(mockController.setApprovalRecords).not.toHaveBeenCalled();
    });

    it('should expose reply message id from controller', () => {
      expect(dispatcher.getReplyMessageId()).toBe('reply-msg-1');
    });
  });

  describe('onComplete', () => {
    it('should call controller.complete', async () => {
      await dispatcher.onComplete();
      expect(mockController.complete).toHaveBeenCalledOnce();
    });

    it('should call controller.complete even with usage data', async () => {
      await dispatcher.onComplete({ input: 100, output: 50 });
      expect(mockController.complete).toHaveBeenCalledOnce();
    });
  });

  describe('onError', () => {
    it('should call controller.fail with error message for Error objects', async () => {
      const error = new Error('something went wrong');
      await dispatcher.onError(error);
      expect(mockController.fail).toHaveBeenCalledWith('something went wrong');
    });

    it('should call controller.fail with String(error) for non-Error values', async () => {
      await dispatcher.onError('string error');
      expect(mockController.fail).toHaveBeenCalledWith('string error');
    });

    it('should handle numeric errors', async () => {
      await dispatcher.onError(42);
      expect(mockController.fail).toHaveBeenCalledWith('42');
    });

    it('removes the typing reaction during error cleanup', async () => {
      dispatcher = new ReplyDispatcher({
        feishuClient: mockFeishuClient,
        chatId: 'test-chat-id',
        messageId: 'msg-123',
      });

      const { StreamingCardController } = await import(
        '../../extensions/channel-feishu/render/streaming-card-controller.js'
      );
      mockController = (StreamingCardController as any).mock.results.at(-1).value;

      await dispatcher.onStart();
      await dispatcher.onError(new Error('boom'));
      expect(mockFeishuClient.removeReaction).toHaveBeenCalledWith('msg-123', 'reaction-1');
    });
  });

  describe('getState', () => {
    it('should return the controller state', () => {
      mockController.getState.mockReturnValue('streaming');
      expect(dispatcher.getState()).toBe('streaming');
    });
  });

  describe('full lifecycle', () => {
    it('should follow onStart -> onTextDelta -> onComplete flow', async () => {
      await dispatcher.onStart();
      dispatcher.onTextDelta('Hello');
      dispatcher.onTextDelta(' World');
      await dispatcher.onComplete();

      expect(mockController.createPlaceholder).toHaveBeenCalledOnce();
      expect(mockController.appendDelta).toHaveBeenCalledTimes(2);
      expect(mockController.appendDelta).toHaveBeenNthCalledWith(1, 'Hello');
      expect(mockController.appendDelta).toHaveBeenNthCalledWith(2, ' World');
      expect(mockController.complete).toHaveBeenCalledOnce();
    });

    it('should follow onStart -> onToolStart -> onToolEnd -> onTextDelta -> onComplete flow', async () => {
      await dispatcher.onStart();
      dispatcher.onToolStart('shell', { command: 'ls' });
      dispatcher.onToolEnd('shell', { output: 'file.txt' });
      dispatcher.onTextDelta('Result: file.txt');
      await dispatcher.onComplete();

      expect(mockController.createPlaceholder).toHaveBeenCalledOnce();
      expect(mockController.markToolRunning).toHaveBeenCalledWith('shell', { command: 'ls' }, undefined);
      expect(mockController.markToolComplete).toHaveBeenCalledWith('shell', undefined);
      // After a completed tool, answer text is prefixed with a blank line to
      // close the tool blockquote.
      expect(mockController.appendDelta).toHaveBeenCalledWith('\n\nResult: file.txt');
      expect(mockController.complete).toHaveBeenCalledOnce();
    });
  });
});
