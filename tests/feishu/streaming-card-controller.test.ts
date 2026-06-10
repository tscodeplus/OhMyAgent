import { i18n } from '../../src/i18n/index.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StreamingCardController } from '../../extensions/channel-feishu/render/streaming-card-controller.js';
import type { StreamingCardControllerOptions } from '../../extensions/channel-feishu/render/streaming-card-controller.js';

// ─── Mock FeishuClient ───

function createMockFeishuClient() {
  return {
    createCard: vi.fn().mockResolvedValue('mock-card-id'),
    sendCardByCardId: vi.fn().mockResolvedValue('mock-msg-id'),
    streamCardContent: vi.fn().mockResolvedValue(undefined),
    setCardStreamingMode: vi.fn().mockResolvedValue(undefined),
    updateCard: vi.fn().mockResolvedValue(undefined),
    updateMessage: vi.fn().mockResolvedValue(undefined),
  };
}

function createController(feishu = createMockFeishuClient()) {
  return new StreamingCardController({
    feishuClient: feishu as any,
    chatId: 'chat-123',
    flushIntervalMs: 800,
  });
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ─── State Transitions ───

describe('StreamingCardController state transitions', () => {
  it('starts in idle state', () => {
    const controller = createController();
    expect(controller.getState()).toBe('idle');
  });

  it('transitions idle → creating → streaming after createPlaceholder', async () => {
    const controller = createController();
    await controller.createPlaceholder();

    expect(controller.getState()).toBe('streaming');
  });

  it('transitions streaming → completed after complete()', async () => {
    const feishu = createMockFeishuClient();
    const controller = createController(feishu);

    await controller.createPlaceholder();
    const completePromise = controller.complete();

    // Advance past flush timer
    vi.useFakeTimers();
    vi.advanceTimersByTime(900);
    vi.useRealTimers();

    await completePromise;
    expect(controller.getState()).toBe('completed');
  });

  it('transitions streaming → error after fail()', async () => {
    const feishu = createMockFeishuClient();
    const controller = createController(feishu);

    await controller.createPlaceholder();
    await controller.fail('Something went wrong');

    expect(controller.getState()).toBe('error');
  });

  it('transitions streaming → aborted after abort()', async () => {
    const feishu = createMockFeishuClient();
    const controller = createController(feishu);

    await controller.createPlaceholder();
    await controller.abort();

    expect(controller.getState()).toBe('aborted');
  });

  it('throws if createPlaceholder called twice', async () => {
    const controller = createController();
    await controller.createPlaceholder();

    await expect(controller.createPlaceholder()).rejects.toThrow('Cannot create placeholder');
  });

  it('complete() is idempotent', async () => {
    const feishu = createMockFeishuClient();
    const controller = createController(feishu);
    await controller.createPlaceholder();

    const p1 = controller.complete();
    vi.useFakeTimers();
    vi.advanceTimersByTime(900);
    vi.useRealTimers();
    await p1;

    const p2 = controller.complete();
    await p2;

    expect(feishu.setCardStreamingMode).toHaveBeenCalledOnce();
  });

  it('fail() is no-op if already completed', async () => {
    const feishu = createMockFeishuClient();
    const controller = createController(feishu);
    await controller.createPlaceholder();

    const p1 = controller.complete();
    vi.useFakeTimers();
    vi.advanceTimersByTime(900);
    vi.useRealTimers();
    await p1;

    feishu.updateCard.mockClear();
    await controller.fail('error');
    expect(feishu.updateCard).not.toHaveBeenCalled();
  });
});

// ─── Think Tag Parsing ───

describe('<think> tag parsing', () => {
  it('separates thinking from answer content', async () => {
    const feishu = createMockFeishuClient();
    const controller = createController(feishu);
    await controller.createPlaceholder();

    controller.appendDelta('<think>Let me think</think>The answer is 42.');

    const completePromise = controller.complete();
    vi.useFakeTimers();
    vi.advanceTimersByTime(900);
    vi.useRealTimers();
    await completePromise;

    // The completed card should have the answer stripped of think tags
    expect(feishu.updateCard).toHaveBeenCalled();
    const lastCall = feishu.updateCard.mock.calls[feishu.updateCard.mock.calls.length - 1];
    const card = lastCall[1] as Record<string, unknown>;
    const body = card.body as Record<string, unknown>;
    const elements = body.elements as Array<Record<string, unknown>>;

    // Find answer element (uses streaming_content element_id in the completed card)
    const answerEl = elements.find((el) => el.element_id === 'streaming_content');
    expect(answerEl).toBeDefined();
    expect(answerEl.content).toBe('The answer is 42.');
  });

  it('handles partial think tags across deltas', async () => {
    const feishu = createMockFeishuClient();
    const controller = createController(feishu);
    await controller.createPlaceholder();

    // Split <think> tag across two deltas
    controller.appendDelta('Hel');
    controller.appendDelta('lo <think>Th');
    controller.appendDelta('inking</think>World');

    const completePromise = controller.complete();
    vi.useFakeTimers();
    vi.advanceTimersByTime(900);
    vi.useRealTimers();
    await completePromise;

    expect(feishu.updateCard).toHaveBeenCalled();
    const lastCall = feishu.updateCard.mock.calls[feishu.updateCard.mock.calls.length - 1];
    const card = lastCall[1] as Record<string, unknown>;
    const body = card.body as Record<string, unknown>;
    const elements = body.elements as Array<Record<string, unknown>>;

    // Answer should have thinking stripped
    const answerEl = elements.find((el) => el.element_id === 'streaming_content');
    expect(answerEl).toBeDefined();
    const answerText = answerEl.content as string;
    expect(answerText).toContain('Hello ');
    expect(answerText).toContain('World');
    expect(answerText).not.toContain('Thinking');
  });

  it('handles unclosed think tags (streaming scenario)', async () => {
    const feishu = createMockFeishuClient();
    const controller = createController(feishu);
    await controller.createPlaceholder();

    controller.appendDelta('<think>Thinking in progress');
    // No closing tag yet

    const completePromise = controller.complete();
    vi.useFakeTimers();
    vi.advanceTimersByTime(900);
    vi.useRealTimers();
    await completePromise;

    expect(feishu.updateCard).toHaveBeenCalled();
    const lastCall = feishu.updateCard.mock.calls[feishu.updateCard.mock.calls.length - 1];
    const card = lastCall[1] as Record<string, unknown>;
    const body = card.body as Record<string, unknown>;
    const elements = body.elements as Array<Record<string, unknown>>;

    const answerEl = elements.find((el) => el.element_id === 'streaming_content');
    expect(answerEl).toBeDefined();
    expect(answerEl.content).not.toContain('<think>');
  });

  it('treats malformed tags as regular text', async () => {
    const feishu = createMockFeishuClient();
    const controller = createController(feishu);
    await controller.createPlaceholder();

    controller.appendDelta('Hello <think>World</think>! <thinking>Again</thinking>');

    const completePromise = controller.complete();
    vi.useFakeTimers();
    vi.advanceTimersByTime(900);
    vi.useRealTimers();
    await completePromise;

    const lastCall = feishu.updateCard.mock.calls[feishu.updateCard.mock.calls.length - 1];
    const card = lastCall[1] as Record<string, unknown>;
    const body = card.body as Record<string, unknown>;
    const elements = body.elements as Array<Record<string, unknown>>;

    const answerEl = elements.find((el) => el.element_id === 'streaming_content');
    expect(answerEl).toBeDefined();
    const answerText = answerEl.content as string;
    // The text outside tags should remain
    expect(answerText).toContain('Hello ');
    expect(answerText).toContain('!');
  });
});

// ─── Throttling ───

describe('throttling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('multiple rapid appendDelta only trigger one flush', async () => {
    const feishu = createMockFeishuClient();
    const controller = createController(feishu);
    await controller.createPlaceholder();

    feishu.streamCardContent.mockClear();

    controller.appendDelta('Hello');
    controller.appendDelta(' ');
    controller.appendDelta('World');
    controller.appendDelta('!');

    // No flush yet (within throttle interval)
    expect(feishu.streamCardContent).not.toHaveBeenCalled();

    // Advance past flush interval
    vi.advanceTimersByTime(900);
    await vi.advanceTimersByTimeAsync(0);

    // Should have flushed exactly once
    expect(feishu.streamCardContent).toHaveBeenCalledOnce();
  });

  it('flushes immediately when enough time has elapsed', async () => {
    const feishu = createMockFeishuClient();
    const controller = createController(feishu);
    await controller.createPlaceholder();

    feishu.streamCardContent.mockClear();

    controller.appendDelta('Hello');

    // Advance past flush interval
    vi.advanceTimersByTime(900);
    await vi.advanceTimersByTimeAsync(0);

    expect(feishu.streamCardContent).toHaveBeenCalledOnce();

    feishu.streamCardContent.mockClear();

    // Another delta — should schedule a new flush
    controller.appendDelta('World');

    // Advance again
    vi.advanceTimersByTime(900);
    await vi.advanceTimersByTimeAsync(0);

    expect(feishu.streamCardContent).toHaveBeenCalledOnce();
  });

  it('does not flush when state is not streaming', async () => {
    const feishu = createMockFeishuClient();
    const controller = createController(feishu);
    await controller.createPlaceholder();

    // Complete immediately
    const completePromise = controller.complete();
    vi.advanceTimersByTime(900);
    await vi.advanceTimersByTimeAsync(0);
    await completePromise;

    feishu.streamCardContent.mockClear();

    // appendDelta after complete should be no-op
    controller.appendDelta('more content');

    vi.advanceTimersByTime(900);
    await vi.advanceTimersByTimeAsync(0);

    expect(feishu.streamCardContent).not.toHaveBeenCalled();
  });

  it('coalesces overlapping flush requests into one follow-up stream call', async () => {
    const feishu = createMockFeishuClient();
    const firstStream = createDeferred<void>();
    feishu.streamCardContent
      .mockImplementationOnce(() => firstStream.promise)
      .mockResolvedValue(undefined);

    const controller = createController(feishu);
    await controller.createPlaceholder();

    controller.appendDelta('Hello');
    vi.advanceTimersByTime(900);
    await vi.advanceTimersByTimeAsync(0);

    expect(feishu.streamCardContent).toHaveBeenCalledTimes(1);

    controller.appendDelta(' world');
    controller.appendDelta(' again');
    controller.markToolRunning('shell');

    expect(feishu.streamCardContent).toHaveBeenCalledTimes(1);

    firstStream.resolve(undefined);
    await vi.advanceTimersByTimeAsync(0);

    expect(feishu.streamCardContent).toHaveBeenCalledTimes(2);
  });
});

describe('CardKit sequencing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('serializes finalize operations behind an in-flight stream update', async () => {
    const feishu = createMockFeishuClient();
    const firstStream = createDeferred<void>();
    const operations: string[] = [];

    feishu.streamCardContent.mockImplementationOnce(async (_cardId, _elementId, _content, sequence) => {
      operations.push(`stream:${sequence}`);
      await firstStream.promise;
    });
    feishu.setCardStreamingMode.mockImplementation(async (_cardId, streamingMode, sequence) => {
      operations.push(`mode:${sequence}:${streamingMode}`);
    });
    feishu.updateCard.mockImplementation(async (_cardId, _cardData, sequence) => {
      operations.push(`update:${sequence}`);
    });

    const controller = createController(feishu);
    await controller.createPlaceholder();

    controller.appendDelta('Hello');
    vi.advanceTimersByTime(900);
    await vi.advanceTimersByTimeAsync(0);

    const completePromise = controller.complete();
    await vi.advanceTimersByTimeAsync(0);

    expect(operations).toEqual(['stream:1']);

    firstStream.resolve(undefined);
    await completePromise;

    expect(operations).toEqual([
      'stream:1',
      'mode:2:false',
      'update:3',
    ]);
  });
});

// ─── Tool Tracking ───

describe('tool tracking', () => {
  it('markToolRunning and markToolComplete are accepted in streaming state', async () => {
    const feishu = createMockFeishuClient();
    const controller = createController(feishu);
    await controller.createPlaceholder();

    // Should not throw
    controller.markToolRunning('bash');
    controller.markToolComplete('bash');

    expect(controller.getState()).toBe('streaming');
  });

  it('tool tracking is no-op in non-streaming state', async () => {
    const controller = createController();

    // No-op before createPlaceholder
    controller.markToolRunning('bash');
    controller.markToolComplete('bash');

    expect(controller.getState()).toBe('idle');
  });
});

// ─── createPlaceholder calls ───

describe('createPlaceholder', () => {
  it('creates card and sends it via feishuClient', async () => {
    const feishu = createMockFeishuClient();
    const controller = createController(feishu);

    await controller.createPlaceholder();

    expect(feishu.createCard).toHaveBeenCalledOnce();
    expect(feishu.sendCardByCardId).toHaveBeenCalledWith('chat-123', 'mock-card-id', undefined);
  });

  it('sets state to error on failure', async () => {
    const feishu = createMockFeishuClient();
    feishu.createCard.mockRejectedValue(new Error('API error'));
    const controller = createController(feishu);

    await expect(controller.createPlaceholder()).rejects.toThrow('API error');
    expect(controller.getState()).toBe('error');
  });
});

// ─── Complete card structure ───

describe('complete card structure', () => {
  it('builds a completed card with thinking and answer', async () => {
    const feishu = createMockFeishuClient();
    const controller = createController(feishu);
    await controller.createPlaceholder();

    controller.appendDelta('<think>My reasoning</think>The answer.');

    const completePromise = controller.complete();
    vi.useFakeTimers();
    vi.advanceTimersByTime(900);
    vi.useRealTimers();
    await completePromise;

    // Check that setCardStreamingMode was called with false
    expect(feishu.setCardStreamingMode).toHaveBeenCalledWith(
      'mock-card-id',
      false,
      expect.any(Number),
    );

    // Check that updateCard was called with a CardKit 2.0 card
    expect(feishu.updateCard).toHaveBeenCalled();
    const lastCall = feishu.updateCard.mock.calls[feishu.updateCard.mock.calls.length - 1];
    const card = lastCall[1] as Record<string, unknown>;

    expect(card.schema).toBe('2.0');
    expect(card.config).toEqual({ streaming_mode: false });
  });
});

// ─── Fail and Abort card structure ───

describe('fail and abort', () => {
  it('fail() sends error card', async () => {
    const feishu = createMockFeishuClient();
    const controller = createController(feishu);
    await controller.createPlaceholder();

    await controller.fail('Connection lost');

    expect(feishu.setCardStreamingMode).toHaveBeenCalled();
    expect(feishu.updateCard).toHaveBeenCalled();

    const lastCall = feishu.updateCard.mock.calls[feishu.updateCard.mock.calls.length - 1];
    const card = lastCall[1] as Record<string, unknown>;
    const body = card.body as Record<string, unknown>;
    const elements = body.elements as Array<Record<string, unknown>>;

    const answerEl = elements.find((el) => el.element_id === 'streaming_content');
    expect(answerEl).toBeDefined();
    const answerText = answerEl.content as string;
    expect(answerText).toContain('Error');
    expect(answerText).toContain('Connection lost');
  });

  it('abort() sends aborted card', async () => {
    const feishu = createMockFeishuClient();
    const controller = createController(feishu);
    await controller.createPlaceholder();

    controller.appendDelta('Partial content');
    await controller.abort();

    expect(feishu.setCardStreamingMode).toHaveBeenCalled();
    expect(feishu.updateCard).toHaveBeenCalled();

    const lastCall = feishu.updateCard.mock.calls[feishu.updateCard.mock.calls.length - 1];
    const card = lastCall[1] as Record<string, unknown>;
    expect(card.schema).toBe('2.0');
  });

  it('abort() with no content shows default message', async () => {
    const feishu = createMockFeishuClient();
    const controller = createController(feishu);
    await controller.createPlaceholder();

    await controller.abort();

    const lastCall = feishu.updateCard.mock.calls[feishu.updateCard.mock.calls.length - 1];
    const card = lastCall[1] as Record<string, unknown>;
    const body = card.body as Record<string, unknown>;
    const elements = body.elements as Array<Record<string, unknown>>;

    const answerEl = elements.find((el) => el.element_id === 'streaming_content');
    expect(answerEl).toBeDefined();
    expect(answerEl.content).toBe(i18n.t('feishu-cards:stream.stopped'));
  });
});
