/**
 * TelegramApprovalSender — sends approval request messages with Inline Keyboard
 * buttons and updates them after user decision.
 *
 * Implements the channelApprovalSender contract defined in
 * src/agent/before-tool-call.ts so it can be plugged directly into the
 * Agent's approval pipeline.
 */

import type { Bot } from 'grammy';
import { encodeCallbackAction } from './inline-keyboard.js';
import { i18n } from '../../src/i18n/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TelegramApprovalSender {
  sendApprovalMessage(
    chatId: string,
    requestId: string,
    command: string,
    risk: 'low' | 'medium' | 'high',
    reason?: string,
  ): Promise<string>;

  updateApprovalResult(
    chatId: string,
    messageId: string,
    decision: string,
    command: string,
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createTelegramApprovalSender(bot: Bot): TelegramApprovalSender {
  return {
    async sendApprovalMessage(chatId, requestId, command, risk, reason) {
      const chatIdNum = Number(chatId);
      const html = buildApprovalHtml(command, risk, reason);
      const keyboard = buildI18nKeyboard(requestId);

      const msg = await bot.api.sendMessage(chatIdNum, html, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });

      return String(msg.message_id);
    },

    async updateApprovalResult(chatId, messageId, decision, command) {
      const chatIdNum = Number(chatId);
      const messageIdNum = Number(messageId);
      const isApproved = decision.startsWith('approve');
      const emoji = isApproved ? '✅' : '❌';
      const key = isApproved ? 'result.approved' : 'result.rejected';
      const truncated = command.length > 100 ? command.slice(0, 100) + '...' : command;
      const label = i18n.t(`telegram-approval:${key}`, { command: truncated });

      const html = `${emoji} <b>${escapeHtml(label)}</b>`;

      await bot.api.editMessageText(chatIdNum, messageIdNum, html, {
        parse_mode: 'HTML',
        reply_markup: undefined,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Inline Keyboard (i18n labels)
// ---------------------------------------------------------------------------

function buildI18nKeyboard(requestId: string) {
  return {
    inline_keyboard: [
      [
        { text: i18n.t('telegram-approval:button.approveOnce'),     callback_data: encodeCallbackAction({ type: 'approve', requestId, decision: 'approve_once' }) },
        { text: i18n.t('telegram-approval:button.approveSession'),  callback_data: encodeCallbackAction({ type: 'approve', requestId, decision: 'approve_session' }) },
      ],
      [
        { text: i18n.t('telegram-approval:button.alwaysAllow'),     callback_data: encodeCallbackAction({ type: 'approve', requestId, decision: 'approve_always' }) },
        { text: i18n.t('telegram-approval:button.denyOnce'),        callback_data: encodeCallbackAction({ type: 'approve', requestId, decision: 'reject_once' }) },
      ],
    ],
  };
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

const RISK_EMOJI: Record<string, string> = {
  low:    '\u{1F7E2}', // green circle
  medium: '\u{1F7E0}', // orange circle
  high:   '\u{1F534}', // red circle
};

function getApprovalTitleKey(command: string): string {
  return command.startsWith('computer_use ')
    ? 'telegram-approval:card.computerUseApproval'
    : 'telegram-approval:card.shellCommandApproval';
}

function buildApprovalHtml(
  command: string,
  risk: 'low' | 'medium' | 'high',
  reason?: string,
): string {
  const riskEmoji = RISK_EMOJI[risk] ?? '';
  const riskLabel = i18n.t(`telegram-approval:risk${risk.charAt(0).toUpperCase() + risk.slice(1)}`);
  const truncated = command.length > 100 ? command.slice(0, 100) + '...' : command;

  let html =
    `<b>${i18n.t(getApprovalTitleKey(command))}</b>\n\n` +
    `<code>${escapeHtml(truncated)}</code>\n\n` +
    `${riskEmoji} ${i18n.t('telegram-approval:field.risk')}: <b>${riskLabel}</b>`;

  if (reason) {
    html += `\n\u{1F4DD} ${i18n.t('telegram-approval:field.reason')}: ${escapeHtml(reason)}`;
  }

  return html;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
