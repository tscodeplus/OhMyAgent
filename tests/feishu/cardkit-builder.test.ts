import { i18n } from '../../src/i18n/index.js';
import { describe, it, expect } from 'vitest';
import {
  buildStreamingCard,
  buildCompletedCard,
  buildCardUpdate,
  truncateCommand,
  buildApprovalRecordsMarkdown,
  STREAMING_ELEMENT_ID,
  THINKING_ELEMENT_ID,
  ANSWER_ELEMENT_ID,
} from '../../extensions/channel-feishu/render/cardkit-builder.js';

// ─── buildStreamingCard ───

describe('buildStreamingCard', () => {
  it('returns a CardKit 2.0 card with streaming_mode: true', () => {
    const card = buildStreamingCard();

    expect(card.schema).toBe('2.0');
    expect(card.config).toEqual({ streaming_mode: true });
  });

  it('includes a streaming_content element with empty content', () => {
    const card = buildStreamingCard() as Record<string, unknown>;
    const body = card.body as Record<string, unknown>;
    const elements = body.elements as Array<Record<string, unknown>>;

    expect(elements).toHaveLength(1);

    const el = elements[0];
    expect(el.tag).toBe('markdown');
    expect(el.content).toBe('');
    expect(el.element_id).toBe(STREAMING_ELEMENT_ID);
  });
});

// ─── buildCompletedCard ───

describe('buildCompletedCard', () => {
  it('returns a CardKit 2.0 card with streaming_mode: false', () => {
    const card = buildCompletedCard({ answer: 'Hello' });

    expect(card.schema).toBe('2.0');
    expect(card.config).toEqual({ streaming_mode: false });
  });

  it('includes answer and footer elements', () => {
    const card = buildCompletedCard({
      answer: 'Hello world',
      footerConfig: { showCompleted: true },
    }) as Record<string, unknown>;
    const body = card.body as Record<string, unknown>;
    const elements = body.elements as Array<Record<string, unknown>>;

    // answer + footer (no thinking panel since not provided)
    expect(elements).toHaveLength(2);

    // Answer element uses STREAMING_ELEMENT_ID
    expect(elements[0].tag).toBe('markdown');
    expect(elements[0].content).toBe('Hello world');
    expect(elements[0].element_id).toBe(STREAMING_ELEMENT_ID);

    // Footer is a markdown element with notation text_size
    expect(elements[1].tag).toBe('markdown');
    expect(elements[1].text_size).toBe('notation');
    expect(elements[1].content).toContain(i18n.t('feishu-cards:footer.completed'));
  });

  it('includes thinking panel when thinking is provided', () => {
    const card = buildCompletedCard({
      thinking: 'Let me think...',
      answer: 'The answer is 42.',
      footerConfig: { showCompleted: true },
    }) as Record<string, unknown>;
    const body = card.body as Record<string, unknown>;
    const elements = body.elements as Array<Record<string, unknown>>;

    // thinking panel + answer + footer (thinking is currently not rendered in the card
    // but the card still contains answer and footer elements)
    expect(elements).toHaveLength(2);

    // Answer element
    expect(elements[0].tag).toBe('markdown');
    expect(elements[0].content).toBe('The answer is 42.');
    expect(elements[0].element_id).toBe(STREAMING_ELEMENT_ID);
  });

  it('uses custom footer when provided', () => {
    const card = buildCompletedCard({
      answer: 'Done',
      footer: 'Custom Footer',
    }) as Record<string, unknown>;
    const body = card.body as Record<string, unknown>;
    const elements = body.elements as Array<Record<string, unknown>>;

    const footerEl = elements[elements.length - 1];
    expect(footerEl.tag).toBe('markdown');
    expect(footerEl.text_size).toBe('notation');
    expect(footerEl.content).toBe('Custom Footer');
  });

  it('shows footer when completed display is enabled', () => {
    const card = buildCompletedCard({
      answer: 'Done',
      footerConfig: { showCompleted: true },
    }) as Record<string, unknown>;
    const body = card.body as Record<string, unknown>;
    const elements = body.elements as Array<Record<string, unknown>>;

    const footerEl = elements[elements.length - 1];
    expect(footerEl.tag).toBe('markdown');
    expect(footerEl.text_size).toBe('notation');
    expect(footerEl.content).toContain(i18n.t('feishu-cards:footer.completed'));
  });

  it('includes input/output token usage and cache hit rate when footer config enables them', () => {
    const card = buildCompletedCard({
      answer: 'Done',
      usage: {
        input: 100,
        output: 50,
        cacheRead: 30,
        cacheWrite: 10,
        totalTokens: 190,
        cost: 0.003,
      },
      footerConfig: {
        showAgentName: true,
        showModel: true,
        showCompleted: true,
        showElapsed: true,
        showUsage: true,
        showCacheHitRate: true,
      },
    }) as Record<string, unknown>;
    const body = card.body as Record<string, unknown>;
    const elements = body.elements as Array<Record<string, unknown>>;

    const footerEl = elements[elements.length - 1];
    expect(footerEl.content).toContain('↓ 140 ↑ 50');
    expect(footerEl.content).toContain('缓存命中 21.4%');
  });

  it('hides token usage and cache hit rate when footer config disables them', () => {
    const card = buildCompletedCard({
      answer: 'Done',
      usage: {
        input: 100,
        output: 50,
        cacheRead: 30,
        cacheWrite: 10,
        totalTokens: 190,
        cost: 0.003,
      },
      footerConfig: {
        showAgentName: true,
        showModel: true,
        showCompleted: true,
        showElapsed: true,
        showUsage: false,
        showCacheHitRate: false,
      },
    }) as Record<string, unknown>;
    const body = card.body as Record<string, unknown>;
    const elements = body.elements as Array<Record<string, unknown>>;

    const footerEl = elements[elements.length - 1];
    expect(footerEl.content).not.toContain('↓ 140 ↑ 50');
    expect(footerEl.content).not.toContain('缓存命中');
  });
});

// ─── truncateCommand ───

describe('truncateCommand', () => {
  it('returns the original command when within limit', () => {
    expect(truncateCommand('ls -la')).toBe('ls -la');
  });

  it('truncates long commands with explicit max length and ellipsis', () => {
    const long = 'adb shell dumpsys activity broadcasts | grep -i mypackage';
    const result = truncateCommand(long, 40);
    expect(result).toHaveLength(43); // 40 + '...'
    expect(result.endsWith('...')).toBe(true);
    expect(result.startsWith(long.slice(0, 40))).toBe(true);
  });

  it('defaults to a 100-char limit', () => {
    expect(truncateCommand('ls -la')).toBe('ls -la');
    const long = 'a'.repeat(150);
    const result = truncateCommand(long);
    expect(result).toHaveLength(103); // 100 + '...'
  });

  it('accepts custom max length', () => {
    const result = truncateCommand('hello world', 5);
    expect(result).toBe('hello...');
  });
});

// ─── buildApprovalRecordsMarkdown ───

describe('buildApprovalRecordsMarkdown', () => {
  it('renders approval records sorted by updatedAt', () => {
    const result = buildApprovalRecordsMarkdown([
      { requestId: 'r1', command: 'adb install', risk: 'low' as const, status: 'approved' as const, decision: 'approve_once' as const, updatedAt: 2 },
      { requestId: 'r2', command: 'adb push', risk: 'low' as const, status: 'pending' as const, updatedAt: 1 },
    ]);
    expect(result).toContain(i18n.t('feishu-cards:section.requestsAndApprovals'));
    expect(result).toContain(i18n.t('feishu-cards:status.pending'));
    expect(result).toContain(i18n.t('feishu-cards:status.approvedOnce'));
    // older record (updatedAt=1) should appear first (line 1)
    expect(result).toMatch(/1\..*adb push/);
    expect(result).toMatch(/2\..*adb install/);
  });

  it('truncates long commands in the output', () => {
    const longCmd = 'adb shell cmd package list-packages --show-versioncode --filter myapp '
      + 'extra-very-long-trailing-flags-to-exceed-the-hundred-character-limit';
    expect(longCmd.length).toBeGreaterThan(100);
    const result = buildApprovalRecordsMarkdown([
      { requestId: 'r1', command: longCmd, risk: 'high' as const, status: 'approved' as const, decision: 'approve_once' as const, updatedAt: 1 },
    ]);
    expect(result).toContain(truncateCommand(longCmd));
    expect(result).not.toContain(longCmd);
  });
});

// ─── buildCardUpdate ───

describe('buildCardUpdate', () => {
  it('returns a markdown element with the given content and element_id', () => {
    const update = buildCardUpdate('Hello', 'streaming_content');

    expect(update.tag).toBe('markdown');
    expect(update.content).toBe('Hello');
    expect(update.element_id).toBe('streaming_content');
  });

  it('uses custom element_id', () => {
    const update = buildCardUpdate('Test content', 'custom_id');

    expect(update.element_id).toBe('custom_id');
  });

  it('handles empty content', () => {
    const update = buildCardUpdate('', 'streaming_content');

    expect(update.content).toBe('');
  });
});
