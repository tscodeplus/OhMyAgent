/**
 * StreamController — "edit" mode streaming for Telegram.
 *
 * Sends a single placeholder message ("[...]"), then repeatedly replaces its
 * text with the accumulated LLM output via editMessageText (HTML parse_mode).
 *
 * **HTML-tag safety**:
 * The flush method checks whether the accumulated text ends in the middle of
 * an incomplete HTML tag (one of `<b>`, `<i>`, `<code>`, `<pre>`, `<a ...>`)
 * and truncates before the tag boundary to avoid sending malformed HTML that
 * the Telegram API would reject.
 */

import type { StreamController } from './telegram-types.js';
import { sendChunkedText } from './send-message.js';
import { markdownToHtml } from './markdown-to-html.js';

/** Tags that we must not split mid-sequence. */
const TRACKED_TAGS = ['b', 'i', 'code', 'pre', 'a'];

const TRACKED_TAG_PATTERN = new RegExp(
  `^</?(${TRACKED_TAGS.join('|')})(\\s[^>]*)?$`,
  'i',
);

export class StreamControllerImpl implements StreamController {
  private bot: any;
  private chatId: number;
  private intervalMs: number;
  private textLimit: number;
  private logger: any;

  /** The message id of the placeholder / live-edited message. */
  private messageId: number | null = null;

  /** Complete text accumulated from all onDelta calls. */
  private fullText = '';

  /** How far into fullText we have already flushed via editMessageText. */
  private lastFlushedIndex = 0;

  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(
    bot: any,
    chatId: number,
    intervalMs: number,
    textLimit: number,
    logger: any,
  ) {
    this.bot = bot;
    this.chatId = chatId;
    this.intervalMs = intervalMs;
    this.textLimit = textLimit;
    this.logger = logger;
  }

  // ------------------------------------------------------------------
  // StreamController interface
  // ------------------------------------------------------------------

  async start(chatId: number): Promise<number> {
    try {
      const msg = await this.bot.api.sendMessage(chatId, '[...]');
      this.messageId = msg.message_id;
      this.stopped = false;

      this.flushTimer = setInterval(() => this.flush(), this.intervalMs);
      return msg.message_id;
    } catch (err) {
      this.logger.error({ err }, 'Failed to send placeholder message');
      throw err;
    }
  }

  onDelta(delta: string): void {
    if (this.stopped) return;
    this.fullText += delta;
  }

  getMessageId(): number | null {
    return this.messageId;
  }

  async onComplete(finalText: string): Promise<void> {
    this.stopped = true;
    this.stopTimer();

    // Convert Markdown → HTML for the final render
    const html = markdownToHtml(finalText);
    this.fullText = html;
    this.lastFlushedIndex = html.length;

    if (!this.messageId) {
      if (html.length <= 4096) {
        try {
          const msg = await this.bot.api.sendMessage(
            this.chatId,
            html,
            { parse_mode: 'HTML' },
          );
          this.messageId = msg.message_id;
        } catch {
          await this.bot.api
            .sendMessage(this.chatId, stripHtmlTags(html))
            .catch(() => {});
        }
      } else {
        await sendChunkedText(
          this.bot.api,
          this.chatId,
          html,
          this.textLimit,
        );
      }
      return;
    }

    if (html.length <= 4096) {
      try {
        await this.bot.api.editMessageText(
          this.chatId,
          this.messageId,
          html,
          { parse_mode: 'HTML' },
        );
      } catch (err: any) {
        // HTML parse error → retry without formatting
        if (
          err?.error_code === 400 &&
          err?.description?.includes('parse')
        ) {
          await this.bot.api
            .editMessageText(
              this.chatId,
              this.messageId,
              stripHtmlTags(html),
            )
            .catch(() => {});
        } else {
          // Other errors (network, rate limit, stale message) →
          // send a fresh message so the user sees formatted output
          try {
            const msg = await this.bot.api.sendMessage(
              this.chatId,
              html,
              { parse_mode: 'HTML' },
            );
            this.messageId = msg.message_id;
          } catch {
            await this.bot.api
              .sendMessage(this.chatId, stripHtmlTags(html))
              .catch(() => {});
          }
        }
      }
    } else {
      try {
        await this.bot.api.deleteMessage(this.chatId, this.messageId);
      } catch { /* ignore */ }
      this.messageId = null;
      await sendChunkedText(
        this.bot.api,
        this.chatId,
        html,
        this.textLimit,
      );
    }
  }

  async onError(error: Error): Promise<void> {
    this.stopped = true;
    this.stopTimer();

    if (this.messageId) {
      try {
        await this.bot.api.editMessageText(
          this.chatId,
          this.messageId,
          `⚠️ Error: ${error.message}`,
        );
      } catch {
        // Best-effort — the message may have been deleted.
      }
    }
  }

  abort(): void {
    this.stopped = true;
    this.stopTimer();
  }

  // ------------------------------------------------------------------
  // Internal
  // ------------------------------------------------------------------

  /**
   * Periodic flush callback. Attempts to send the accumulated text up to a
   * safe boundary (not splitting HTML tags).  Skips the edit when there is
   * no new content to send.
   */
  private flush(): void {
    if (this.stopped || !this.messageId) return;

    const unflushedLength = this.fullText.length - this.lastFlushedIndex;
    if (unflushedLength === 0) return;

    const safeEnd = findSafeHtmlEnd(this.fullText);
    const textToSend = safeEnd > 0 ? this.fullText.slice(0, safeEnd) : '';

    // Nothing new to send after applying the HTML-safety truncation.
    if (textToSend.length <= this.lastFlushedIndex) return;

    this.lastFlushedIndex = safeEnd;

    // Intermediate flushes use plain text to avoid broken HTML from
    // partial Markdown output. The final render in onComplete() converts
    // Markdown → HTML with parse_mode: 'HTML'.
    this.bot.api
      .editMessageText(this.chatId, this.messageId, textToSend, {
        disable_web_page_preview: true,
      })
      .catch(() => {});
  }

  private stopTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }
}

// ---------------------------------------------------------------------------
// HTML-safety helpers
// ---------------------------------------------------------------------------

/**
 * Find the index at which it is safe to truncate `text` so that the
 * resulting string does not end in the middle of a tracked HTML tag
 * (b, i, code, pre, a).
 *
 * Returns `text.length` when the whole string is safe to use.
 */
function findSafeHtmlEnd(text: string): number {
  const lastOpen = text.lastIndexOf('<');
  if (lastOpen === -1) return text.length;

  const afterLastOpen = text.slice(lastOpen);

  // If the `<` is followed by a `>` the construct is a complete tag.
  if (afterLastOpen.includes('>')) return text.length;

  // Check whether the incomplete construct looks like one of our tracked
  // tags (e.g. `<b`, `</i`, `<a href=...`).  If so, truncate before the `<`.
  if (TRACKED_TAG_PATTERN.test(afterLastOpen)) return lastOpen;

  // The `<` is not part of a tracked tag construct — safe.
  return text.length;
}

/** Strip all HTML tags from a string (plain-text fallback). */
function stripHtmlTags(text: string): string {
  return text.replace(/<[^>]*>/g, '');
}
