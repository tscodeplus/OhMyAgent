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

  it('renders long options as a select_static dropdown with full-text options', async () => {
    const { sender, sent } = makeSender();
    const longLabel = '使用密钥认证并启用自动重试机制';
    await sender.sendQuestion('chat-1', 'req-2', '选择认证方式', [
      { label: longLabel, value: longLabel },
      { label: '匿名访问', value: '匿名访问' },
    ]);

    const elements = bodyElements(sent[0]);
    const select = elements.find((el) => el.tag === 'select_static') as
      | Record<string, unknown>
      | undefined;
    expect(select).toBeDefined();

    const options = select!.options as { text: { content: string }; value: string }[];
    expect(options).toHaveLength(2);
    // Full text preserved in option labels (nothing truncated)
    expect(options[0].text.content).toBe(longLabel);
    // Option value carries the full callback payload as JSON
    expect(JSON.parse(options[0].value)).toMatchObject({
      action: 'answer_question',
      requestId: 'req-2',
      answer: longLabel,
    });
  });
});
