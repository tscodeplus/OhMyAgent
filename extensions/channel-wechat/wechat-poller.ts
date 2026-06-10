/**
 * Long-polling message receiver for the iLink protocol.
 *
 * Periodically calls /ilink/bot/getupdates to receive new messages.
 * Cursor state is persisted to disk so the bot can resume across restarts
 * without missing messages.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Logger } from 'pino';
import { apiPost } from './wechat-api.js';
import type { ILMessage, ILGetUpdatesResponse } from './wechat-types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Server-side hold time is ~35s; client timeout gives a 10s buffer. */
const POLL_TIMEOUT_MS = 45_000;

/** Backoff delays between consecutive failures (ms). */
const BACKOFF_DELAYS = [2000, 5000, 30_000];

/** Max consecutive failures before logging severe error (still retries). */
const MAX_CONSECUTIVE_FAILURES = 3;

// ---------------------------------------------------------------------------
// WechatPoller
// ---------------------------------------------------------------------------

export class WechatPoller {
  private abortController: AbortController;
  private running = false;
  private cursorFile: string;
  private contextTokens = new Map<string, string>();
  private contextTokensFile: string;

  /**
   * @param apiBase    iLink API base URL.
   * @param botToken   Bot authentication token.
   * @param cursorDir  Directory to persist the poll cursor in.
   * @param logger     Logger instance.
   */
  constructor(
    private apiBase: string,
    private botToken: string,
    cursorDir: string,
    private logger: Logger,
  ) {
    this.abortController = new AbortController();
    this.cursorFile = getCursorPath(cursorDir, botToken);
    this.contextTokensFile = path.join(cursorDir, 'context-tokens.json');
  }

  /**
   * Start the polling loop.
   *
   * @param onMessage  Callback invoked for each received ILMessage.
   *                   The callback should handle errors internally; an
   *                   unhandled rejection will crash the poller.
   */
  async start(onMessage: (msg: ILMessage) => Promise<void>): Promise<void> {
    if (this.running) {
      this.logger.warn('WechatPoller already running');
      return;
    }
    this.running = true;
    this.abortController = new AbortController();

    const signal = this.abortController.signal;

    // Load persisted cursor and context tokens
    let cursor = await this.loadCursor();
    await this.loadContextTokens();
    this.logger.debug({ hasCursor: !!cursor }, 'Starting WeChat poller');

    let consecutiveFailures = 0;

    while (!signal.aborted) {
      try {
        const resp: ILGetUpdatesResponse = await apiPost(
          this.apiBase,
          this.botToken,
          'ilink/bot/getupdates',
          {
            get_updates_buf: cursor,
          },
          POLL_TIMEOUT_MS,
        );

        // Check for session expiry in successful response (errcode -14)
        if ((resp as any).errcode === -14 || (resp as any).errcode === '-14') {
          this.logger.error({ errcode: (resp as any).errcode, errmsg: (resp as any).errmsg }, 'WeChat session expired — stopping poller');
          this.running = false;
          return;
        }

        // Success — reset failure counter
        consecutiveFailures = 0;

        // Save new cursor
        if (resp.get_updates_buf !== undefined) {
          cursor = resp.get_updates_buf;
          await this.saveCursor(cursor);
        }

        // Process messages
        if (resp.msgs && resp.msgs.length > 0) {
          this.logger.debug({ msgCount: resp.msgs.length }, 'WeChat poller received messages');
          for (const msg of resp.msgs) {
            this.logger.debug({ from: msg.from_user_id, items: msg.item_list?.length }, 'Processing WeChat message');
            // Persist context_token per sender
            if (msg.context_token && msg.from_user_id) {
              this.contextTokens.set(msg.from_user_id, msg.context_token);
              await this.saveContextTokens();
            }

            // Filter out bot's own messages
            if (msg.from_user_id?.endsWith('@im.bot')) {
              this.logger.info('Filtering out own message');
              continue;
            }
            try {
              await onMessage(msg);
            } catch (err: unknown) {
              this.logger.error(
                { err, fromUserId: msg.from_user_id },
                'WeChat message handler error',
              );
            }
          }
        }
      } catch (err: unknown) {
        // Check for session expiry (errcode -14) — fatal
        if (isSessionExpiredError(err)) {
          this.logger.error({ err }, 'WeChat session expired — stopping poller');
          this.running = false;
          return;
        }

        // Timeout (AbortError from AbortSignal.timeout) is normal for long-polling
        if (err instanceof Error && err.name === 'AbortError') {
          if (signal.aborted) break;
          continue;
        }

        // Transient error — exponential backoff
        consecutiveFailures++;
        this.logger.warn(
          { err, consecutiveFailures },
          'WeChat poller transient error',
        );

        const delayIndex = Math.min(
          consecutiveFailures - 1,
          BACKOFF_DELAYS.length - 1,
        );
        const delayMs = BACKOFF_DELAYS[delayIndex];

        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          this.logger.error(
            { err, consecutiveFailures },
            'WeChat poller too many consecutive failures',
          );
        }

        await this.sleep(delayMs);
      }
    }

    this.running = false;
  }

  /**
   * Stop the polling loop gracefully.
   */
  stop(): void {
    this.abortController.abort();
    this.running = false;
  }

  /** Whether the poller is currently active. */
  get isRunning(): boolean {
    return this.running;
  }

  // -------------------------------------------------------------------------
  // Cursor persistence
  // -------------------------------------------------------------------------

  private async loadCursor(): Promise<string> {
    try {
      const raw = await fs.readFile(this.cursorFile, 'utf-8');
      const parsed = JSON.parse(raw) as { get_updates_buf?: string };
      return parsed.get_updates_buf ?? '';
    } catch {
      return '';
    }
  }

  private async saveCursor(cursor: string): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.cursorFile), { recursive: true });
      await fs.writeFile(
        this.cursorFile,
        JSON.stringify({ get_updates_buf: cursor }),
        'utf-8',
      );
    } catch (err: unknown) {
      this.logger.error({ err }, 'Failed to save WeChat poll cursor');
    }
  }

  // -------------------------------------------------------------------------
  // Context token persistence
  // -------------------------------------------------------------------------

  private async loadContextTokens(): Promise<void> {
    try {
      const raw = await fs.readFile(this.contextTokensFile, 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, string>;
      for (const [key, value] of Object.entries(parsed)) {
        this.contextTokens.set(key, value);
      }
    } catch {
      // File does not exist yet — nothing to restore
    }
  }

  private async saveContextTokens(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.contextTokensFile), { recursive: true });
      const obj: Record<string, string> = {};
      for (const [key, value] of this.contextTokens) {
        obj[key] = value;
      }
      await fs.writeFile(
        this.contextTokensFile,
        JSON.stringify(obj, null, 2),
        'utf-8',
      );
    } catch (err: unknown) {
      this.logger.error({ err }, 'Failed to save WeChat context tokens');
    }
  }

  // -------------------------------------------------------------------------
  // Utility
  // -------------------------------------------------------------------------

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build the cursor file path: {cursorDir}/sync-{sha256(token)[:8]}.json
 */
function getCursorPath(cursorDir: string, botToken: string): string {
  const hash = crypto
    .createHash('sha256')
    .update(botToken)
    .digest('hex')
    .slice(0, 8);
  return path.join(cursorDir, `sync-${hash}.json`);
}

/**
 * Detect session-expired errors (errcode -14).
 */
function isSessionExpiredError(err: unknown): boolean {
  const message = String((err as Error)?.message || '');
  return /(?:ret|errcode)=-14\b/.test(message);
}
