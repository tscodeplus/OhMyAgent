/**
 * TelegramReplyDispatcher — bridges AgentService events to a StreamController
 * for incremental Telegram message updates.
 *
 * Implements the ReplyDispatcher interface so it can be plugged directly into
 * AgentService.execute() as a replyDispatcherOverride.
 */

import type { ReplyDispatcher, Usage, FooterConfig } from '../../src/app/types.js';
import type { TelegramConfig, StreamController } from './telegram-types.js';
import type { ReplyContent } from '../../src/channel/types.js';
import { summarizeToolInput } from '../../src/channel/tool-summary.js';
import { formatUsageSummary } from '../../src/channel/usage-summary.js';

export class TelegramReplyDispatcher implements ReplyDispatcher {
  private streamCtrl: StreamController;
  private bot: any;
  private chatId: number;
  private config: TelegramConfig;
  private showToolCalls: boolean;
  private footerConfig: FooterConfig;

  /** Full accumulated text (text deltas + tool annotations) for final rendering. */
  private buffer = '';

  private model = '';
  private agentName = '';
  private approvalStatus: string | null = null;
  private justCompletedTool = false;
  private startTime = 0;

  constructor(
    bot: any,
    chatId: number,
    streamCtrl: StreamController,
    config: TelegramConfig,
    showToolCalls = true,
    footerConfig?: FooterConfig,
  ) {
    this.bot = bot;
    this.chatId = chatId;
    this.streamCtrl = streamCtrl;
    this.config = config;
    this.showToolCalls = showToolCalls;
    this.footerConfig = footerConfig ?? { showAgentName: true, showModel: true, showCompleted: false, showElapsed: true, showUsage: false, showCacheHitRate: false };
  }

  // ------------------------------------------------------------------
  // ReplyDispatcher interface
  // ------------------------------------------------------------------

  async onStart(): Promise<void> {
    this.startTime = Date.now();
    await this.streamCtrl.start(this.chatId);
  }

  onTextDelta(delta: string): void {
    if (this.justCompletedTool) {
      delta = delta.replace(/^\n+/, '');
      this.justCompletedTool = false;
      if (delta) {
        delta = '\n\n' + delta;
      } else {
        return;
      }
    }
    this.buffer += delta;
    this.streamCtrl.onDelta(delta);
  }

  onReasoningDelta(_delta: string): void {
    // Reasoning output is deliberately suppressed in Telegram — it would
    // consume message space and is not useful in the chat UI.
  }

  /** Track tool args keyed by toolCallId — only flush on completion. */
  private pendingToolArgs = new Map<string, { name: string; args: unknown }>();

  onToolStart(name: string, args: unknown, toolCallId?: string): void {
    if (!this.showToolCalls) return;
    // Don't stream ⏳ — only show completed tool lines to avoid
    // duplicate lines (⏳ + ✅) and keep the Markdown output clean.
    const key = toolCallId ?? name;
    this.pendingToolArgs.set(key, { name, args });
  }

  onToolEnd(name: string, _result: unknown, isError?: boolean, toolCallId?: string): void {
    if (!this.showToolCalls) return;
    const key = toolCallId ?? name;
    const entry = this.pendingToolArgs.get(key);
    this.pendingToolArgs.delete(key);
    const icon = isError ? '❌' : '✅';
    const summary = summarizeToolInput(name, entry?.args);
    const truncated = summary.length > 100 ? summary.slice(0, 100) + '…' : summary;
    // No "> " prefix — Telegram uses HTML parse_mode where ">" is literal text,
    // and the Markdown→HTML converter doesn't handle blockquote syntax.
    const text = truncated
      ? `\n${icon} **${name}** — ${truncated}`
      : `\n${icon} **${name}**`;
    this.buffer += text;
    this.streamCtrl.onDelta(text);
    this.justCompletedTool = true;
  }

  setModel(model: string): void {
    this.model = model;
  }

  setAgentName(name: string): void {
    this.agentName = name;
  }

  setApprovalStatus(status: string | null): void {
    this.approvalStatus = status;
    if (status) {
      // Append the status as a visible hint in the streaming output.
      // StreamController has no dedicated status-line API, so onDelta is the
      // single text-append channel.
      this.streamCtrl.onDelta(`\n⏳ ${status}`);
    }
  }

  setApprovalRecords(
    _records: Array<{
      requestId: string;
      command: string;
      risk: 'low' | 'medium' | 'high';
      status: 'pending' | 'approved' | 'rejected';
      decision?: string;
      updatedAt: number;
    }>,
    _expanded: boolean,
  ): void {
    // Approval records are not rendered in Telegram for now.
    // Future iterations may add an inline-keyboard-based approve/reject flow.
  }

  getReplyMessageId(): string | undefined {
    const id = this.streamCtrl.getMessageId();
    return id != null ? String(id) : undefined;
  }

  async onComplete(usage?: Usage): Promise<void> {
    let finalText = this.buffer;
    const footerParts: string[] = [];
    if (this.footerConfig.showAgentName && this.agentName) footerParts.push(this.agentName);
    if (this.footerConfig.showElapsed && this.startTime) {
      const elapsedMs = Date.now() - this.startTime;
      const elapsed = elapsedMs < 60_000 ? `${(elapsedMs / 1000).toFixed(1)}s` : `${Math.floor(elapsedMs / 60_000)}m ${Math.floor((elapsedMs % 60_000) / 1000)}s`;
      footerParts.push(`耗时 ${elapsed}`);
    }
    if (this.footerConfig.showModel && this.model) footerParts.push(this.model);
    const usageSummary = formatUsageSummary(usage, this.footerConfig);
    if (usageSummary) footerParts.push(usageSummary);
    if (footerParts.length > 0) {
      finalText += `\n\n${footerParts.join(' · ')}`;
    }
    await this.streamCtrl.onComplete(finalText);
  }

  async onError(error: Error): Promise<void> {
    await this.streamCtrl.onError(error);
  }

  async onAborted(): Promise<void> {
    this.streamCtrl.abort();
  }

  // ------------------------------------------------------------------
  // Additional helpers
  // ------------------------------------------------------------------

  /**
   * Return a reply function compatible with ChannelAdapter.sendReply.
   *
   * This can be used to send non-streaming responses (command results,
   * error messages) through the same bot instance.
   */
  createReply(): (content: ReplyContent) => Promise<void> {
    return async (content: ReplyContent) => {
      if (content.text) {
        await this.bot.api
          .sendMessage(this.chatId, content.text, { parse_mode: 'HTML' })
          .catch(() => {});
      }
    };
  }
}
