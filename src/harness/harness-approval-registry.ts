/**
 * Harness Approval Registry
 *
 * Process-wide registry of pending harness improvement approvals, keyed by
 * proposalId. Channel inbound paths (Feishu card action handler, Telegram
 * callback_query, QQ INTERACTION_CREATE, WeChat text interception) resolve
 * entries here to reach the awaiting `requestHarnessApproval()` promise in
 * AgentService — without needing a reference to the per-turn ReplyDispatcher.
 */

import type { ApprovalDecision } from './types.js';

export interface PendingHarnessApproval {
  /** Improvement proposal id (same id used in card button values). */
  proposalId: string;
  /** Originating channel, used for text-based interception lookups. */
  channel: 'feishu' | 'qq' | 'wechat' | 'telegram' | string;
  /** Chat/user identifier within the channel. */
  chatId: string;
  /**
   * Current proposal value to prefill "edit & apply" flows (e.g. the Feishu
   * edit form input). Optional: only channels that support editing set it.
   */
  editedDefault?: string;
  /** Resolves the promise returned by requestHarnessApproval(). */
  resolve: (decision: ApprovalDecision, editedValue?: string) => void;
}

class HarnessApprovalRegistryImpl {
  private pending = new Map<string, PendingHarnessApproval>();

  register(entry: PendingHarnessApproval): void {
    this.pending.set(entry.proposalId, entry);
  }

  get(proposalId: string): PendingHarnessApproval | undefined {
    return this.pending.get(proposalId);
  }

  has(proposalId: string): boolean {
    return this.pending.has(proposalId);
  }

  /**
   * Resolve a pending approval. Returns false when no pending entry exists
   * for the proposalId (already handled or expired). `editedValue` carries
   * the user-modified content for the 'edit' decision when the channel
   * supports collecting it (Feishu edit form).
   */
  resolve(proposalId: string, decision: ApprovalDecision, editedValue?: string): boolean {
    const entry = this.pending.get(proposalId);
    if (!entry) return false;
    this.pending.delete(proposalId);
    entry.resolve(decision, editedValue);
    return true;
  }

  remove(proposalId: string): void {
    this.pending.delete(proposalId);
  }

  /**
   * Latest pending approval for a channel/chat pair — used by text-only
   * channels (e.g. WeChat) that intercept numeric replies (1/2/3) instead of
   * button clicks. Returns the oldest pending entry (FIFO); at most one is
   * realistic per chat given the rate limiter.
   */
  findLatest(channel: string, chatId: string): PendingHarnessApproval | undefined {
    for (const entry of this.pending.values()) {
      if (entry.channel === channel && entry.chatId === chatId) return entry;
    }
    return undefined;
  }
}

/** Process-wide singleton shared by all channels. */
export const harnessApprovalRegistry = new HarnessApprovalRegistryImpl();
