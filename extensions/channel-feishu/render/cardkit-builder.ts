/**
 * CardKit 2.0 card builder for streaming output.
 *
 * Builds CardKit 2.0 format cards with streaming element IDs,
 * collapsible thinking panels, and footer metadata.
 */

import type { ReplyApprovalRecord } from './approval-tracker.js';
import type { FooterConfig, Usage } from '../../../src/app/types.js';
import { i18n } from '../../../src/i18n/index.js';
import { formatUsageSummary } from '../../../src/channel/usage-summary.js';

// ─── Element IDs ───

export const STREAMING_ELEMENT_ID = 'streaming_content';
export const THINKING_ELEMENT_ID = 'thinking_content';
export const ANSWER_ELEMENT_ID = 'answer_content';

// ─── Streaming Card (initial placeholder) ───

/**
 * Build the initial CardKit 2.0 streaming card.
 * Used as a placeholder during generation with streaming_mode enabled.
 */
export function buildStreamingCard(): Record<string, unknown> {
  return {
    schema: '2.0',
    config: {
      streaming_mode: true,
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: '',
          element_id: STREAMING_ELEMENT_ID,
        },
      ],
    },
  };
}

// ─── Completed Card (final state after streaming) ───

export interface CompletedCardOptions {
  /** Reasoning/thinking content, displayed in a collapsible panel. */
  thinking?: string;
  /** The final answer content. */
  answer: string;
  /** Optional footer text. Overrides auto-generated footer when set. */
  footer?: string;
  /** Elapsed time in milliseconds for auto-generated footer. */
  elapsedMs?: number;
  /** Agent name for auto-generated footer. */
  agentName?: string;
  /** Model name for auto-generated footer. */
  model?: string;
  /** Optional transient status shown above the footer. */
  status?: string;
  /** Token usage and prompt-cache stats for auto-generated footer. */
  usage?: Usage;
  /** Footer display configuration. Controls which parts are shown. */
  footerConfig?: FooterConfig;
}

/**
 * Format elapsed milliseconds as a human-readable string.
 * < 60s → "3.5s", ≥ 60s → "1m 23s"
 */
export function formatElapsed(ms: number): string {
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/**
 * Build the final completed card replacing the streaming card.
 * Includes optional thinking panel, answer, and footer.
 */
export function buildCompletedCard(options: CompletedCardOptions): Record<string, unknown> {
  const elements: Record<string, unknown>[] = [];

  // Answer content — use same element_id as streaming card for CardKit compatibility
  elements.push({
    tag: 'markdown',
    content: options.answer,
    element_id: STREAMING_ELEMENT_ID,
  });

  // Footer — markdown with notation text size (CardKit 2.0 does not support note tag)
  if (options.status) {
    elements.push({
      tag: 'markdown',
      content: options.status,
      text_size: 'notation',
    });
  }

  let footerText = options.footer;
  if (!footerText) {
    const cfg = options.footerConfig;
    const parts: string[] = [];
    if ((cfg?.showAgentName ?? true) && options.agentName) {
      parts.push(options.agentName);
    }
    if (cfg?.showCompleted ?? false) {
      parts.push(i18n.t('feishu-cards:footer.completed'));
    }
    if ((cfg?.showElapsed ?? true) && options.elapsedMs !== undefined) {
      parts.push(i18n.t('feishu-cards:footer.elapsed', { elapsed: formatElapsed(options.elapsedMs) }));
    }
    if ((cfg?.showModel ?? true) && options.model) {
      parts.push(options.model);
    }
    const usageSummary = formatUsageSummary(options.usage, cfg);
    if (usageSummary) {
      parts.push(usageSummary);
    }
    footerText = parts.join(' · ');
  }
  // Only render footer element if there is content to show
  if (footerText) {
    elements.push({
      tag: 'markdown',
      content: footerText,
      text_size: 'notation',
    });
  }

  return {
    schema: '2.0',
    config: {
      streaming_mode: false,
    },
    body: {
      elements,
    },
  };
}

function formatApprovalStatus(record: ReplyApprovalRecord): string {
  if (record.status === 'pending') return i18n.t('feishu-cards:status.pending');
  switch (record.decision) {
    case 'approve_once':
      return i18n.t('feishu-cards:status.approvedOnce');
    case 'approve_always':
      return i18n.t('feishu-cards:status.alwaysAllow');
    case 'reject_once':
      return i18n.t('feishu-cards:status.rejectedOnce');
    case 'reject_always':
      return i18n.t('feishu-cards:status.rejectedAlways');
    default:
      return record.status === 'approved'
        ? i18n.t('feishu-cards:status.approved')
        : i18n.t('feishu-cards:status.rejected');
  }
}

export function truncateCommand(command: string, maxLen = 100): string {
  if (command.length <= maxLen) return command;
  return command.slice(0, maxLen) + '...';
}

export function buildApprovalRecordsMarkdown(records: ReplyApprovalRecord[]): string {
  const lines = records
    .slice()
    .sort((a, b) => a.updatedAt - b.updatedAt)
    .map((record, index) => `${index + 1}. **${formatApprovalStatus(record)}** · \`${truncateCommand(record.command)}\``);
  const title = i18n.t('feishu-cards:section.requestsAndApprovals');
  return `**${title}**\n${lines.join('\n')}`;
}

// ─── Card Element Update ───

/**
 * Build a CardKit 2.0 card update for a specific element.
 * Used with cardElement.content() to stream content to a target element.
 */
export function buildCardUpdate(content: string, elementId: string): Record<string, unknown> {
  return {
    tag: 'markdown',
    content,
    element_id: elementId,
  };
}
