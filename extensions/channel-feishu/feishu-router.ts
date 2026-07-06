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

    // Deduplication on message_id (only for message events)
    const messageId: string | undefined = event?.event?.message?.message_id;
    if (messageId && this.isDuplicate(messageId)) {
      return;
    }

    const context = buildMessageContext(event);
    if (this.isPersistentlyProcessed(context, eventType)) {
      return;
    }
    if (this.isStaleMessage(context)) {
      this.recordProcessedMessage(context, eventType);
      return;
    }
    await handler(context);
    this.recordProcessedMessage(context, eventType);
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
   * Check whether a messageId has been seen recently.
   * If not, record it and return false. If yes, return true.
   */
  private isDuplicate(messageId: string): boolean {
    if (this.seen.has(messageId)) {
      return true;
    }

    this.seen.set(messageId, Date.now());
    return false;
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
