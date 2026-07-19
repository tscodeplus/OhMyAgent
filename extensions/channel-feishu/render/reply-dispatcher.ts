/**
 * ReplyDispatcher — bridges agent events to StreamingCardController.
 *
 * Implements the ReplyDispatcher interface from app/types.ts,
 * translating lifecycle callbacks into streaming card operations.
 * Manages typing emoji reactions on the user's message.
 */

import type { StreamingCardController } from './streaming-card-controller.js';
import { StreamingCardController as StreamingCardControllerImpl } from './streaming-card-controller.js';
import type { Logger } from 'pino';
import type { FooterConfig, Usage } from '../../../src/app/types.js';
import { summarizeToolInput } from '../../../src/channel/tool-summary.js';
import { i18n } from '../../../src/i18n/index.js';

export interface ReplyDispatcherOptions {
  feishuClient: any;
  chatId: string;
  /** The user's message ID — used for reply threading and emoji reactions. */
  messageId?: string;
  /** Model name for footer display. */
  model?: string;
  /** Agent name for footer display. */
  agentName?: string;
  /** Footer display configuration. */
  footerConfig?: FooterConfig;
  /** Flush interval in ms for streaming card updates. Default: 2000. */
  flushIntervalMs?: number;
  /** Show tool execution indicators in the card. Default: true. */
  showToolCalls?: boolean;
  /** Show skill activation notifications. Default: true. */
  showSkillCalls?: boolean;
  logger?: Logger;
}

export class ReplyDispatcher {
  private controller: StreamingCardController;
  private readonly feishuClient: any;
  private readonly messageId?: string;
  private reactionId: string | null = null;
  private readonly showToolCalls: boolean;
  private readonly showSkillCalls: boolean;
  private readonly chatId: string;
  private harnessResolvers = new Map<string, (decision: string) => void>();

  constructor(options: ReplyDispatcherOptions) {
    this.showToolCalls = options.showToolCalls !== false;
    this.showSkillCalls = options.showSkillCalls !== false;
    this.feishuClient = options.feishuClient;
    this.chatId = options.chatId;
    this.messageId = options.messageId;
    this.controller = new StreamingCardControllerImpl({
      feishuClient: options.feishuClient,
      chatId: options.chatId,
      messageId: options.messageId,
      model: options.model,
      agentName: options.agentName,
      footerConfig: options.footerConfig,
      flushIntervalMs: options.flushIntervalMs,
      logger: options.logger,
    });
  }

  async onStart(): Promise<void> {
    // Add typing emoji reaction to user's message
    if (this.messageId) {
      this.reactionId = await this.feishuClient.addReaction(this.messageId, 'Typing');
    }
    await this.controller.createPlaceholder();
  }

  private justCompletedTool = false;
  /** Track tool args keyed by toolCallId (unique per invocation). */
  private pendingToolArgs = new Map<string, { name: string; args: unknown }>();

  onTextDelta(delta: string): void {
    // After a tool completes, insert a blank line to end the blockquote ("> ")
    // before the answer text starts, so non-tool text doesn't share the vertical bar.
    if (this.justCompletedTool) {
      delta = delta.replace(/^\n+/, '');
      this.justCompletedTool = false;
      if (delta) {
        delta = '\n\n' + delta;
      } else {
        return;
      }
    }
    this.controller.appendDelta(delta);
  }

  onReasoningDelta(_delta: string): void {
    // Reasoning content is not rendered in streaming cards.
  }

  onToolStart(name: string, args: unknown, toolCallId?: string): void {
    if (!this.showToolCalls) return;
    this.controller.markToolRunning(name, args, toolCallId);
    const key = toolCallId ?? name;
    this.pendingToolArgs.set(key, { name, args });
  }

  onToolEnd(name: string, _result: unknown, isError?: boolean, toolCallId?: string): void {
    if (!this.showToolCalls) return;
    const key = toolCallId ?? name;
    const entry = this.pendingToolArgs.get(key);
    const args = entry?.args;
    this.pendingToolArgs.delete(key);
    // Build and append the completed tool line first,
    // so it's in pendingContent before the flush triggered by markToolComplete.
    const summary = summarizeToolInput(name, args);
    const truncated = summary.length > 100 ? summary.slice(0, 100) + '…' : summary;
    const icon = isError ? '❌' : '✅';
    const line = truncated
      ? `\n> ${icon} **${name}** — ${truncated}`
      : `\n> ${icon} **${name}**`;
    this.controller.appendDelta(line);
    // Update tool indicator status (triggers another flush, now includes the appended line)
    if (isError) {
      this.controller.markToolError(name, toolCallId);
    } else {
      this.controller.markToolComplete(name, toolCallId);
    }
    this.justCompletedTool = true;
  }

  setModel(model: string): void {
    this.controller.setModel(model);
  }

  setAgentName(name: string): void {
    this.controller.setAgentName(name);
  }

  onSkillActivated(skillName: string): void {
    if (!this.showSkillCalls) return;
    // No leading \n — onSkillActivated fires right after onStart (which
    // creates the placeholder card), so it's always the first appendDelta.
    // Trailing \n\n separates the skill line from the response text.
    const key = skillName.includes(' | ') ? 'messages:skill.merged' : 'messages:skill.activated';
    const label = i18n.t(key);
    this.controller.appendDelta(`> ⚡️ ${label} — **${skillName}**\n\n`);
  }

  setApprovalStatus(_status: string | null): void {
    // No-op: feishu approval cards are standalone, not embedded in the reply card
  }

  setApprovalRecords(_records: Array<{
    requestId: string;
    command: string;
    risk: 'low' | 'medium' | 'high';
    status: 'pending' | 'approved' | 'rejected';
    decision?: string;
    updatedAt: number;
  }>, _expanded: boolean): void {
    // No-op: feishu approval cards are standalone, not embedded in the reply card
  }

  getReplyMessageId(): string | undefined {
    return this.controller.getMessageId();
  }

  async onComplete(usage?: Usage): Promise<void> {
    await this.controller.complete(usage);
    await this.removeReaction();
  }

  async onError(error: unknown): Promise<void> {
    const errorMsg = error instanceof Error ? error.message : String(error);
    await this.controller.fail(errorMsg);
    await this.removeReaction();
  }

  async onAborted(): Promise<void> {
    await this.controller.abort();
    await this.removeReaction();
  }

  getState(): string {
    return this.controller.getState();
  }

  /**
   * Display a harness improvement proposal as an interactive card and wait
   * for the user to approve, reject, or dismiss it via button click.
   *
   * The returned promise resolves when:
   *   - the user clicks a button on the card (via resolveHarnessApproval)
   *   - or the timeout expires (default 120s)
   *
   * Button clicks are expected to arrive via Feishu's card.action.trigger
   * callback, which should call resolveHarnessApproval(proposalId, decision).
   */
  async requestHarnessApproval(
    prompt: import('../../../src/harness/types.js').HarnessImprovementPrompt,
    timeoutMs?: number,
  ): Promise<import('../../../src/harness/types.js').ApprovalDecision> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.harnessResolvers.delete(prompt.id);
        resolve('timeout');
      }, timeoutMs ?? 120_000);

      this.harnessResolvers.set(prompt.id, (decision: string) => {
        clearTimeout(timeout);
        resolve(decision as import('../../../src/harness/types.js').ApprovalDecision);
      });

      // Build a standalone interactive card (v1.0 format for msg_type:interactive)
      const card: Record<string, unknown> = {
        config: { wide_screen_mode: true },
        header: {
          title: { tag: 'plain_text', content: '🔧 任务失败分析' },
          template: 'wathet',
        },
        elements: [
          { tag: 'markdown', content: `**问题**：${prompt.failureSummary}` },
          { tag: 'hr' },
          { tag: 'markdown', content: prompt.detail.slice(0, 500) },
          { tag: 'hr' },
          {
            tag: 'markdown',
            content: `**影响范围**：${prompt.impact.scope}\n**风险等级**：${prompt.impact.riskLevel}\n**预期效果**：${prompt.impact.expectedEffect}`,
          },
          { tag: 'hr' },
          {
            tag: 'action',
            actions: [
              {
                tag: 'button',
                text: { tag: 'plain_text', content: '✅ 批准并应用' },
                type: 'primary',
                value: { proposalId: prompt.id, action: 'approve' },
              },
              {
                tag: 'button',
                text: { tag: 'plain_text', content: '❌ 拒绝' },
                type: 'danger',
                value: { proposalId: prompt.id, action: 'reject' },
              },
              {
                tag: 'button',
                text: { tag: 'plain_text', content: '忽略' },
                type: 'default',
                value: { proposalId: prompt.id, action: 'dismiss' },
              },
            ],
          },
        ],
      };

      // Send the card via feishuClient.sendMessage (msg_type: interactive)
      this.feishuClient.sendMessage({
        receive_id: this.chatId,
        receive_id_type: 'chat_id',
        msg_type: 'interactive',
        content: JSON.stringify(card),
      }).catch(() => {
        // If sending fails, clean up and resolve as timeout
        this.harnessResolvers.delete(prompt.id);
        clearTimeout(timeout);
        resolve('timeout');
      });
    });
  }

  /**
   * Resolve a pending harness approval prompt with the user's decision.
   *
   * Called from the card action handler when a user clicks a button on the
   * harness improvement card (card.action.trigger callback).
   *
   * @param proposalId - The id of the HarnessImprovementPrompt to resolve.
   * @param decision - User's decision: 'approve', 'reject', or 'dismiss'.
   * @returns true if a pending resolver was found and called, false otherwise.
   */
  resolveHarnessApproval(proposalId: string, decision: string): boolean {
    const resolver = this.harnessResolvers.get(proposalId);
    if (resolver) {
      this.harnessResolvers.delete(proposalId);
      resolver(decision);
      return true;
    }
    return false;
  }

  private async removeReaction(): Promise<void> {
    if (this.messageId && this.reactionId) {
      await this.feishuClient.removeReaction(this.messageId, this.reactionId);
      this.reactionId = null;
    }
  }
}
