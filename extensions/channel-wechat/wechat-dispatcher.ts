/**
 * WechatReplyDispatcher — bridges AgentService events to text replies
 * for WeChat.
 *
 * WeChat (iLink) does not support editing messages or streaming
 * intermediate updates. All text deltas are buffered and the final
 * complete response is sent as a single (or chunked) message on
 * onComplete().
 *
 * Supports typing indicators and placeholder messages via optional
 * callbacks.
 *
 * Implements the ReplyDispatcher interface so it can be plugged into
 * AgentService.execute() as a replyDispatcherOverride.
 */

import type { ReplyDispatcher, Usage, FooterConfig } from '../../src/app/types.js';
import { StreamingMarkdownFilter } from './markdown-filter.js';
import { summarizeToolInput } from '../../src/channel/tool-summary.js';
import { formatUsageSummary } from '../../src/channel/usage-summary.js';

/** Typing keepalive interval in milliseconds. */
const TYPING_KEEPALIVE_MS = 5000;

export interface WechatReplyDispatcherOptions {
  /** Async function that sends a text reply. Called on onComplete(). */
  sendText: (text: string) => Promise<void>;
  /** Optional: send typing indicator. */
  startTyping?: () => Promise<void>;
  /** Optional: cancel typing indicator. */
  stopTyping?: () => Promise<void>;
  /** Optional: send a placeholder message with GENERATING state. */
  sendPlaceholder?: () => Promise<void>;
  /** Show tool execution indicators. Default: true. */
  showToolCalls?: boolean;
  /** Show skill activation notifications. Default: true. */
  showSkillCalls?: boolean;
  /** Footer display configuration. */
  footerConfig?: FooterConfig;
}

export class WechatReplyDispatcher implements ReplyDispatcher {
  /** Full accumulated response text. */
  private buffer = '';
  private model = '';
  private agentName = '';
  private approvalStatus: string | null = null;
  private typingInterval?: ReturnType<typeof setInterval>;
  private justCompletedTool = false;
  private footerConfig: FooterConfig;
  private showSkillCalls: boolean;
  private startTime = 0;

  constructor(private options: WechatReplyDispatcherOptions) {
    this.showSkillCalls = options.showSkillCalls !== false;
    this.footerConfig = options.footerConfig ?? { showAgentName: true, showModel: true, showCompleted: false, showElapsed: true, showUsage: false, showCacheHitRate: false };
  }

  // -------------------------------------------------------------------------
  // ReplyDispatcher interface
  // -------------------------------------------------------------------------

  onStart(): void {
    this.startTime = Date.now();

    // 1. Send typing indicator
    this.options.startTyping?.();

    // 2. Start typing keepalive interval (5s)
    this.typingInterval = setInterval(() => {
      this.options.startTyping?.();
    }, TYPING_KEEPALIVE_MS);

    // 3. Send placeholder message with GENERATING state
    this.options.sendPlaceholder?.();
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
  }

  onReasoningDelta(_delta: string): void {
    // Reasoning output is suppressed — it would clutter WeChat messages
    // and is not useful in the chat UI.
  }

  /** Track exact ⏳ line text keyed by toolCallId for precise replacement. */
  private pendingToolLines = new Map<string, string>();

  onToolStart(name: string, args: unknown, toolCallId?: string): void {
    if (this.options.showToolCalls === false) return;
    const summary = summarizeToolInput(name, args);
    const truncated = summary.length > 100 ? summary.slice(0, 100) + '…' : summary;
    const line = truncated
      ? `\n> ⏳ **${name}** — ${truncated}`
      : `\n> ⏳ **${name}**`;
    this.buffer += line;
    const key = toolCallId ?? name;
    this.pendingToolLines.set(key, line);
  }

  onToolEnd(name: string, _result: unknown, isError?: boolean, toolCallId?: string): void {
    if (this.options.showToolCalls === false) return;
    const key = toolCallId ?? name;
    const oldLine = this.pendingToolLines.get(key);
    this.pendingToolLines.delete(key);
    const icon = isError ? '❌' : '✅';
    if (oldLine) {
      const newLine = oldLine.replace('⏳', icon);
      this.buffer = this.buffer.replace(oldLine, newLine);
    }
    this.justCompletedTool = true;
  }

  setModel(model: string): void {
    this.model = model;
  }

  setAgentName(name: string): void {
    this.agentName = name;
  }

  onSkillActivated(skillName: string): void {
    if (!this.showSkillCalls) return;
    this.buffer += `\n> ⚡️ 技能激活: **${skillName}**`;
  }

  setApprovalStatus(status: string | null): void {
    this.approvalStatus = status;
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
    // Approval records not rendered in WeChat.
  }

  getReplyMessageId(): string | undefined {
    // WeChat does not return a message ID for sent messages.
    return undefined;
  }

  async onComplete(usage?: Usage): Promise<void> {
    // 1. Stop typing keepalive
    this.clearTypingInterval();

    // 2. Send cancel typing
    await this.options.stopTyping?.();

    if (!this.buffer) {
      return;
    }

    // 3. Send final filtered text
    const filter = new StreamingMarkdownFilter();
    let finalText = filter.feed(this.buffer) + filter.flush();

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

    await this.options.sendText(finalText);
  }

  async onError(error: Error): Promise<void> {
    this.clearTypingInterval();
    await this.options.stopTyping?.();

    const errorText = `Error: ${error.message}`;
    await this.options.sendText(errorText).catch(() => {});
  }

  async onAborted(): Promise<void> {
    this.clearTypingInterval();
    await this.options.stopTyping?.();
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private clearTypingInterval(): void {
    if (this.typingInterval) {
      clearInterval(this.typingInterval);
      this.typingInterval = undefined;
    }
  }
}
