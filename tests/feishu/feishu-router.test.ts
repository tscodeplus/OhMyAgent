import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FeishuRouter } from '../../extensions/channel-feishu/feishu-router.js';
import type { FeishuMessageContext } from '../../extensions/channel-feishu/feishu-context.js';

// ─── Helpers ───

function makeEnvelope(
  overrides: {
    eventType?: string;
    messageId?: string;
    chatId?: string;
    chatType?: 'p2p' | 'group';
    content?: string;
    createTime?: string;
  } = {},
) {
  const {
    eventType = 'im.message.receive_v1',
    messageId = 'om_msg001',
    chatId = 'oc_chat001',
    chatType = 'p2p',
    content = '{"text":"hello"}',
    createTime = String(Date.now()),
  } = overrides;

  return {
    header: {
      event_type: eventType,
      event_id: 'ev_001',
      create_time: '1700000000',
      token: 'tok',
      app_id: 'app1',
      tenant_key: 'tenant1',
    },
    event: {
      message: {
        chat_id: chatId,
        chat_type: chatType,
        message_id: messageId,
        create_time: createTime,
        message_type: 'text',
        content,
      },
      sender: {
        sender_id: {
          open_id: 'ou_sender',
          user_id: 'uid',
          union_id: 'unid',
        },
        sender_type: 'user',
        tenant_key: 'tenant1',
      },
    },
  };
}

// ─── Tests ───

describe('FeishuRouter', () => {
  let router: FeishuRouter;

  beforeEach(() => {
    router = new FeishuRouter();
  });

  // ─── Handler registration and routing ───

  describe('handler registration and routing', () => {
    it('calls the registered handler with correct context', async () => {
      const handler = vi.fn();
      router.on('im.message.receive_v1', handler);

      const envelope = makeEnvelope();
      await router.route(envelope);

      expect(handler).toHaveBeenCalledOnce();
      const ctx: FeishuMessageContext = handler.mock.calls[0][0];
      expect(ctx.chatId).toBe('oc_chat001');
      expect(ctx.messageId).toBe('om_msg001');
      expect(ctx.senderId).toBe('ou_sender');
      expect(ctx.text).toBe('hello');
    });

    it('supports multiple handlers for different event types', async () => {
      const msgHandler = vi.fn();
      const cardHandler = vi.fn();
      router.on('im.message.receive_v1', msgHandler);
      router.on('card.action.trigger', cardHandler);

      await router.route(makeEnvelope({ eventType: 'im.message.receive_v1' }));
      expect(msgHandler).toHaveBeenCalledOnce();
      expect(cardHandler).not.toHaveBeenCalled();

      await router.route(makeEnvelope({ eventType: 'card.action.trigger', messageId: 'om_card001' }));
      expect(cardHandler).toHaveBeenCalledOnce();
    });

    it('last-registered handler wins for the same event type', async () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      router.on('im.message.receive_v1', handler1);
      router.on('im.message.receive_v1', handler2);

      await router.route(makeEnvelope());
      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).toHaveBeenCalledOnce();
    });
  });

  // ─── Unknown event types ───

  describe('unknown event types', () => {
    it('silently ignores unknown event types', async () => {
      const handler = vi.fn();
      router.on('im.message.receive_v1', handler);

      await router.route(makeEnvelope({ eventType: 'unknown.event.type' }));
      expect(handler).not.toHaveBeenCalled();
    });

    it('silently ignores events with missing header', async () => {
      const handler = vi.fn();
      router.on('im.message.receive_v1', handler);

      await router.route({ event: {} });
      expect(handler).not.toHaveBeenCalled();
    });

    it('silently ignores events with missing header.event_type', async () => {
      const handler = vi.fn();
      router.on('im.message.receive_v1', handler);

      await router.route({ header: {}, event: {} });
      expect(handler).not.toHaveBeenCalled();
    });
  });

  // ─── Message deduplication ───

  describe('message deduplication', () => {
    it('routes the same messageId only once', async () => {
      const handler = vi.fn();
      router.on('im.message.receive_v1', handler);

      const envelope = makeEnvelope({ messageId: 'om_dup' });

      await router.route(envelope);
      expect(handler).toHaveBeenCalledOnce();

      // Second call with same messageId — should be deduplicated
      await router.route(envelope);
      expect(handler).toHaveBeenCalledOnce();
    });

    it('routes different messageIds independently', async () => {
      const handler = vi.fn();
      router.on('im.message.receive_v1', handler);

      await router.route(makeEnvelope({ messageId: 'om_1' }));
      await router.route(makeEnvelope({ messageId: 'om_2' }));
      await router.route(makeEnvelope({ messageId: 'om_3' }));

      expect(handler).toHaveBeenCalledTimes(3);
    });

    it('tracks seen count', async () => {
      router.on('im.message.receive_v1', vi.fn());

      expect(router.seenSize).toBe(0);

      await router.route(makeEnvelope({ messageId: 'om_a' }));
      expect(router.seenSize).toBe(1);

      await router.route(makeEnvelope({ messageId: 'om_b' }));
      expect(router.seenSize).toBe(2);

      // Duplicate does not increase seen size
      await router.route(makeEnvelope({ messageId: 'om_a' }));
      expect(router.seenSize).toBe(2);
    });

    it('drops messages already marked in persistent dedup storage', async () => {
      const persistentRepo = {
        has: vi.fn(() => true),
        createIfAbsent: vi.fn(() => false),
      };
      router = new FeishuRouter({ processedMessageRepository: persistentRepo as any });
      const handler = vi.fn();
      router.on('im.message.receive_v1', handler);

      await router.route(makeEnvelope({ messageId: 'om_persisted' }));

      expect(persistentRepo.has).toHaveBeenCalledOnce();
      expect(handler).not.toHaveBeenCalled();
    });

    it('marks a message as processed only after successful handling', async () => {
      const persistentRepo = {
        has: vi.fn(() => false),
        createIfAbsent: vi.fn(() => true),
      };
      router = new FeishuRouter({ processedMessageRepository: persistentRepo as any });
      const handler = vi.fn();
      router.on('im.message.receive_v1', handler);

      await router.route(makeEnvelope({ messageId: 'om_success' }));

      expect(handler).toHaveBeenCalledOnce();
      expect(persistentRepo.createIfAbsent).toHaveBeenCalledOnce();
    });

    it('does not persistently mark a message when the handler fails', async () => {
      const persistentRepo = {
        has: vi.fn(() => false),
        createIfAbsent: vi.fn(() => true),
      };
      router = new FeishuRouter({ processedMessageRepository: persistentRepo as any });
      router.on('im.message.receive_v1', vi.fn(async () => {
        throw new Error('boom');
      }));

      await expect(router.route(makeEnvelope({ messageId: 'om_fail' }))).rejects.toThrow('boom');
      expect(persistentRepo.createIfAbsent).not.toHaveBeenCalled();
    });

    it('does not mark a message as seen when the handler fails, so a retry is re-processed', async () => {
      const handler = vi.fn()
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce(undefined);
      router.on('im.message.receive_v1', handler);

      const envelope = makeEnvelope({ messageId: 'om_retry' });

      // First delivery fails — the message must NOT be marked as processed
      await expect(router.route(envelope)).rejects.toThrow('boom');
      expect(handler).toHaveBeenCalledOnce();
      expect(router.seenSize).toBe(0);

      // Feishu retries the delivery — it must NOT be dropped as a duplicate
      await router.route(envelope);
      expect(handler).toHaveBeenCalledTimes(2);
      expect(router.seenSize).toBe(1);
    });

    it('drops a concurrent duplicate delivery while the handler is in flight', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const handler = vi.fn(async () => { await gate; });
      router.on('im.message.receive_v1', handler);

      const envelope = makeEnvelope({ messageId: 'om_inflight' });

      // route() runs synchronously up to the handler's first await, so the
      // in-flight guard is already set when the first promise is created
      const first = router.route(envelope);
      await router.route(envelope); // racing retry — dropped by in-flight guard
      expect(handler).toHaveBeenCalledOnce();

      release();
      await first;
      expect(handler).toHaveBeenCalledOnce();
    });

    it('releases the in-flight guard after a failure so a later retry is processed', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const handler = vi.fn(async () => { await gate; throw new Error('boom'); });
      router.on('im.message.receive_v1', handler);

      const envelope = makeEnvelope({ messageId: 'om_race' });

      const first = router.route(envelope); // handler now in flight
      await router.route(envelope);         // racing retry — dropped, not double-processed
      expect(handler).toHaveBeenCalledOnce();

      release();
      await expect(first).rejects.toThrow('boom');
      expect(router.seenSize).toBe(0);

      // Retry after the failure is processed again — the guard was released
      await expect(router.route(envelope)).rejects.toThrow('boom');
      expect(handler).toHaveBeenCalledTimes(2);
    });

    it('marks seen before the persistent record, so a record failure cannot cause re-processing', async () => {
      const persistentRepo = {
        has: vi.fn(() => false),
        createIfAbsent: vi.fn(() => { throw new Error('db down'); }),
      };
      router = new FeishuRouter({ processedMessageRepository: persistentRepo as any });
      const handler = vi.fn();
      router.on('im.message.receive_v1', handler);

      await expect(router.route(makeEnvelope({ messageId: 'om_dbdown' }))).rejects.toThrow('db down');
      expect(handler).toHaveBeenCalledOnce();
      expect(router.seenSize).toBe(1);

      // The message WAS processed — a retry within the dedup TTL is still dropped
      await router.route(makeEnvelope({ messageId: 'om_dbdown' }));
      expect(handler).toHaveBeenCalledOnce();
    });
  });

  describe('stale message filtering', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('drops messages older than the stale window', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-03T04:30:00+08:00'));
      const handler = vi.fn();
      const persistentRepo = {
        has: vi.fn(() => false),
        createIfAbsent: vi.fn(() => true),
      };
      router = new FeishuRouter({ processedMessageRepository: persistentRepo as any });
      router.on('im.message.receive_v1', handler);

      await router.route(makeEnvelope({
        messageId: 'om_old',
        createTime: String(new Date('2026-05-03T03:30:00+08:00').getTime()),
      }));

      expect(handler).not.toHaveBeenCalled();
      expect(persistentRepo.createIfAbsent).toHaveBeenCalledOnce();
      expect(router.seenSize).toBe(1);
    });

    it('allows fresh messages within the stale window', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-03T04:30:00+08:00'));
      const handler = vi.fn();
      router.on('im.message.receive_v1', handler);

      await router.route(makeEnvelope({
        messageId: 'om_fresh',
        createTime: String(new Date('2026-05-03T04:20:00+08:00').getTime()),
      }));

      expect(handler).toHaveBeenCalledOnce();
    });
  });

  // ─── Dedup TTL expiration ───

  describe('dedup TTL expiration', () => {
    afterEach(() => {
      vi.useRealTimers();
      router.stopCleanup();
    });

    it('allows re-routing after TTL expires', async () => {
      vi.useFakeTimers();
      const handler = vi.fn();
      router.on('im.message.receive_v1', handler);
      router.startCleanup(100); // Cleanup runs every 100ms

      const envelope = makeEnvelope({ messageId: 'om_ttl' });

      // First call at t=0
      await router.route(envelope);
      expect(handler).toHaveBeenCalledOnce();

      // Advance past 5-minute TTL + cleanup interval
      vi.advanceTimersByTime(5 * 60 * 1000 + 100);

      // Expired entry should have been cleaned by periodic timer
      await router.route(envelope);
      expect(handler).toHaveBeenCalledTimes(2);
    });

    it('deduplicates within TTL window', async () => {
      vi.useFakeTimers();
      const handler = vi.fn();
      router.on('im.message.receive_v1', handler);

      const envelope = makeEnvelope({ messageId: 'om_window' });

      await router.route(envelope);

      // Advance 2 minutes (within 5-min TTL)
      vi.advanceTimersByTime(2 * 60 * 1000);

      await router.route(envelope);
      expect(handler).toHaveBeenCalledOnce();

      // Advance another 2 minutes (total 4 min, still within TTL)
      vi.advanceTimersByTime(2 * 60 * 1000);

      await router.route(envelope);
      expect(handler).toHaveBeenCalledOnce();
    });

    it('cleanupSeen removes expired entries', async () => {
      vi.useFakeTimers();
      router.on('im.message.receive_v1', vi.fn());
      router.startCleanup(100); // Cleanup runs every 100ms

      await router.route(makeEnvelope({ messageId: 'om_clean' }));
      expect(router.seenSize).toBe(1);

      // Advance past TTL
      vi.advanceTimersByTime(5 * 60 * 1000 + 1);

      // Entry is expired but still in map — trigger cleanup via timer
      vi.advanceTimersByTime(100);

      // Now the expired entry should be removed
      expect(router.seenSize).toBe(0);
    });
  });
});
