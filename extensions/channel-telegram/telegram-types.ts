/**
 * Telegram-specific type definitions for the OhMyAgent channel extension.
 */

/** Telegram channel configuration. Mirrors the telegram section of AppConfig. */
export interface TelegramConfig {
  botToken: string;
  mode: 'polling' | 'webhook';
  webhookUrl?: string;
  webhookPort: number;
  webhookSecret?: string;
  allowedUsers: string[];
  allowedGroups: string[];
  proxyUrl?: string;
  streamMode: 'edit' | 'send';
  textLimit: number;
  streamIntervalMs: number;
}

/** Union type for all callback/inline-query actions sent from Telegram inline keyboards. */
export type CallbackAction =
  | {
      type: 'approve';
      requestId: string;
      decision:
        | 'approve_once'
        | 'approve_session'
        | 'approve_always'
        | 'reject_once'
        | 'reject_always';
    }
  | { type: 'agent_switch'; agentId: string }
  | { type: 'stop' };

/**
 * Controls streaming of LLM responses back to a Telegram chat.
 *
 * In 'edit' mode, a single message is created and its text is updated
 * incrementally. In 'send' mode, each delta is sent as a new message.
 */
export interface StreamController {
  /** Create the initial placeholder message in the given chat. Returns the message id. */
  start(chatId: number): Promise<number>;
  /** Feed a text delta to the stream. */
  onDelta(delta: string): void;
  /** Finalize the stream with the complete response text. */
  onComplete(finalText: string): Promise<void>;
  /** Abort the stream due to an error. */
  onError(error: Error): Promise<void>;
  /** Cancel the stream without a final response. */
  abort(): void;
  /** Return the current message id, or null if no message has been sent yet. */
  getMessageId(): number | null;
}
