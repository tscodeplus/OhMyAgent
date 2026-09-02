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
  staleTimeoutMs?: number; // default disabled
  reconnectDelayMs?: number; // default 3000
  logger?: any;
}

/**
 * The lark SDK's LoggerProxy forwards its varargs as ONE array argument
 * (this.logger.warn(msg) where msg = [...args]), which is why unfiltered
 * output shows bracketed arrays like [ 'no ... handle' ]. Flatten before
 * passing to the host logger.
 */
function flattenSdkArgs(args: unknown[]): unknown[] {
  return args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
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
    this.logger = options.logger ?? {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    };

    // Create EventDispatcher for handling incoming events.
    // Pass a filtered logger: the lark SDK warns "no <type> handle" for every
    // event type we don't register (read receipts im.message.message_read_v1,
    // reactions, etc.) — those are benign and would otherwise spam the log on
    // every turn. Downgrade exactly that pattern to debug; keep other SDK
    // warnings (verification failures, etc.) visible.
    this.eventDispatcher = new EventDispatcher({
      logger: {
        // The SDK's LoggerProxy packs its varargs into a single array
        // argument: this.logger.warn(['no <type> handle']) — flatten before
        // forwarding so the host logger prints readable lines.
        debug: (...args: unknown[]) => this.logger.debug(...flattenSdkArgs(args)),
        info: (...args: unknown[]) => this.logger.info(...flattenSdkArgs(args)),
        warn: (...args: unknown[]) => {
          const flat = flattenSdkArgs(args);
          const msg = flat[0];
          if (typeof msg === 'string' && /^no \S+ handle$/.test(msg)) {
            this.logger.debug(
              { event: msg },
              '[ws] unhandled Feishu event type (benign, ignored)',
            );
            return;
          }
          this.logger.warn(...flat);
        },
        error: (...args: unknown[]) => this.logger.error(...flattenSdkArgs(args)),
      },
    } as any);

    // Register the im.message.receive_v1 handler.
    // The SDK passes flat data; we wrap it into the envelope format
    // that feishuRouter.route() expects (header.event_type + event.message/sender).
    this.eventDispatcher.register({
      'im.message.receive_v1': async (data: any) => {
        this.logger.debug(
          { msgType: data?.message?.message_type, msgId: data?.message?.message_id },
          '[ws] received event',
        );
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

      // The bot's own typing-indicator reactions (added/removed per turn by
      // ReplyDispatcher) push im.message.reaction.* events back to us. We
      // don't act on them — register no-op handlers so the lark SDK does not
      // warn "no im.message.reaction.created_v1 handle" on every turn.
      'im.message.reaction.created_v1': async () => {
        this.resetStaleTimer();
      },
      'im.message.reaction.deleted_v1': async () => {
        this.resetStaleTimer();
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

    this.reconnectTimer = setTimeout(() => {
      if (!this.running) return;
      // startAfterReconnect handles (and reschedules) its own failures.
      void this.startAfterReconnect();
    }, this.reconnectDelayMs);
  }

  private async startAfterReconnect(): Promise<void> {
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
  }
}
