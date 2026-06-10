/**
 * Feishu WebSocket client with health watchdog.
 *
 * Wraps the official `@larksuiteoapi/node-sdk` WSClient and adds:
 *   - Optional stale watchdog for deployments that need an extra reconnect guard.
 *   - Automatic reconnection on disconnect with configurable delay.
 */

import * as lark from '@larksuiteoapi/node-sdk';

const { WSClient, EventDispatcher, LoggerLevel } = lark;

// ─── Types ───

export interface FeishuWSClientOptions {
  appId: string;
  appSecret: string;
  eventHandler: (event: any) => Promise<void>;
  /** Handler for card action callbacks (e.g., approval buttons). */
  cardActionHandler?: (action: any) => Promise<Record<string, unknown> | void>;
  staleTimeoutMs?: number;   // default disabled
  reconnectDelayMs?: number; // default 3000
  logger?: any;
}

// ─── Client ───

export class FeishuWSClient {
  private wsClient: InstanceType<typeof WSClient>;
  private eventDispatcher: InstanceType<typeof EventDispatcher>;
  private staleTimer?: ReturnType<typeof setTimeout>;
  private running: boolean = false;
  private reconnectTimer?: ReturnType<typeof setTimeout>;

  private readonly staleTimeoutMs: number;
  private readonly reconnectDelayMs: number;
  private readonly eventHandler: (event: any) => Promise<void>;
  private readonly logger: any;

  constructor(private options: FeishuWSClientOptions) {
    this.staleTimeoutMs = options.staleTimeoutMs ?? 0;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 3_000;
    this.eventHandler = options.eventHandler;
    this.logger = options.logger ?? { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

    // Create EventDispatcher for handling incoming events
    this.eventDispatcher = new EventDispatcher({} as any);

    // Register the im.message.receive_v1 handler.
    // The SDK passes flat data; we wrap it into the envelope format
    // that feishuRouter.route() expects (header.event_type + event.message/sender).
    this.eventDispatcher.register({
      'im.message.receive_v1': async (data: any) => {
        this.logger.debug({ msgType: data?.message?.message_type, msgId: data?.message?.message_id }, '[ws] received event');
        this.resetStaleTimer();

        const msg = data.message ?? {};
        const snd = data.sender ?? {};
        const sndId = snd.sender_id ?? {};

        const envelope = {
          header: {
            event_id: data.message_id ?? `ws-${Date.now()}`,
            event_type: 'im.message.receive_v1',
            create_time: msg.create_time ?? String(Date.now()),
            token: '',
            app_id: '',
            tenant_key: snd.tenant_key ?? '',
          },
          event: {
            sender: {
              sender_id: {
                open_id: sndId.open_id ?? '',
                user_id: sndId.user_id,
                union_id: sndId.union_id,
              },
              sender_type: snd.sender_type ?? 'user',
              tenant_key: snd.tenant_key ?? '',
            },
            message: {
              message_id: msg.message_id ?? '',
              root_id: msg.root_id,
              parent_id: msg.parent_id,
              create_time: msg.create_time ?? '',
              chat_id: msg.chat_id ?? '',
              chat_type: msg.chat_type ?? 'p2p',
              message_type: msg.message_type ?? 'text',
              content: msg.content ?? '',
            },
          },
        };

        await this.eventHandler(envelope);
      },
    });

    // Register card action handler (approval buttons, etc.)
    if (options.cardActionHandler) {
      this.eventDispatcher.register({
        'card.action.trigger': async (data: any) => {
          this.resetStaleTimer();
          this.logger.debug({ data }, 'card.action.trigger received');
          const result = await options.cardActionHandler!(data);
          this.logger.debug({ result }, 'card.action.trigger result');
          return result;
        },
      } as any);
    }

    // Create the underlying lark WSClient
    this.wsClient = new WSClient({
      appId: options.appId,
      appSecret: options.appSecret,
      loggerLevel: LoggerLevel.info,
    } as any);
  }

  /**
   * Connect the WebSocket and start the watchdog timers.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Start the underlying WSClient with eventDispatcher
    await this.wsClient.start({
      eventDispatcher: this.eventDispatcher,
    });

    this.resetStaleTimer();

    this.logger.info('[ws-client] started');
  }

  /**
   * Disconnect and clean up all timers.
   */
  stop(): void {
    if (!this.running) return;
    this.running = false;

    this.clearTimers();
    this.wsClient.close();
    this.logger.info('[ws-client] stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  // ─── Private ───

  private resetStaleTimer(): void {
    if (this.staleTimeoutMs <= 0) return;
    if (this.staleTimer) clearTimeout(this.staleTimer);
    this.staleTimer = setTimeout(() => {
      this.logger.warn('[ws-client] stale timeout — reconnecting');
      this.reconnect();
    }, this.staleTimeoutMs);
  }

  private clearTimers(): void {
    if (this.staleTimer) {
      clearTimeout(this.staleTimer);
      this.staleTimer = undefined;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private reconnect(): void {
    if (!this.running) return;
    this.wsClient.close();
    this.clearTimers();

    this.reconnectTimer = setTimeout(async () => {
      if (!this.running) return;
      try {
        await this.wsClient.start({
          eventDispatcher: this.eventDispatcher,
        });
        this.resetStaleTimer();
        this.logger.info('[ws-client] reconnected');
      } catch (error) {
        this.logger.error('[ws-client] reconnect failed:', error);
        // Retry after delay
        this.reconnect();
      }
    }, this.reconnectDelayMs);
  }
}
