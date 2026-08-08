/**
 * Routes Feishu events to registered handlers by event type.
 * Provides message deduplication with a configurable TTL.
 */

import type { FeishuMessageContext } from './feishu-context.js';
import { buildMessageContext } from './feishu-context.js';
import type { ProcessedMessageRepository } from '../../src/memory/repositories/processed-message-repository.js';

export type EventHandler = (context: FeishuMessageContext) => Promise<void>;

const DEFAULT_STALE_MESSAGE_WINDOW_MS = 30 * 60 * 1000;
const FEISHU_SOURCE = 'feishu';

export interface FeishuRouterOptions {
  staleMessageWindowMs?: number;
  processedMessageRepository?: ProcessedMessageRepository;
  logger?: {
    debug?: (obj: Record<string, unknown>, msg?: string) => void;
    warn?: (obj: Record<string, unknown>, msg?: string) => void;
  };
}

export class FeishuRouter {
  private handlers: Map<string, EventHandler> = new Map();
  private seen: Map<string, number> = new Map();
  /**
   * Message ids whose handler is currently running. Guards against concurrent
   * duplicate delivery (Feishu retry racing the initial delivery). Entries are
   * only removed when the handler settles — a hung handler blocks re-delivery
   * of that single message until process restart, which is safer than running
   * the handler twice. No TTL cleanup: unlike `seen`, entries never expire.
   */
  private inFlight: Set<string> = new Set();
  private dedupTTL: number = 5 * 60 * 1000; // 5 minutes
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private readonly MAX_SEEN_SIZE = 10_000;
  private readonly staleMessageWindowMs: number;
  private readonly processedMessageRepository?: ProcessedMessageRepository;
  private readonly logger?: FeishuRouterOptions['logger'];

  constructor(options: FeishuRouterOptions = {}) {
    this.staleMessageWindowMs = options.staleMessageWindowMs ?? DEFAULT_STALE_MESSAGE_WINDOW_MS;
    this.processedMessageRepository = options.processedMessageRepository;
    this.logger = options.logger;
  }

  /**
   * Register a handler for a given event type.
   */
  on(eventType: string, handler: EventHandler): void {
    this.handlers.set(eventType, handler);
  }

  /**
   * Route a raw Feishu event envelope to the appropriate handler.
   *
   * The envelope is expected to have:
   * - `header.event_type` — used to look up the handler
   * - `event.message.message_id` — used for deduplication
   *
   * Unknown event types are silently ignored.
   */
  async route(event: any): Promise<void> {
    const eventType: string | undefined = event?.header?.event_type;

    if (!eventType) {
      return;
    }

    const handler = this.handlers.get(eventType);
    if (!handler) {
      return;
    }

    // Deduplication on message_id (only for message events). The seen map is
    // only populated AFTER the handler succeeds, so a failed delivery is not
    // marked as processed and Feishu's retry can re-process it instead of
    // being silently dropped as a duplicate.
    const messageId: string | undefined = event?.event?.message?.message_id;
    if (messageId && this.isDuplicate(messageId)) {
      return;
    }

    const context = buildMessageContext(event);
    if (this.isPersistentlyProcessed(context, eventType)) {
      return;
    }
    if (this.isStaleMessage(context)) {
      this.markSeen(messageId);
      this.recordProcessedMessage(context, eventType);
      return;
    }

    // In-flight guard: while the handler is running, a concurrent delivery of
    // the same message (Feishu retry racing the initial delivery) is dropped
    // instead of running the handler twice. The guard is released in `finally`,
    // so a retry arriving AFTER a failure is still processed normally.
    if (messageId && this.inFlight.has(messageId)) {
      return;
    }
    if (messageId) {
      this.inFlight.add(messageId);
    }
    try {
      await handler(context);
      // Mark as processed only after successful handling — if the handler
      // throws, the message stays retryable for Feishu's next attempt.
      this.markSeen(messageId);
      this.recordProcessedMessage(context, eventType);
    } finally {
      if (messageId) {
        this.inFlight.delete(messageId);
      }
    }
  }

  private isPersistentlyProcessed(context: FeishuMessageContext, eventType: string): boolean {
    if (!context.messageId) {
      return false;
    }
    if (!this.processedMessageRepository) {
      return false;
    }

    if (!this.processedMessageRepository.has(FEISHU_SOURCE, context.messageId)) {
      return false;
    }

    this.logger?.debug?.({
      messageId: context.messageId,
      sessionKey: context.sessionKey,
      eventType,
    }, 'Dropping persistently deduplicated Feishu message event');

    return true;
  }

  private recordProcessedMessage(context: FeishuMessageContext, eventType: string): void {
    if (!context.messageId) {
      return;
    }
    if (!this.processedMessageRepository) {
      return;
    }

    this.processedMessageRepository.createIfAbsent({
      source: FEISHU_SOURCE,
      message_id: context.messageId,
      event_type: eventType,
      session_key: context.sessionKey,
      metadata: context.createTimeMs ? JSON.stringify({ createTimeMs: context.createTimeMs }) : null,
    });
  }

  private isStaleMessage(context: FeishuMessageContext): boolean {
    if (!context.createTimeMs || this.staleMessageWindowMs <= 0) {
      return false;
    }

    const ageMs = Date.now() - context.createTimeMs;
    if (ageMs <= this.staleMessageWindowMs) {
      return false;
    }

    this.logger?.debug?.({
      messageId: context.messageId,
      sessionKey: context.sessionKey,
      ageMs,
      createTimeMs: context.createTimeMs,
      staleMessageWindowMs: this.staleMessageWindowMs,
    }, 'Dropping stale Feishu message event');
    return true;
  }

  /**
   * Check whether a messageId has been handled recently (successful processing
   * or deliberate stale drop). Does NOT record it — recording only happens
   * after the handler succeeds (see markSeen), so failed deliveries stay
   * retryable.
   */
  private isDuplicate(messageId: string): boolean {
    return this.seen.has(messageId);
  }

  /**
   * Record a messageId as handled in the in-memory dedup map.
   * No-op when the event has no message_id (nothing to deduplicate).
   */
  private markSeen(messageId: string | undefined): void {
    if (messageId) {
      this.seen.set(messageId, Date.now());
    }
  }

  /**
   * Remove expired entries from the seen map.
   * Called on each dedup check to keep memory bounded.
   */
  private cleanupSeen(): void {
    if (this.seen.size === 0) {
      return;
    }

    const now = Date.now();

    // Memory limit protection: if seen map exceeds max size, force full cleanup
    if (this.seen.size > this.MAX_SEEN_SIZE) {
      for (const [id, timestamp] of this.seen) {
        if (now - timestamp > this.dedupTTL) {
          this.seen.delete(id);
        }
      }
      return;
    }

    for (const [id, timestamp] of this.seen) {
      if (now - timestamp > this.dedupTTL) {
        this.seen.delete(id);
      }
    }
  }

  /**
   * Start periodic cleanup of the dedup seen map.
   * Cleanup runs every `intervalMs` milliseconds (default 60s).
   * This is the only source of cleanup — isDuplicate no longer triggers cleanupSeen.
   */
  startCleanup(intervalMs: number = 60_000): void {
    this.stopCleanup();
    this.cleanupTimer = setInterval(() => this.cleanupSeen(), intervalMs);
  }

  /**
   * Stop periodic cleanup.
   */
  stopCleanup(): void {
    if (this.cleanupTimer !== null) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * Expose seen map size for testing / diagnostics.
   */
  get seenSize(): number {
    return this.seen.size;
  }
}
