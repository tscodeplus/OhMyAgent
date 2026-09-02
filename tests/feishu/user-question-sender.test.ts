// ---------------------------------------------------------------------------
// Tests for FeishuUserQuestionSender card layout:
//   - short option labels → full-width buttons, one per row (no 2-per-row
//     column_set grid that forced text wrapping)
//   - long option labels → select_static dropdown (full text always visible)
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from 'vitest';
import { createFeishuUserQuestionSender } from '../../extensions/channel-feishu/render/user-question-sender.js';

function makeSender() {
  const sent: Record<string, unknown>[] = [];
  const sender = createFeishuUserQuestionSender({
    sendCard: vi.fn(async (_chatId: string, card: Record<string, unknown>) => {
      sent.push(card);
      return 'om_123';
    }),
    updateCard: vi.fn(async () => {}),
  });
  return { sender, sent };
}

function bodyElements(card: Record<string, unknown>): Record<string, unknown>[] {
  return ((card.body as { elements: Record<string, unknown>[] }).elements ?? []) as Record<
    string,
    unknown>[];
}

describe('FeishuUserQuestionSender card layout', () => {
  it('renders short options as one full-width button per row (no column_set)', async () => {
    const { sender, sent } = makeSender();
    await sender.sendQuestion('chat-1', 'req-1', '选择协议', [
      { label: 'HTTP', value: 'HTTP' },
      { label: 'WebSocket', value: 'WebSocket' },
    ]);

    expect(sent).toHaveLength(1);
    const card = sent[0];
    expect(card.schema).toBe('2.0');

    const elements = bodyElements(card);
    const buttons = elements.filter((el) => el.tag === 'button');
    expect(buttons).toHaveLength(2);
    // No 2-per-row grid — buttons stack vertically as direct elements
    expect(elements.some((el) => el.tag === 'column_set')).toBe(false);
    // Full callback payload per button
    expect(buttons[0].value).toMatchObject({
      action: 'answer_question',
      requestId: 'req-1',
      answer: 'HTTP',
    });
  });

  it('renders long options as a numbered markdown list above the buttons', async () => {
    const { sender, sent } = makeSender();
    const longLabel = '使用密钥认证并启用自动重试机制';
    await sender.sendQuestion('chat-1', 'req-2', '选择认证方式', [
      { label: longLabel, value: longLabel },
      { label: '匿名访问', value: '匿名访问' },
    ]);

    const elements = bodyElements(sent[0]);
    // Full text preserved in a wrapping markdown list (numbered, matches
    // button order) — buttons themselves cannot wrap.
    const markdown = elements.find(
      (el) => el.tag === 'markdown' && String(el.content).startsWith('1. '),
    ) as Record<string, unknown> | undefined;
    expect(markdown).toBeDefined();
    expect(String(markdown!.content)).toBe(`1. ${longLabel}\n2. 匿名访问`);

    // One full-width button per row, no 2-per-row grid, no dropdown
    const buttons = elements.filter((el) => el.tag === 'button');
    expect(buttons).toHaveLength(2);
    expect(elements.some((el) => el.tag === 'column_set')).toBe(false);
    expect(elements.some((el) => el.tag === 'select_static')).toBe(false);
  });
});
