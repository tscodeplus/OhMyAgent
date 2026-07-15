/**
 * Streaming card controller using CardKit 2.0 APIs.
 *
 * Manages the lifecycle of a CardKit streaming card:
 *   idle → creating → streaming → completed / aborted / error
 *
 * Handles throttled flushing, <think> tag parsing, and card state transitions.
 */

import type { Logger } from 'pino';
import { STREAMING_ELEMENT_ID, buildStreamingCard, buildCompletedCard } from './cardkit-builder.js';
import { isCardIdInvalidError } from '../feishu-client.js';
import type { FooterConfig, Usage } from '../../../src/app/types.js';
import { i18n } from '../../../src/i18n/index.js';
import { fixFeishuMarkdown } from './markdown-sanitizer.js';
import { summarizeToolInput } from '../../../src/channel/tool-summary.js';

// ─── Types ───

export type CardState = 'idle' | 'creating' | 'streaming' | 'completed' | 'aborted' | 'error';

const TERMINAL_STATES: ReadonlySet<CardState> = new Set(['completed', 'aborted', 'error']);

export interface StreamingCardControllerOptions {
  feishuClient: {
    createCard(cardData: Record<string, unknown>): Promise<string>;
    sendCardByCardId(chatId: string, cardId: string, replyToMessageId?: string): Promise<string>;
    streamCardContent(cardId: string, elementId: string, content: string, sequence: number): Promise<void>;
    setCardStreamingMode(cardId: string, streamingMode: boolean, sequence: number): Promise<void>;
    updateCard(cardId: string, cardData: Record<string, unknown>, sequence: number): Promise<void>;
    /** Fallback: update card via im.message.patch (non-CardKit). */
    updateMessage?(messageId: string, msgType: string, card: Record<string, unknown>): Promise<void>;
    /** Fallback: send a plain-text message when CardKit is unavailable. */
    sendMessage?(params: { receive_id: string; receive_id_type: string; msg_type: string; content: string }): Promise<unknown>;
    /** Fallback: reply with a plain-text message. */
    replyMessage?(messageId: string, params: { msg_type: string; content: string }): Promise<unknown>;
  };
  chatId: string;
  messageId?: string;
  /** Agent name for footer display. */
  agentName?: string;
  /** Model name for footer display. */
  model?: string;
  /** Footer display configuration. */
  footerConfig?: FooterConfig;
  /** Throttle interval in ms for card content updates. Default: 800. */
  flushIntervalMs?: number;
  logger?: Logger;
}

// ─── Controller ───

export class StreamingCardController {
  private state: CardState = 'idle';
  private readonly feishuClient: StreamingCardControllerOptions['feishuClient'];
  private readonly chatId: string;
  private readonly flushIntervalMs: number;
  private messageId?: string;
  private cardId?: string;

  // Text accumulation
  private pendingContent: string = '';
  private pendingThinking: string = '';

  // Think tag parsing state
  private thinkingTagOpen: boolean = false;
  private buffer: string = '';

  // Throttle / flush
  private flushTimer?: ReturnType<typeof setTimeout>;
  private lastFlushTime: number = 0;
  private flushInFlight: boolean = false;
  private flushRequested: boolean = false;
  // CardKit sequence — incremented before each API call.
  private sequence: number = 0;
  private cardOperationChain: Promise<void> = Promise.resolve();

  // Tool tracking (keyed by toolCallId for uniqueness; stores name for display)
  private toolIndicators: Map<string, { name: string; status: 'running' | 'done' | 'error'; args?: unknown }> = new Map();
  // Thinking dot animation cycle (0, 1, 2 → '.', '..', '...')
  private thinkingDotCycle = 0;
  // Fast animation timer for thinking dots (~600ms vs normal 2000ms flush)
  private thinkingAnimationTimer?: ReturnType<typeof setTimeout>;
  private finalCardSnapshot?: {
    thinking?: string;
    answer: string;
    footer?: string;
    elapsedMs?: number;
    model?: string;
    agentName?: string;
    usage?: Usage;
  };

  // Timing, model, and agent info for footer
  private startTime: number = 0;
  private model?: string;
  private agentName?: string;
  private usage?: Usage;
  private readonly footerConfig?: FooterConfig;
  private readonly logger?: Logger;

  constructor(options: StreamingCardControllerOptions) {
    this.feishuClient = options.feishuClient;
    this.chatId = options.chatId;
    this.messageId = options.messageId;
    this.model = options.model;
    this.agentName = options.agentName;
    this.footerConfig = options.footerConfig;
    this.flushIntervalMs = options.flushIntervalMs ?? 2000;
    this.logger = options.logger;
  }

  getState(): CardState {
    return this.state;
  }

  getMessageId(): string | undefined {
    return this.messageId;
  }

  /** Update the model name for the footer (call before complete()). */
  setModel(model: string): void {
    this.model = model;
  }

  /** Update the agent name for the footer (call before complete()). */
  setAgentName(name: string): void {
    this.agentName = name;
  }

  /** Update usage stats for the footer (call before complete()). */
  setUsage(usage?: Usage): void {
    this.usage = usage;
  }

  /** Get next sequence number, guaranteed to be higher than any previously used. */
  private nextSeq(): number {
    this.sequence += 1;
    return this.sequence;
  }

  private enqueueCardOperation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.cardOperationChain.then(operation, operation);
    this.cardOperationChain = run.then(() => undefined, () => undefined);
    return run;
  }

  // ─── Lifecycle Methods ───

  /**
   * Create the initial streaming card placeholder.
   * Transitions state: idle → creating → streaming.
   */
  async createPlaceholder(): Promise<void> {
    if (this.state !== 'idle') {
      throw new Error(`Cannot create placeholder in state: ${this.state}`);
    }

    this.state = 'creating';
    this.startTime = Date.now();

    try {
      const card = buildStreamingCard();
      this.cardId = await this.feishuClient.createCard(card);
      // Sequence starts at 0; incremented before each stream/set/update call
      try {
        this.messageId = await this.feishuClient.sendCardByCardId(
          this.chatId,
          this.cardId,
          this.messageId,
        );
      } catch (sendErr) {
        // Debug: log the raw error shape to help diagnose unrecognised variants.
        const errAny = sendErr as Record<string, unknown>;
        this.logger?.debug(
          {
            cardId: this.cardId,
            chatId: this.chatId,
            errMessage: (sendErr as Error)?.message ?? String(sendErr),
            errCode: errAny?.code,
            errDataCode: (errAny?.data as Record<string, unknown>)?.code,
            errResponseCode: (errAny?.response as Record<string, unknown>)?.code,
            errResponseDataCode: ((errAny?.response as Record<string, unknown>)?.data as Record<string, unknown>)?.code,
            errKeys: Object.keys(sendErr as object).slice(0, 20),
            isCardIdInvalid: isCardIdInvalidError(sendErr),
          },
          'CardKit sendCardByCardId failed — error diagnostics',
        );

        // If cardId was invalid, rebuild the card and retry once with a fresh cardId.
        // Retrying the same cardId is futile — an invalid cardId stays invalid.
        if (isCardIdInvalidError(sendErr)) {
          this.logger?.debug(
            { oldCardId: this.cardId },
            'CardKit sendCardByCardId failed with invalid cardId, recreating card',
          );
          try {
            const newCard = buildStreamingCard();
            this.cardId = await this.feishuClient.createCard(newCard);
            this.messageId = await this.feishuClient.sendCardByCardId(
              this.chatId,
              this.cardId,
              this.messageId,
            );
            this.logger?.debug(
              { newCardId: this.cardId },
              'CardKit card recreated successfully after cardid-invalid',
            );
          } catch (retryErr) {
            // Retry also failed — log and throw so the caller can fall back to text.
            const rErr = retryErr as Record<string, unknown>;
            this.logger?.debug(
              {
                newCardId: this.cardId,
                retryErrMessage: (retryErr as Error)?.message ?? String(retryErr),
                retryErrCode: rErr?.code,
                retryErrDataCode: (rErr?.data as Record<string, unknown>)?.code,
                retryErrResponseCode: (rErr?.response as Record<string, unknown>)?.code,
              },
              'CardKit sendCardByCardId retry with fresh card also failed',
            );
            throw retryErr;
          }
        } else {
          throw sendErr;
        }
      }
      this.lastFlushTime = Date.now();
      this.state = 'streaming';

      // Immediately show initial status so the card isn't blank
      this.logger?.debug('[thinking-dots] createPlaceholder done, calling flushNow');
      void this.flushNow();
    } catch (err) {
      this.state = 'error';
      throw err;
    }
  }

  /**
   * Append a text delta and stream it to the card.
   * Parses <think> tags to separate thinking from answer content.
   */
  appendDelta(delta: string): void {
    if (this.state !== 'streaming') return;

    // Track whether we already had answer content before processing
    const hadContent = this.pendingContent.trim().length > 0;

    // Process delta through think tag parser
    this.processDelta(delta);

    // When the first answer content arrives (transition from thinking →
    // content), stop the dots animation and flush immediately to show the
    // real text. Don't use cancelScheduledFlush() here — it also kills the
    // flushTimer which may still be needed for subsequent delta flushes.
    if (!hadContent && this.pendingContent.trim().length > 0) {
      this.logger?.debug({ pendingLen: this.pendingContent.length }, '[thinking-dots] first content arrived, stopping animation + flushing');
      this.stopThinkingAnimation();
      this.requestFlush();
    } else {
      // Schedule throttled flush
      this.scheduleFlush();
    }
  }

  /**
   * Flush immediately bypassing throttle. Used to show initial card content
   * right after creation so the card doesn't appear blank.
   */
  private flushNow(): void {
    if (this.state !== 'streaming' || !this.cardId) return;
    this.cancelScheduledFlush();
    this.requestFlush();
  }

  /**
   * Show a tool execution indicator with optional args for display summary.
   */
  markToolRunning(toolName: string, args?: unknown, toolCallId?: string): void {
    if (this.state !== 'streaming') return;
    const key = toolCallId ?? toolName;
    this.toolIndicators.set(key, { name: toolName, status: 'running', args });
    this.cancelScheduledFlush();
    this.requestFlush();
  }

  /**
   * Mark a tool as completed (success). Preserves args from running state.
   */
  markToolComplete(toolName: string, toolCallId?: string): void {
    if (this.state !== 'streaming') return;
    const key = toolCallId ?? toolName;
    const existing = this.toolIndicators.get(key);
    this.toolIndicators.set(key, { name: toolName, status: 'done', args: existing?.args });
    this.cancelScheduledFlush();
    this.requestFlush();
  }

  /**
   * Mark a tool as failed (error). Preserves args from running state.
   */
  markToolError(toolName: string, toolCallId?: string): void {
    if (this.state !== 'streaming') return;
    const key = toolCallId ?? toolName;
    const existing = this.toolIndicators.get(key);
    this.toolIndicators.set(key, { name: toolName, status: 'error', args: existing?.args });
    this.cancelScheduledFlush();
    this.requestFlush();
  }

  /**
   * Flush tool indicators as permanent text and clear them from the active set.
   * Called once tool execution is done and answer text is about to stream.
   */
  flushToolIndicators(): string {
    let text = '';
    for (const [name, info] of this.toolIndicators) {
      const summary = info.args ? summarizeToolInput(name, info.args) : '';
      text += formatToolLine(info.status === 'running' ? 'running' : info.status === 'done' ? 'done' : 'error', name, summary) + '\n';
    }
    this.toolIndicators.clear();
    return text;
  }

  /**
   * Flush remaining content and build the completed card.
   * Transitions state: streaming → completed.
   */
  async complete(usage?: Usage): Promise<void> {
    if (this.state === 'completed') return; // idempotent

    // If the card was never successfully created (state is 'error' or 'creating'
    // from a failed createPlaceholder), fall back to sending the answer as a
    // plain-text message so the user still sees the response.
    if (this.state !== 'streaming') {
      const answer = this.buildFinalAnswer();
      if (answer) {
        this.logger?.info(
          { state: this.state, answerLen: answer.length },
          'CardKit unavailable, sending answer as text fallback',
        );
        await this.sendTextFallback(answer);
      }
      return;
    }

    this.setUsage(usage);

    this.cancelScheduledFlush();
    this.state = 'completed';

    try {
      // Build the final answer text (strip any unclosed think tags)
      const answer = this.buildFinalAnswer() || this.pendingThinking || i18n.t('feishu-cards:stream.noResponse');
      const thinking = this.pendingThinking || undefined;
      const elapsedMs = this.startTime ? Date.now() - this.startTime : undefined;
      this.finalCardSnapshot = { thinking, answer, elapsedMs, model: this.model, agentName: this.agentName, usage: this.usage };

      // Close streaming mode first (official implementation pattern)
      await this.enqueueCardOperation(async () => {
        const seq1 = this.nextSeq();
        await this.feishuClient.setCardStreamingMode(this.cardId!, false, seq1);
      });

      // Replace with completed card (includes streaming_mode: false)
      const completedCard = this.buildTerminalCard();
      try {
        await this.enqueueCardOperation(async () => {
          const seq2 = this.nextSeq();
          await this.feishuClient.updateCard(this.cardId!, completedCard, seq2);
        });
      } catch (updateErr) {
        // CardKit card.update failed — fall back to im.message.patch
        this.logger?.warn({ err: updateErr }, 'CardKit updateCard failed, falling back to im.message.patch');
        if (this.messageId && this.feishuClient.updateMessage) {
          // Convert CardKit 2.0 format to standard interactive card format
          const standardCard = {
            elements: (completedCard.body as any)?.elements ?? [],
          };
          await this.feishuClient.updateMessage(this.messageId, 'interactive', standardCard);
        }
      }
    } catch (err) {
      // Error during finalization — state remains 'completed'
    }
  }

  /**
   * Send the accumulated answer as a plain-text message when CardKit is
   * unavailable (e.g. card creation failed with cardid-invalid).
   *
   * Prefers replyMessage (threaded reply) when a messageId is available;
   * otherwise falls back to sendMessage (new message in the chat).
   */
  private async sendTextFallback(answer: string): Promise<void> {
    const content = JSON.stringify({ text: answer });
    try {
      if (this.messageId && this.feishuClient.replyMessage) {
        await this.feishuClient.replyMessage(this.messageId, {
          msg_type: 'text',
          content,
        });
        this.logger?.debug({ messageId: this.messageId }, 'Text fallback sent via replyMessage');
      } else if (this.feishuClient.sendMessage) {
        await this.feishuClient.sendMessage({
          receive_id: this.chatId,
          receive_id_type: 'chat_id',
          msg_type: 'text',
          content,
        });
        this.logger?.debug({ chatId: this.chatId }, 'Text fallback sent via sendMessage');
      }
    } catch (fallbackErr) {
      this.logger?.warn({ err: fallbackErr }, 'Text fallback also failed');
    }
  }

  /**
   * Show error state on the card.
   * Transitions state: streaming → error.
   */
  async fail(error: string): Promise<void> {
    if (this.state === 'completed' || this.state === 'aborted' || this.state === 'error') return;

    this.cancelScheduledFlush();
    this.state = 'error';

    try {
      // Close streaming mode first (official implementation pattern)
      await this.enqueueCardOperation(async () => {
        const seq1 = this.nextSeq();
        await this.feishuClient.setCardStreamingMode(this.cardId!, false, seq1);
      });

      // Build error card (includes streaming_mode: false)
      const elapsedMs = this.startTime ? Date.now() - this.startTime : undefined;
      this.finalCardSnapshot = {
        answer: `${i18n.t('feishu-cards:stream.errorPrefix')}${error}`,
        footer: i18n.t('feishu-cards:stream.errorFooter'),
        elapsedMs,
        model: this.model,
        agentName: this.agentName,
        usage: this.usage,
      };
      await this.enqueueCardOperation(async () => {
        const seq2 = this.nextSeq();
        await this.feishuClient.updateCard(this.cardId!, this.buildTerminalCard(), seq2);
      });
    } catch (err) {
    }
  }

  /**
   * Show aborted state on the card.
   * Transitions state: streaming → aborted.
   */
  async abort(): Promise<void> {
    if (this.state === 'completed' || this.state === 'aborted' || this.state === 'error') return;

    this.cancelScheduledFlush();
    this.state = 'aborted';

    try {
      // Close streaming mode
      await this.enqueueCardOperation(async () => {
        const seq1 = this.nextSeq();
        await this.feishuClient.setCardStreamingMode(this.cardId!, false, seq1);
      });

      // Keep answer content, discard thinking, append stop marker
      const elapsedMs = this.startTime ? Date.now() - this.startTime : undefined;
      const baseAnswer = this.buildFinalAnswer().trim();
      const stopped = i18n.t('feishu-cards:stream.stopped');
      const answer = baseAnswer ? `${baseAnswer}\n\n${stopped}` : stopped;
      this.finalCardSnapshot = {
        answer,
        thinking: undefined,
        footer: undefined,
        elapsedMs,
        model: this.model,
        agentName: this.agentName,
        usage: this.usage,
      };
      await this.enqueueCardOperation(async () => {
        const seq2 = this.nextSeq();
        await this.feishuClient.updateCard(this.cardId!, this.buildTerminalCard(), seq2);
      });
    } catch {
      // Swallow errors during abort finalization
    }
  }

  // ─── Think Tag Parsing ───

  /**
   * Process a delta through <think> tag state machine.
   * Handles partial tags split across deltas.
   */
  private processDelta(delta: string): void {
    this.buffer += delta;

    // Process the buffer character by character to handle partial tags
    let i = 0;
    const THINK_OPEN = '<think>';
    const THINK_CLOSE = '</think>';

    while (i < this.buffer.length) {
      if (!this.thinkingTagOpen) {
        // Looking for <think> tag
        const openIdx = this.buffer.indexOf(THINK_OPEN, i);
        if (openIdx === -1) {
          // No opening tag found — check if there's a partial match at the end
          const remaining = this.buffer.slice(i);
          const keepLen = partialTagAtEnd(remaining, THINK_OPEN);
          if (keepLen > 0) {
            // Keep partial tag in buffer for next delta
            this.pendingContent += remaining.slice(0, remaining.length - keepLen);
            this.buffer = remaining.slice(remaining.length - keepLen);
          } else {
            this.pendingContent += remaining;
            this.buffer = '';
          }
          break;
        }

        // Append text before the opening tag
        this.pendingContent += this.buffer.slice(i, openIdx);

        // Check if we have the full opening tag
        if (openIdx + THINK_OPEN.length <= this.buffer.length) {
          this.thinkingTagOpen = true;
          i = openIdx + THINK_OPEN.length;
        } else {
          // Partial opening tag — keep only the partial tag in buffer
          this.pendingContent += this.buffer.slice(i, openIdx);
          this.buffer = this.buffer.slice(openIdx);
          break;
        }
      } else {
        // Inside thinking block — look for  tag
        const closeIdx = this.buffer.indexOf(THINK_CLOSE, i);
        if (closeIdx === -1) {
          // No closing tag found — check for partial match at end
          const remaining = this.buffer.slice(i);
          const keepLen = partialTagAtEnd(remaining, THINK_CLOSE);
          if (keepLen > 0) {
            this.pendingThinking += remaining.slice(0, remaining.length - keepLen);
            this.buffer = remaining.slice(remaining.length - keepLen);
          } else {
            this.pendingThinking += remaining;
            this.buffer = '';
          }
          break;
        }

        // Append thinking content before the closing tag
        this.pendingThinking += this.buffer.slice(i, closeIdx);

        // Check if we have the full closing tag
        if (closeIdx + THINK_CLOSE.length <= this.buffer.length) {
          this.thinkingTagOpen = false;
          i = closeIdx + THINK_CLOSE.length;
        } else {
          // Partial closing tag — keep only the partial tag in buffer
          this.pendingThinking += this.buffer.slice(i, closeIdx);
          this.buffer = this.buffer.slice(closeIdx);
          break;
        }
      }
    }
  }

  // ─── Flush Logic ───

  private scheduleFlush(): void {
    if (this.state !== 'streaming') return;

    const now = Date.now();
    const elapsed = now - this.lastFlushTime;

    if (elapsed >= this.flushIntervalMs) {
      this.cancelScheduledFlush();
      this.requestFlush();
    } else if (!this.flushTimer) {
      const delay = this.flushIntervalMs - elapsed;
      this.flushTimer = setTimeout(() => {
        this.flushTimer = undefined;
        this.requestFlush();
      }, delay);
    }
  }

  private cancelScheduledFlush(): void {
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.stopThinkingAnimation();
  }

  private requestFlush(): void {
    if (this.state !== 'streaming' || !this.cardId) return;
    this.flushRequested = true;
    void this.drainFlushQueue();
  }

  private async drainFlushQueue(): Promise<void> {
    if (this.flushInFlight) return;
    this.flushInFlight = true;

    try {
      while (this.flushRequested && this.state === 'streaming' && this.cardId) {
        this.flushRequested = false;

        let flushSucceeded = false;
        try {
          const content = this.buildStreamContent();
          this.logger?.debug({ content: content.slice(0, 80), cycle: this.thinkingDotCycle }, '[thinking-dots] flush');
          await this.enqueueCardOperation(async () => {
            const seq = this.nextSeq();
            await this.feishuClient.streamCardContent(
              this.cardId!,
              STREAMING_ELEMENT_ID,
              content,
              seq,
            );
          });
          this.lastFlushTime = Date.now();
          flushSucceeded = true;
        } catch (err) {
          if (this.logger) {
            const msg = err instanceof Error ? err.message : String(err);
            this.logger.warn({ err: msg.slice(0, 100) }, '[thinking-dots] flush error');
          }
        }

        // Always evaluate animation state after each flush attempt,
        // even if the flush failed. This prevents the card from
        // getting stuck showing thinking dots when content is ready.
        if (this.isThinkingOnly()) {
          this.logger?.debug('[thinking-dots] isThinkingOnly=true, starting animation timer');
          this.startThinkingAnimation();
        } else {
          this.logger?.debug('[thinking-dots] isThinkingOnly=false, stopping animation timer');
          this.stopThinkingAnimation();
          // If we have content but the flush failed, ensure a retry
          if (!flushSucceeded && this.pendingContent.trim()) {
            this.scheduleFlush();
          }
        }
      }
    } finally {
      this.flushInFlight = false;
    }
  }

  /**
   * Build the streaming content text.
   * Running tools always shown on top with ⏳.
   * Answer text (with completed tool lines woven in) shown below.
   * When neither: show 🧠 thinking + cycling dots.
   */
  private buildStreamContent(): string {
    const sections: string[] = [];

    // Show completed tool lines + answer text first (older content on top)
    if (this.pendingContent.trim()) {
      sections.push(fixFeishuMarkdown(this.pendingContent.trimEnd()));
    }

    // Show running tools below completed content
    for (const [, info] of this.toolIndicators) {
      if (info.status === 'running') {
        const summary = info.args ? summarizeToolInput(info.name, info.args) : '';
        sections.push(formatToolLine('running', info.name, summary));
      }
    }

    // If nothing at all → show thinking with cycling dots (1→2→3→0→1)
    if (sections.length === 0) {
      // Cycle: 0→1, 1→2, 2→3, 3→0, 4→1, ...
      const dotCount = ((this.thinkingDotCycle % 4) + 1) % 4;
      const dots = '.'.repeat(dotCount);
      this.thinkingDotCycle++;
      sections.push(`🧠 ${i18n.t('feishu-cards:stream.thinkingShort')}${dots}`);
    }

    return sections.join('\n');
  }

  /**
   * Whether the card is currently showing only the thinking indicator
   * (no answer content, no running tools).
   */
  private isThinkingOnly(): boolean {
    const hasContent = this.pendingContent.trim().length > 0;
    const hasRunningTools = [...this.toolIndicators.values()].some(i => i.status === 'running');
    const result = !hasContent && !hasRunningTools;
    this.logger?.debug({ hasContent, hasRunningTools, result }, '[thinking-dots] isThinkingOnly');
    return result;
  }

  /** Start a faster flush cycle to animate the thinking dots (1→2→3→1). */
  private startThinkingAnimation(): void {
    if (this.thinkingAnimationTimer) return; // already running
    this.logger?.debug({ cycle: this.thinkingDotCycle }, '[thinking-dots] startThinkingAnimation');
    this.thinkingAnimationTimer = setTimeout(() => {
      this.thinkingAnimationTimer = undefined;
      if (this.state === 'streaming' && this.isThinkingOnly()) {
        this.logger?.debug('[thinking-dots] animation timer fired, requesting flush');
        this.requestFlush();
      } else {
        this.logger?.debug({ state: this.state }, '[thinking-dots] animation timer fired but conditions not met');
      }
    }, 600);
  }

  /** Stop the thinking dots animation timer. */
  private stopThinkingAnimation(): void {
    if (this.thinkingAnimationTimer) {
      this.logger?.debug('[thinking-dots] stopThinkingAnimation');
      clearTimeout(this.thinkingAnimationTimer);
      this.thinkingAnimationTimer = undefined;
    }
  }

  /**
   * Build the final answer, stripping any unclosed think tags.
   */
  private buildFinalAnswer(): string {
    // If there's remaining content in buffer that wasn't processed
    const leftover = this.buffer;
    let answer = this.pendingContent;
    let thinking = this.pendingThinking;

    // Process any leftover buffer
    if (leftover) {
      if (!this.thinkingTagOpen) {
        answer += leftover;
      } else {
        thinking += leftover;
      }
    }

    // Strip any incomplete/partial think tags from the answer
    answer = answer.replace(/<\s*think(?:ing)?\s*>$/i, '').trim();

    return fixFeishuMarkdown(answer);
  }

  private buildTerminalCard(): Record<string, unknown> {
    const snapshot = this.finalCardSnapshot ?? {
      answer: this.buildFinalAnswer() || this.pendingThinking || i18n.t('feishu-cards:stream.noResponse'),
      thinking: this.pendingThinking || undefined,
      elapsedMs: this.startTime ? Date.now() - this.startTime : undefined,
      model: this.model,
      agentName: this.agentName,
      usage: this.usage,
    };
    return buildCompletedCard({
      ...snapshot,
      footerConfig: this.footerConfig,
    });
  }

}

// ─── Helpers ───

/**
 * Format a single tool call line for streaming display.
 *   running → > ⏳ **Bash** — echo '...'
 *   done    → > ✅ **Bash** — echo '...'
 *   error   → > ❌ **Bash** — echo '...'
 */
function formatToolLine(status: 'running' | 'done' | 'error', name: string, summary: string): string {
  const icon = status === 'done' ? '✅' : status === 'error' ? '❌' : '⏳';
  const truncated = summary.length > 100 ? summary.slice(0, 100) + '…' : summary;
  if (truncated) {
    return `> ${icon} **${name}** — ${truncated}`;
  }
  return `> ${icon} **${name}**`;
}

/**
 * Check if `text` ends with a partial prefix of `tag`.
 * Returns the number of characters to keep in the buffer (0 if no match).
 */
function partialTagAtEnd(text: string, tag: string): number {
  if (!text || !tag) return 0;

  // Search backwards for '<' — the start character of any tag
  const ltIdx = text.lastIndexOf('<');
  if (ltIdx === -1) return 0;

  const suffix = text.slice(ltIdx);
  if (tag.startsWith(suffix)) {
    return suffix.length;
  }
  return 0;
}
