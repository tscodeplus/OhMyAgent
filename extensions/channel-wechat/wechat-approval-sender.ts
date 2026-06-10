/**
 * WechatApprovalSender — sends approval request messages as text with
 * slash-command instructions, since WeChat does not support interactive
 * cards or inline keyboards.
 *
 * Implements the ChannelApprovalSender contract defined in
 * src/agent/approval-ui-port.ts so it can be plugged directly into the
 * Agent's approval pipeline.
 */

import type { ChannelApprovalSender } from '../../src/agent/approval-ui-port.js';
import { i18n } from '../../src/i18n/index.js';
import { sendChunkedText } from './wechat-sender.js';
import type { Logger } from 'pino';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WechatApprovalSenderOptions {
  apiBase: string;
  botToken: string;
  toUserId: string;
  contextToken: string;
  textLimit: number;
  logger?: Logger;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createWechatApprovalSender(
  options: WechatApprovalSenderOptions,
): ChannelApprovalSender {
  const { apiBase, botToken, toUserId, contextToken, textLimit, logger } = options;

  return {
    async sendApprovalMessage(
      _chatId: string,
      _requestId: string,
      command: string,
      risk: 'low' | 'medium' | 'high',
      reason?: string,
    ): Promise<string> {
      const riskLabel = i18n.t(`wechat-approval:risk${risk.charAt(0).toUpperCase() + risk.slice(1)}`);
      const truncated = command.length > 200 ? command.slice(0, 200) + '...' : command;
      const titleKey = command.startsWith('computer_use ')
        ? 'wechat-approval:card.computerUseApproval'
        : 'wechat-approval:card.shellCommandApproval';

      let text = `⚠️ **${i18n.t(titleKey)}**\n\n`;
      text += `\`\`\`\n${truncated}\n\`\`\`\n\n`;
      text += `${i18n.t('wechat-approval:field.risk')}: ${riskLabel}`;

      if (reason) {
        text += `\n${i18n.t('wechat-approval:field.reason')}: ${reason}`;
      }

      text += `\n\n${i18n.t('wechat-approval:instructions')}`;

      await sendChunkedText(
        apiBase,
        botToken,
        toUserId,
        contextToken,
        text,
        textLimit,
        logger,
      ).catch(() => {});

      // WeChat doesn't return a message ID we can use later, so return
      // a synthetic one for tracking purposes.
      return `wechat-approval-${Date.now()}`;
    },

    // updateApprovalResult is a no-op for WeChat — we cannot edit sent
    // messages. The slash command handler sends its own reply as
    // acknowledgment.
    async updateApprovalResult(): Promise<void> {
      // No-op: WeChat does not support message editing.
    },
  };
}
