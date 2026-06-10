/**
 * QQ Approval Interaction Handler.
 *
 * Processes INTERACTION_CREATE events triggered by approval button clicks.
 * Parses the button_data, resolves the approval via AgentService, and sends
 * a result message (QQ does not support message editing).
 */

import type { Logger } from 'pino';
import type { AgentService } from '../../src/agent/agent-service.js';
import type { QQGateway } from './qq-gateway.js';
import type { QQInteractionEvent } from './qq-types.js';
import { parseApprovalCallback } from './qq-keyboard.js';
import { sendChunkedText } from './send-message.js';
import { i18n } from '../../src/i18n/index.js';

export interface QQApprovalHandlerOptions {
  agentService: AgentService;
  gateway: QQGateway;
  target: { openid?: string; groupOpenid?: string };
  logger: Logger;
}

export async function handleApprovalInteraction(
  event: QQInteractionEvent,
  options: QQApprovalHandlerOptions,
): Promise<{ code: number; message: string }> {
  const { agentService, gateway, target, logger } = options;

  try {
    // Acknowledge the interaction BEFORE processing so QQ counts the click
    // against click_limit and disables the button group. Without this, a
    // failed acknowledgment means the click isn't consumed and the button
    // stays clickable, leading to duplicate interactions.
    try {
      await gateway.sendRestApi('PUT', `/interactions/${event.id}`, { code: 0 });
    } catch (err) {
      logger.warn({ err, interactionId: event.id }, 'QQ interaction acknowledge failed, button may not be disabled');
    }

    const buttonData = event.data?.resolved?.button_data;
    if (!buttonData) return { code: 1, message: 'no button_data' };

    const parsed = parseApprovalCallback(buttonData);
    if (!parsed) return { code: 1, message: 'not an approval button' };

    const resolved = agentService.resolveApproval(parsed.requestId, parsed.decision);
    logger.info({ requestId: parsed.requestId, decision: parsed.decision, resolved }, 'QQ approval resolved');

    if (resolved) {
      const isApproved = parsed.decision.startsWith('approve');
      const emoji = isApproved ? '✅' : '❌';
      const labelMap: Record<string, string> = {
        approve_once: '已批准（仅此次）',
        approve_session: '已批准（本次会话）',
        approve_always: '已批准（始终允许）',
        reject_once: '已拒绝（仅此次）',
      };
      const label = labelMap[parsed.decision] ?? parsed.decision;
      await sendChunkedText(gateway, `${emoji} ${label}`, target, 2000).catch(() => {});
      return { code: 0, message: 'ok' };
    }

    await sendChunkedText(gateway, i18n.t('qq-approval:result.alreadyProcessed'), target, 2000).catch(() => {});
    return { code: 2, message: 'already resolved' };
  } catch (err) {
    logger.error({ err }, 'QQ approval interaction error');
    return { code: -1, message: String(err) };
  }
}
