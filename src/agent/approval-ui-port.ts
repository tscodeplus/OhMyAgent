/**
 * Channel-agnostic approval UI port.
 *
 * The agent core must gate tool calls behind user approval, but it must NOT
 * know *how* a given channel renders that approval (Feishu interactive cards,
 * Telegram inline keyboards, a WebUI prompt, …). This port is the seam:
 *
 *   - `ApprovalUiSession` presents a single approval request and finalizes the
 *     UI once a decision lands. One session is created per agent turn.
 *   - `ApprovalUiPort` hands out (and caches) the per-turn session.
 *
 * Concrete implementations live in the channel extensions and are injected at
 * the composition root, so `src/agent/` carries zero reverse dependency on any
 * `extensions/channel-*` module.
 */

import type { ApprovalDecisionType, ReplyDispatcher } from '../app/types.js';

export type ApprovalRisk = 'low' | 'medium' | 'high';

/** A request to present to the user for approval. */
export interface ApprovalPresentation {
  requestId: string;
  command: string;
  risk: ApprovalRisk;
  reason?: string;
  chatId: string;
  sessionId?: string;
}

/** The outcome to reflect back into the channel UI after a decision. */
export interface ApprovalResolution {
  requestId: string;
  decision: ApprovalDecisionType;
  /** The message/card id returned by `present`, if any. */
  cardMessageId?: string;
  chatId: string;
  command: string;
}

/** Per-turn approval UI session. */
export interface ApprovalUiSession {
  /** Present an approval request. Returns the card/message id, if any. */
  present(req: ApprovalPresentation): Promise<string | undefined>;
  /** Finalize the channel UI after a decision (recall card / edit message). */
  resolve(res: ApprovalResolution): Promise<void>;
}

/** Context the port needs to build (and cache) a per-turn session. */
export interface ApprovalUiSessionContext {
  chatId?: string;
  replyDispatcher?: ReplyDispatcher;
}

/**
 * Factory for per-turn approval UI sessions, injected by the composition root.
 * `getSession` is idempotent within a turn: it must return the same session for
 * repeated calls with the same `cache` object so parallel tool calls in one
 * batch share a single underlying tracker.
 */
export interface ApprovalUiPort {
  getSession(
    ctx: ApprovalUiSessionContext,
    cache: ApprovalUiSessionCache,
  ): ApprovalUiSession;
}

/** Mutable slot where the port caches the active session for a turn. */
export interface ApprovalUiSessionCache {
  approvalSession?: ApprovalUiSession;
}

/**
 * The minimal "send + update" contract a simple channel (Telegram / QQ / WebUI)
 * implements. Adapted into an `ApprovalUiSession` by `channelSenderToSession`.
 */
export interface ChannelApprovalSender {
  sendApprovalMessage(
    chatId: string,
    requestId: string,
    command: string,
    risk: ApprovalRisk,
    reason?: string,
  ): Promise<string>;
  updateApprovalResult?(
    chatId: string,
    messageId: string,
    decision: string,
    command: string,
  ): Promise<void>;
}

/**
 * Adapt a plain `ChannelApprovalSender` into an `ApprovalUiSession`.
 * Stateless — a fresh adapter per turn is fine.
 */
export function channelSenderToSession(
  sender: ChannelApprovalSender,
): ApprovalUiSession {
  return {
    async present(req) {
      return sender.sendApprovalMessage(
        req.chatId,
        req.requestId,
        req.command,
        req.risk,
        req.reason,
      );
    },
    async resolve(res) {
      if (!sender.updateApprovalResult || !res.cardMessageId) return;
      await sender
        .updateApprovalResult(res.chatId, res.cardMessageId, res.decision, res.command)
        .catch(() => {});
    },
  };
}
