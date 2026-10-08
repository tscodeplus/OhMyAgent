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
  private processedMessageFile: string;
  /** Successfully handled messages in the current uncommitted cursor batch. */
  private processedMessageIds = new Set<string>();
  private receiptWriteQueue: Promise<void> = Promise.resolve();
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
    /**
     * Called once when the iLink session expires (errcode -14). Historically
     * the poller just stopped and the channel went silent until restart
     * (report #11h). The callback lets the adapter surface the outage and
     * clear its poller handle so operators can re-auth via QR login.
     */
    private onSessionExpired?: (info: { errcode: number; errmsg?: string }) => void,
  ) {
    this.abortController = new AbortController();
    const cursorHash = crypto.createHash('sha256').update(botToken).digest('hex').slice(0, 8);
    this.cursorFile = path.join(cursorDir, `sync-${cursorHash}.json`);
    this.processedMessageFile = path.join(cursorDir, `processed-${cursorHash}.json`);
    this.contextTokensFile = path.join(cursorDir, 'context-tokens.json');
  }

  /**
   * Start the polling loop.
   *
   * @param onMessage  Callback invoked for each received ILMessage. A rejected
   *                   callback keeps the upstream batch cursor uncommitted and
   *                   causes the poller to retry with exponential backoff.
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
    await this.loadProcessedMessageIds(cursor);
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
        if (resp.errcode === -14 || resp.errcode === '-14') {
          this.logger.error(
            { errcode: resp.errcode, errmsg: resp.errmsg },
            'WeChat session expired — stopping poller',
          );
          this.onSessionExpired?.({
            errcode: -14,
            errmsg: String(resp.errmsg ?? ''),
          });
          this.running = false;
          return;
        }

        // Process messages before committing the batch cursor. Successful
        // message ids are durably checkpointed so a later failure can retry
        // the same upstream batch without re-running already completed turns.
        const messages = resp.msgs ?? [];
        if (messages.length > 0) {
          this.logger.debug({ msgCount: messages.length }, 'WeChat poller received messages');

          // Persist the freshest reply token before parallel message execution.
          // Doing this sequentially avoids concurrent writes clobbering tokens
          // for other users in the shared context-token file.
          for (const msg of messages) {
            if (msg.context_token && msg.from_user_id) {
              this.contextTokens.set(msg.from_user_id, msg.context_token);
            }
          }
          if (messages.some((msg) => msg.context_token && msg.from_user_id)) {
            await this.saveContextTokens();
          }

          const batchMessageIds = new Set<string>();
          const outcomes = await Promise.allSettled(
            messages.map(async (msg) => {
              if (msg.from_user_id?.endsWith('@im.bot')) {
                this.logger.info('Filtering out own message');
                return;
              }

              const messageId = getStableMessageId(msg);
              if (batchMessageIds.has(messageId)) return;
              batchMessageIds.add(messageId);
              if (this.processedMessageIds.has(messageId)) {
                this.logger.debug({ messageId }, 'Skipping previously completed WeChat message');
                return;
              }

              this.logger.debug(
                { from: msg.from_user_id, items: msg.item_list?.length, messageId },
                'Processing WeChat message',
              );
              await onMessage(msg);
              this.processedMessageIds.add(messageId);
              await this.saveProcessedMessageIds(cursor);
            }),
          );
          const failed = outcomes.find((outcome) => outcome.status === 'rejected');
          if (failed?.status === 'rejected') {
            this.logger.error(
              { err: failed.reason },
              'WeChat message batch failed; cursor retained',
            );
            throw failed.reason;
          }
        }

        // Persist the checkpoint before discarding per-message receipts. If the
        // process crashes after the cursor write, the receipt file's older
        // cursor will be ignored on restart.
        if (resp.get_updates_buf !== undefined) {
          const nextCursor = resp.get_updates_buf;
          await this.saveCursor(nextCursor);
          cursor = nextCursor;
          this.processedMessageIds.clear();
          try {
            await this.saveProcessedMessageIds(cursor);
          } catch (err) {
            // The cursor is already committed. A stale receipt file is safe:
            // loadProcessedMessageIds rejects it when its cursor does not match.
            this.logger.warn({ err }, 'Failed to clear committed WeChat message receipts');
          }
        }

        // Success — reset failure counter only after processing/checkpointing.
        consecutiveFailures = 0;
      } catch (err: unknown) {
        // Check for session expiry (errcode -14) — fatal
        if (isSessionExpiredError(err)) {
          this.logger.error({ err }, 'WeChat session expired — stopping poller');
          this.onSessionExpired?.({
            errcode: -14,
            errmsg: err instanceof Error ? err.message : String(err),
          });
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
        this.logger.warn({ err, consecutiveFailures }, 'WeChat poller transient error');

        const delayIndex = Math.min(consecutiveFailures - 1, BACKOFF_DELAYS.length - 1);
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
      await this.writeJsonAtomically(this.cursorFile, { get_updates_buf: cursor });
    } catch (err: unknown) {
      this.logger.error({ err }, 'Failed to save WeChat poll cursor');
      throw err;
    }
  }

  private async loadProcessedMessageIds(cursor: string): Promise<void> {
    this.processedMessageIds.clear();
    try {
      const raw = await fs.readFile(this.processedMessageFile, 'utf-8');
      const parsed = JSON.parse(raw) as { cursor?: unknown; messageIds?: unknown };
      if (parsed.cursor !== cursor || !Array.isArray(parsed.messageIds)) return;
      for (const id of parsed.messageIds) {
        if (typeof id === 'string') this.processedMessageIds.add(id);
      }
    } catch {
      // No receipts exist until the first successful message in a batch.
    }
  }

  private saveProcessedMessageIds(cursor: string): Promise<void> {
    const write = this.receiptWriteQueue.then(() =>
      this.writeJsonAtomically(this.processedMessageFile, {
        cursor,
        messageIds: [...this.processedMessageIds],
      }),
    );
    this.receiptWriteQueue = write.catch(() => undefined);
    return write;
  }

  private async writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(tempPath, JSON.stringify(value), { encoding: 'utf-8', mode: 0o600 });
      await fs.rename(tempPath, filePath);
    } catch (err) {
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
      throw err;
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
      await fs.writeFile(this.contextTokensFile, JSON.stringify(obj, null, 2), 'utf-8');
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

/** Stable id used to avoid repeating already completed work after batch retry. */
function getStableMessageId(msg: ILMessage): string {
  if (msg.client_id) return `${msg.from_user_id}:${msg.client_id}`;
  return `${msg.from_user_id}:${crypto.createHash('sha256').update(JSON.stringify(msg)).digest('hex')}`;
}

/**
 * Detect session-expired errors (errcode -14).
 */
function isSessionExpiredError(err: unknown): boolean {
  const message = String((err as Error)?.message || '');
  return /(?:ret|errcode)=-14\b/.test(message);
}
