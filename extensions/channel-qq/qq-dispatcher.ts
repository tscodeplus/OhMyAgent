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
import { sendChunkedText, sendKeyboardMessage } from './send-message.js';
import { buildHarnessKeyboard } from './qq-keyboard.js';
import { harnessApprovalRegistry } from '../../src/harness/harness-approval-registry.js';
import { summarizeToolInput } from '../../src/channel/tool-summary.js';
import { formatUsageSummary } from '../../src/channel/usage-summary.js';
import { i18n } from '../../src/i18n/index.js';
import type {
  HarnessImprovementPrompt,
  ApprovalDecision,
  HarnessApprovalResult,
} from '../../src/harness/types.js';

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

  /** Resolver map for harness approval prompts keyed by proposal ID. */
  private _harnessResolvers = new Map<string, (decision: ApprovalDecision) => void>();

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
    this.footerConfig = footerConfig ?? {
      showAgentName: true,
      showModel: true,
      showCompleted: false,
      showElapsed: true,
      showUsage: false,
      showCacheHitRate: false,
    };
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
    const line = truncated ? `\n> ⏳ **${name}** — ${truncated}` : `\n> ⏳ **${name}**`;
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
    // No leading \n — onSkillActivated is always the first content after
    // onStart, so a leading newline would just be trimmed by onComplete.
    // Trailing \n\n separates the skill line from the response text.
    const key = skillName.includes(' | ') ? 'messages:skill.merged' : 'messages:skill.activated';
    const label = i18n.t(key);
    const line = `> ⚡️ ${label} — **${skillName}**\n\n`;
    this.buffer += line;
    this.hasContent = true;
  }

  setApprovalStatus(status: string | null): void {
    if (status) {
      // QQ does not support message editing — send a brief status message.
      sendChunkedText(this.gateway, `⏳ ${status}`, this.target, this.config.textLimit).catch(
        () => {},
      );
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

  requestHarnessApproval(
    prompt: HarnessImprovementPrompt,
    timeoutMs?: number,
  ): Promise<HarnessApprovalResult> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this._harnessResolvers.delete(prompt.id);
        harnessApprovalRegistry.remove(prompt.id);
        resolve({ decision: 'timeout' });
      }, timeoutMs ?? 120_000);

      this._harnessResolvers.set(prompt.id, (decision: ApprovalDecision) => {
        clearTimeout(timeout);
        harnessApprovalRegistry.remove(prompt.id);
        resolve({ decision });
      });

      // Expose the resolver via the process-wide registry so the
      // INTERACTION_CREATE handler (which has no dispatcher reference) can
      // route keyboard button clicks back here.
      harnessApprovalRegistry.register({
        proposalId: prompt.id,
        channel: 'qq',
        chatId: this.target.openid ?? this.target.groupOpenid ?? '',
        resolve: (decision) => {
          const resolver = this._harnessResolvers.get(prompt.id);
          this._harnessResolvers.delete(prompt.id);
          resolver?.(decision);
        },
      });

      // QQ text replies are queued behind the awaiting agent execution, so a
      // numeric reply could never arrive in time — use interactive keyboard
      // buttons (INTERACTION_CREATE) instead, like tool approvals do.
      const markdown = [
        `**${i18n.t('harness:card.title')}**`,
        '',
        `${i18n.t('harness:card.problem')}：${prompt.failureSummary}`,
        '',
        `${i18n.t('harness:card.suggestion')}：${prompt.title}`,
        prompt.detail.slice(0, 300),
        '',
        `${i18n.t('harness:card.impact')}：${prompt.impact.scope} | ${i18n.t('harness:card.risk')}：${prompt.impact.riskLevel}`,
      ].join('\n');

      const keyboard = buildHarnessKeyboard(prompt.id, {
        approve: i18n.t('harness:card.approveAndApply'),
        reject: i18n.t('harness:actions.reject'),
        ignore: i18n.t('harness:actions.ignore'),
      });

      void sendKeyboardMessage(this.gateway, {
        markdown,
        keyboard,
        target: this.target,
      }).catch(() => {
        // If sending fails, clean up and resolve as timeout
        this._harnessResolvers.delete(prompt.id);
        harnessApprovalRegistry.remove(prompt.id);
        clearTimeout(timeout);
        resolve({ decision: 'timeout' });
      });
    });
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
        const elapsed =
          elapsedMs < 60_000
            ? `${(elapsedMs / 1000).toFixed(1)}s`
            : `${Math.floor(elapsedMs / 60_000)}m ${Math.floor((elapsedMs % 60_000) / 1000)}s`;
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
      ? i18n.t('messages:errors.timeout')
      : i18n.t('messages:errors.generic', { message: error.message });

    await sendChunkedText(this.gateway, errorMsg, this.target, this.config.textLimit).catch(
      () => {},
    );

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
