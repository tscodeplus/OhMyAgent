// ---------------------------------------------------------------------------
// QQReplyDispatcher — bridges AgentService events to QQ one-shot messages.
//
// Implements the ReplyDispatcher interface for non-streaming output.
// All text deltas are buffered and sent as a single (or chunked) message
// when onComplete() is called. Tool start/end markers are appended inline.
//
// QQ Bot API does not support message editing, so there is no incremental
// update mechanism — everything is assembled and sent at completion.
// ---------------------------------------------------------------------------

import type { ReplyDispatcher, Usage, FooterConfig } from '../../src/app/types.js';
import type { QQGateway, ReplyTracker } from './qq-gateway.js';
import type { QQConfig } from './qq-types.js';
import { sendChunkedText } from './send-message.js';
import { summarizeToolInput } from '../../src/channel/tool-summary.js';
import { formatUsageSummary } from '../../src/channel/usage-summary.js';

export class QQReplyDispatcher implements ReplyDispatcher {
  /** Accumulated text deltas + tool annotations. */
  private buffer = '';

  private model = '';
  private agentName = '';
  private hasContent = false;
  private showToolCalls: boolean;
  private showSkillCalls: boolean;
  private footerConfig: FooterConfig;
  private justCompletedTool = false;
  private startTime = 0;

  /** Optional reply tracker for rate-limit recording. */
  private replyTracker: ReplyTracker | null = null;
  private replyTrackerOpenid: string | null = null;

  constructor(
    private gateway: QQGateway,
    private target: { openid?: string; groupOpenid?: string },
    private config: QQConfig,
    showToolCalls = true,
    showSkillCalls = true,
    footerConfig?: FooterConfig,
  ) {
    this.showToolCalls = showToolCalls;
    this.showSkillCalls = showSkillCalls;
    this.footerConfig = footerConfig ?? { showAgentName: true, showModel: true, showCompleted: false, showElapsed: true, showUsage: false, showCacheHitRate: false };
  }

  // ------------------------------------------------------------------
  // ReplyDispatcher interface
  // ------------------------------------------------------------------

  onStart(): void | Promise<void> {
    this.startTime = Date.now();
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
    this.hasContent = true;
  }

  onReasoningDelta(_delta: string): void {
    // Reasoning output is suppressed in QQ — it would consume message
    // space and is not useful in the chat UI for QQ users.
  }

  /** Track exact ⏳ line text keyed by toolCallId for precise replacement. */
  private pendingToolLines = new Map<string, string>();

  onToolStart(name: string, args: unknown, toolCallId?: string): void {
    if (!this.showToolCalls) return;
    const summary = summarizeToolInput(name, args);
    const truncated = summary.length > 100 ? summary.slice(0, 100) + '…' : summary;
    const line = truncated
      ? `\n> ⏳ **${name}** — ${truncated}`
      : `\n> ⏳ **${name}**`;
    this.buffer += line;
    this.hasContent = true;
    // Store exact line text so onToolEnd can replace it precisely
    const key = toolCallId ?? name;
    this.pendingToolLines.set(key, line);
  }

  onToolEnd(name: string, _result: unknown, isError?: boolean, toolCallId?: string): void {
    if (!this.showToolCalls) return;
    const key = toolCallId ?? name;
    const oldLine = this.pendingToolLines.get(key);
    this.pendingToolLines.delete(key);
    const icon = isError ? '❌' : '✅';
    if (oldLine) {
      // Replace the exact ⏳ line (handles same-name tools correctly)
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
    const line = `\n> ⚡️ 技能激活: **${skillName}**`;
    this.buffer += line;
    this.hasContent = true;
  }

  setApprovalStatus(status: string | null): void {
    if (status) {
      // QQ does not support message editing — send a brief status message.
      sendChunkedText(this.gateway, `⏳ ${status}`, this.target, this.config.textLimit).catch(() => {});
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
    // Approval records are not rendered in QQ for now.
  }

  getReplyMessageId(): string | undefined {
    // QQ does not support message editing, so there is no persistent
    // message ID to track for incremental updates.
    return undefined;
  }

  /** Attach a ReplyTracker to record replies after sending. */
  setReplyTracker(tracker: ReplyTracker, openid: string): void {
    this.replyTracker = tracker;
    this.replyTrackerOpenid = openid;
  }

  async onComplete(usage?: Usage): Promise<void> {
    if (!this.hasContent) return;

    let finalText = this.buffer.trim();

    // Append footer if there is room
    if (this.config.textLimit > 200) {
      const parts: string[] = [];
      if (this.footerConfig.showAgentName && this.agentName) parts.push(this.agentName);
      if (this.footerConfig.showElapsed && this.startTime) {
        const elapsedMs = Date.now() - this.startTime;
        const elapsed = elapsedMs < 60_000 ? `${(elapsedMs / 1000).toFixed(1)}s` : `${Math.floor(elapsedMs / 60_000)}m ${Math.floor((elapsedMs % 60_000) / 1000)}s`;
        parts.push(`耗时 ${elapsed}`);
      }
      if (this.footerConfig.showModel && this.model) parts.push(this.model);
      const usageSummary = formatUsageSummary(usage, this.footerConfig);
      if (usageSummary) parts.push(usageSummary);
      if (parts.length > 0) {
        const footer = `\n\n${parts.join(' · ')}`;
        if (finalText.length + footer.length <= this.config.textLimit * 2) {
          finalText += footer;
        }
      }
    }

    await sendChunkedText(this.gateway, finalText, this.target, this.config.textLimit);

    // Record the reply for rate-limit tracking
    if (this.replyTracker && this.replyTrackerOpenid) {
      this.replyTracker.recordMessageReply(this.replyTrackerOpenid);
    }
  }

  async onError(error: Error): Promise<void> {
    // Detect timeout errors and show a user-friendly message
    const isTimeout =
      error.message?.toLowerCase().includes('timeout') ||
      error.name === 'TimeoutError' ||
      error.name === 'AbortError';

    const errorMsg = isTimeout
      ? '抱歉，处理消息超时，请稍后重试或简化您的问题。'
      : `抱歉，处理消息时出现错误: ${error.message}`;

    await sendChunkedText(this.gateway, errorMsg, this.target, this.config.textLimit).catch(() => {});

    // Record the reply for rate-limit tracking even on errors
    if (this.replyTracker && this.replyTrackerOpenid) {
      this.replyTracker.recordMessageReply(this.replyTrackerOpenid);
    }
  }

  async onAborted(): Promise<void> {
    if (this.hasContent) {
      const text = this.buffer.trim() + '\n\n[Aborted]';
      await sendChunkedText(this.gateway, text, this.target, this.config.textLimit).catch(() => {});
    }

    // Record the reply for rate-limit tracking on abort
    if (this.replyTracker && this.replyTrackerOpenid) {
      this.replyTracker.recordMessageReply(this.replyTrackerOpenid);
    }
  }
}
