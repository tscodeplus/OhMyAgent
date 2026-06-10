/**
 * Feishu implementation of the agent-core `ApprovalUiPort`.
 *
 * Wraps the Feishu-specific approval machinery (ReplyApprovalTracker +
 * interactive card renderer + the registry used by card-action callbacks) so
 * the agent core can gate tool calls without importing anything from this
 * extension. Wired in at the composition root (bootstrap.ts).
 */

import type {
  ApprovalUiPort,
  ApprovalUiSession,
  ApprovalUiSessionContext,
  ApprovalUiSessionCache,
} from '../../../src/agent/approval-ui-port.js';
import { ReplyApprovalTracker } from './approval-tracker.js';
import { renderApprovalCard } from './approval-card-renderer.js';
import type { ReplyApprovalRegistry } from './reply-approval-registry.js';

/** Minimal Feishu client surface the approval UI needs. */
export interface FeishuApprovalUiClient {
  sendApprovalCard(chatId: string, card: Record<string, unknown>): Promise<string>;
  recallMessage?(messageId: string): Promise<void>;
}

export interface FeishuApprovalUiPortOptions {
  feishuClient: FeishuApprovalUiClient;
  registry?: ReplyApprovalRegistry;
}

/**
 * Build the Feishu approval UI port.
 *
 * Two presentation paths, preserving prior behavior exactly:
 *   - When `recallMessage` is available, requests go through a
 *     `ReplyApprovalTracker` (registered in the registry so card-action
 *     callbacks can resolve them) and the card is recalled on resolve.
 *   - Otherwise the card is sent directly and resolve is a no-op (the
 *     callback handler edits the card in place instead).
 */
export function createFeishuApprovalUiPort(
  options: FeishuApprovalUiPortOptions,
): ApprovalUiPort {
  const { feishuClient, registry } = options;

  return {
    getSession(
      ctx: ApprovalUiSessionContext,
      cache: ApprovalUiSessionCache,
    ): ApprovalUiSession {
      if (cache.approvalSession) return cache.approvalSession;
      const session = buildSession(feishuClient, registry, ctx);
      cache.approvalSession = session;
      return session;
    },
  };
}

function buildSession(
  feishuClient: FeishuApprovalUiClient,
  registry: ReplyApprovalRegistry | undefined,
  ctx: ApprovalUiSessionContext,
): ApprovalUiSession {
  // Tracker path requires recallMessage; create it eagerly so parallel tool
  // calls in one batch share a single tracker (no lazy-init race).
  const tracker = feishuClient.recallMessage
    ? new ReplyApprovalTracker({
        feishuClient: {
          sendApprovalCard: feishuClient.sendApprovalCard.bind(feishuClient),
          recallMessage: feishuClient.recallMessage.bind(feishuClient),
        },
        replyDispatcher: ctx.replyDispatcher,
        registry,
      })
    : undefined;

  return {
    async present(req) {
      if (tracker) {
        return tracker.addPending({
          requestId: req.requestId,
          command: req.command,
          risk: req.risk,
          reason: req.reason,
          chatId: req.chatId,
        });
      }
      const card = renderApprovalCard({
        id: req.requestId,
        command: req.command,
        risk: req.risk,
        reason: req.reason,
        sessionId: req.sessionId ?? '',
        timestamp: Date.now(),
      });
      return feishuClient.sendApprovalCard(req.chatId, card);
    },
    async resolve(res) {
      if (tracker) {
        await tracker.resolve(res.requestId, res.decision);
      }
      // Direct-send path: the card-action callback edits the card in place;
      // nothing to recall here.
    },
  };
}
