import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mock lark SDK ───
// Define mock functions BEFORE vi.mock so they survive hoisting

const mockStart = vi.fn().mockResolvedValue(undefined);
const mockClose = vi.fn();
const mockPingLoop = vi.fn();

// Store registered event handlers from EventDispatcher
const registeredHandlers: Record<string, Function> = {};

vi.mock('@larksuiteoapi/node-sdk', () => {
  return {
    WSClient: vi.fn().mockImplementation(() => ({
      start: mockStart,
      close: mockClose,
      pingLoop: mockPingLoop,
    })),
    EventDispatcher: vi.fn().mockImplementation(() => ({
      register: vi.fn((handlers: Record<string, Function>) => {
        Object.assign(registeredHandlers, handlers);
      }),
    })),
    LoggerLevel: { info: 3 },
  };
});

// Import AFTER mock is set up
const { FeishuWSClient } = await import('../../extensions/channel-feishu/feishu-ws-client.js');
const { WSClient: MockWSClient } = await import('@larksuiteoapi/node-sdk');

// Helper to simulate receiving a message through the EventDispatcher
async function simulateMessage(data: Record<string, unknown>): Promise<void> {
  const handler = registeredHandlers['im.message.receive_v1'];
  if (handler) {
    await handler(data);
  }
}

// ─── Tests ───

describe('FeishuWSClient', () => {
  let client: InstanceType<typeof FeishuWSClient>;
  let eventHandler: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    // Clear call counts but keep implementations
    mockStart.mockClear();
    mockClose.mockClear();
    mockPingLoop.mockClear();
    vi.mocked(MockWSClient).mockClear();
    // Clear registered handlers
    Object.keys(registeredHandlers).forEach(k => delete registeredHandlers[k]);

    eventHandler = vi.fn().mockResolvedValue(undefined);
    client = new FeishuWSClient({
      appId: 'test-app',
      appSecret: 'test-secret',
      eventHandler,
    });
  });

  afterEach(() => {
    client.stop();
    vi.useRealTimers();
  });

  // ─── start / stop ───

  describe('start and stop', () => {
    it('calls lark WSClient start', async () => {
      await client.start();
      expect(mockStart).toHaveBeenCalledOnce();
    });

    it('does not start twice', async () => {
      await client.start();
      await client.start();
      expect(mockStart).toHaveBeenCalledOnce();
    });

    it('stop cleans up timers and calls close', async () => {
      await client.start();
      client.stop();
      expect(mockClose).toHaveBeenCalled();
    });

    it('stop is idempotent', async () => {
      await client.start();
      client.stop();
      client.stop();
      expect(mockClose).toHaveBeenCalledTimes(1);
    });
  });

  // ─── stale timer ───

  describe('stale timer', () => {
    it('is disabled by default and does not reconnect idle connections', async () => {
      await client.start();
      const closeCountBefore = mockClose.mock.calls.length;

      vi.advanceTimersByTime(120_000);

      expect(mockClose.mock.calls.length).toBe(closeCountBefore);
      expect(mockStart).toHaveBeenCalledTimes(1);
    });

    it('triggers reconnect when stale watchdog is explicitly enabled', async () => {
      client.stop();
      client = new FeishuWSClient({
        appId: 'test-app',
        appSecret: 'test-secret',
        eventHandler,
        staleTimeoutMs: 40_000,
      });
      await client.start();
      const closeCountBefore = mockClose.mock.calls.length;

      vi.advanceTimersByTime(40_000);

      expect(mockClose.mock.calls.length).toBeGreaterThan(closeCountBefore);
    });

    it('message received resets stale timer when watchdog is enabled', async () => {
      client.stop();
      client = new FeishuWSClient({
        appId: 'test-app',
        appSecret: 'test-secret',
        eventHandler,
        staleTimeoutMs: 40_000,
      });
      await client.start();

      vi.advanceTimersByTime(30_000);
      await simulateMessage({ message: { message_id: 'msg-1', chat_id: 'chat-1' }, sender: {} });

      const closeCountAfterMessage = mockClose.mock.calls.length;

      vi.advanceTimersByTime(30_000);

      expect(mockClose.mock.calls.length).toBe(closeCountAfterMessage);
    });
  });

  // ─── stale timer triggers reconnect ───

  describe('stale timer reconnect', () => {
    it('triggers wsClient.close after staleTimeoutMs', async () => {
      client.stop();
      client = new FeishuWSClient({
        appId: 'test-app',
        appSecret: 'test-secret',
        eventHandler,
        staleTimeoutMs: 120_000,
      });
      await client.start();

      // Advance past stale timeout
      vi.advanceTimersByTime(120_000);
      vi.advanceTimersByTime(3_000); // reconnect delay

      // reconnect calls wsClient.close then wsClient.start
      expect(mockClose).toHaveBeenCalled();
      // start should have been called at least once (initial) + reconnect
      expect(mockStart).toHaveBeenCalledTimes(2);
    });

    it('stale timer stops after client.stop()', async () => {
      client.stop();
      client = new FeishuWSClient({
        appId: 'test-app',
        appSecret: 'test-secret',
        eventHandler,
        staleTimeoutMs: 120_000,
      });
      await client.start();

      client.stop();
      const closeCountAfterStop = mockClose.mock.calls.length;

      // Advance past stale timeout
      vi.advanceTimersByTime(120_000);

      // No additional close calls after stop
      expect(mockClose.mock.calls.length).toBe(closeCountAfterStop);
    });
  });

  // ─── message handling ───

  describe('message handling', () => {
    it('calls eventHandler when message is received', async () => {
      await client.start();

      // Simulate receiving a message through the EventDispatcher handler
      await simulateMessage({
        message: { message_id: 'msg-1', chat_id: 'chat-1', message_type: 'text', content: '{}' },
        sender: { sender_id: { open_id: 'open-1' } },
      });

      expect(eventHandler).toHaveBeenCalledOnce();
    });

    it('message received resets stale timer when watchdog is enabled', async () => {
      client.stop();
      client = new FeishuWSClient({
        appId: 'test-app',
        appSecret: 'test-secret',
        eventHandler,
        staleTimeoutMs: 40_000,
      });
      await client.start();

      // Advance 30 seconds
      vi.advanceTimersByTime(30_000);

      // Receive a message
      await simulateMessage({
        message: { message_id: 'msg-1', chat_id: 'chat-1' },
        sender: {},
      });

      // Record close count after message
      const closeCountAfterMessage = mockClose.mock.calls.length;

      // Advance another 35 seconds (total 65s from start, but 35s from last message)
      // Stale timer should NOT fire (40s threshold not reached since reset)
      vi.advanceTimersByTime(35_000);

      // No additional close calls from stale timer
      expect(mockClose.mock.calls.length).toBe(closeCountAfterMessage);
    });
  });

  // ─── reconnect ───

  describe('reconnect', () => {
    it('calls start again after stale timeout reconnect', async () => {
      client.stop();
      client = new FeishuWSClient({
        appId: 'test-app',
        appSecret: 'test-secret',
        eventHandler,
        staleTimeoutMs: 40_000,
      });
      await client.start();
      mockStart.mockClear();

      // Advance past stale timeout
      vi.advanceTimersByTime(40_000);

      // Wait for reconnect delay (3s default)
      vi.advanceTimersByTime(3_000);

      // Reconnect reuses the same WSClient instance and calls start again
      expect(mockStart).toHaveBeenCalled();
    });
  });
});
