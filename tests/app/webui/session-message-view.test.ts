/**
 * The session transcript projection (`formatMessageRows`).
 *
 * The one behaviour worth pinning here is the segments repair: a skill-activated
 * reply persisted by the old fast path carries a segments array holding ONLY the
 * skill card, so the WebUI rendered the card and dropped every word of the
 * answer — the answer "disappeared" right after the post-turn refetch replaced
 * the streamed bubble with the persisted row.
 */

import { describe, it, expect } from 'vitest';
import { formatMessageRows } from '../../../src/app/webui/session-message-view';

function assistantRow(content: string, metadata: unknown) {
  return {
    id: 'a1',
    session_id: 's1',
    role: 'assistant',
    content,
    created_at: '1793666311573.0',
    metadata: JSON.stringify(metadata),
  };
}

describe('formatMessageRows — skill segments', () => {
  it('restores the answer text for skill-only segments written before the fix', () => {
    const [row] = formatMessageRows([
      assistantRow('⚡️ 技能激活：**Researcher**\n\n调研结论在这里', {
        skill_activated: 'Researcher',
        segments: [{ type: 'skill', name: 'Researcher' }],
      }),
    ]);

    expect(row.segments).toEqual([
      { type: 'skill', name: 'Researcher' },
      { type: 'text', content: '调研结论在这里' },
    ]);
    // The flat content keeps the banner for text-only channels.
    expect(row.content).toContain('⚡️');
  });

  it('does not duplicate text that the persister already wrote as a segment', () => {
    const [row] = formatMessageRows([
      assistantRow('⚡️ 技能激活：**Researcher**\n\n调研结论在这里', {
        skill_activated: 'Researcher',
        segments: [
          { type: 'skill', name: 'Researcher' },
          { type: 'text', content: '调研结论在这里' },
        ],
      }),
    ]);

    expect(row.segments).toEqual([
      { type: 'skill', name: 'Researcher' },
      { type: 'text', content: '调研结论在这里' },
    ]);
  });

  it('adds nothing when the row has no answer body', () => {
    const [row] = formatMessageRows([
      assistantRow('⚡️ 技能激活：**Researcher**\n\n', {
        skill_activated: 'Researcher',
        segments: [{ type: 'skill', name: 'Researcher' }],
      }),
    ]);

    expect(row.segments).toEqual([{ type: 'skill', name: 'Researcher' }]);
  });

  it('leaves a normal segmented reply untouched', () => {
    const [row] = formatMessageRows([
      assistantRow('first\n\nsecond', {
        segments: [
          { type: 'text', content: 'first' },
          { type: 'text', content: 'second' },
        ],
      }),
    ]);

    expect(row.segments).toEqual([
      { type: 'text', content: 'first' },
      { type: 'text', content: 'second' },
    ]);
  });

  it('projects a tool-cycle guard notice as a trace segment, not a message', () => {
    // Guards are persisted only inside `segments`; the projection must carry
    // kind+text through so the WebUI can localize the note and keep the raw
    // model-facing wording as a tooltip.
    const [row] = formatMessageRows([
      assistantRow('已经查完', {
        segments: [
          {
            type: 'guard',
            kind: 'budget_halt',
            text: '[system] The agent has reached its tool-call budget (5 rounds).',
          },
          { type: 'text', content: '已经查完' },
        ],
      }),
    ]);

    expect(row.segments).toEqual([
      {
        type: 'guard',
        kind: 'budget_halt',
        text: '[system] The agent has reached its tool-call budget (5 rounds).',
      },
      { type: 'text', content: '已经查完' },
    ]);
  });
});
