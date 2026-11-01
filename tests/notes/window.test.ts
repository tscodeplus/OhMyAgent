/**
 * The window: how much of a conversation a capture reads, and what it admits to.
 *
 * Two things are being pinned here, and the second matters more than the first:
 *
 *   1. `session` is not a synonym for "a bigger `recent`". It has no turn limit at
 *      all — the token budget is the only constraint — because "based on this
 *      conversation" cannot be served by a suffix.
 *   2. A budget that trims reports `droppedMessages`. Before this, `recent` with a
 *      4000-token budget silently answered about the last two exchanges and the note
 *      looked like it had read everything.
 */

import { describe, it, expect } from 'vitest';
import { resolveWindow, renderWindowPrompt } from '../../src/notes/window.js';
import { WINDOW_TOKEN_DEFAULT } from '../../src/notes/output-budget.js';
import { parseWindowIntent } from '../../src/notes/window-intent.js';
import type { Message } from '../../src/memory/repositories/message-repository.js';

let clock = 1_780_000_000_000;

function message(role: 'user' | 'assistant', content: string): Message {
  clock += 1000;
  return {
    id: `msg-${clock}`,
    session_id: 's1',
    role,
    content,
    created_at: String(clock),
  } as unknown as Message;
}

/** `turns` exchanges of `chars` characters each, oldest first. */
function conversation(turns: number, chars = 40): Message[] {
  const rows: Message[] = [];
  for (let index = 0; index < turns; index += 1) {
    rows.push(message('user', `问题 ${index} `.padEnd(chars, 'x')));
    rows.push(message('assistant', `答案 ${index} `.padEnd(chars, 'y')));
  }
  return rows;
}

describe('resolveWindow / session', () => {
  it('reads past the turn limit that bounds `recent`', () => {
    const rows = conversation(40);
    const session = resolveWindow(rows, { sessionId: 's1', mode: 'session' });
    const recent = resolveWindow(rows, { sessionId: 's1', mode: 'recent', turns: 5 });

    expect(recent.messages.length).toBe(10); // five exchanges
    expect(session.messages.length).toBe(80); // the whole conversation
    expect(session.droppedMessages).toBe(0);
  });

  it('reports what the token budget removed instead of just dropping it', () => {
    const rows = conversation(40, 4000); // ~1000 tokens per message, latin
    const window = resolveWindow(rows, {
      sessionId: 's1',
      mode: 'session',
      tokenBudget: 4000,
    });

    expect(window.droppedMessages).toBeGreaterThan(0);
    expect(window.messages.length + window.droppedMessages).toBe(80);
    expect(window.tokenEst).toBeLessThanOrEqual(4000);
  });

  it('honours an instruction that states a character cap', () => {
    const rows = conversation(40, 400);
    // 4000 characters is roughly ten messages; the point is that the cap is applied
    // in characters, not converted into tokens the user never mentioned.
    const window = resolveWindow(rows, {
      sessionId: 's1',
      mode: 'session',
      charBudget: 4000,
    });
    const chars = window.messages.reduce((sum, item) => sum + item.content.length, 0);

    expect(chars).toBeLessThanOrEqual(4000);
    expect(window.droppedMessages).toBeGreaterThan(0);
  });

  it('never trims below the last exchange, even under an impossible budget', () => {
    const rows = conversation(3, 4000);
    const window = resolveWindow(rows, { sessionId: 's1', mode: 'session', tokenBudget: 10 });

    expect(window.messages.length).toBe(2);
    expect(window.droppedMessages).toBe(4);
  });

  it('defaults to a budget that holds a real conversation', () => {
    // ~16k tokens: the old 4000 was below a coding session, so `session` would have
    // degraded into `recent` for exactly the conversations worth summarising.
    const rows = conversation(20, 800);
    const window = resolveWindow(rows, { sessionId: 's1', mode: 'session' });

    expect(WINDOW_TOKEN_DEFAULT).toBe(16000);
    expect(window.tokenEst).toBeLessThanOrEqual(WINDOW_TOKEN_DEFAULT);
    expect(window.droppedMessages).toBe(0);
  });

  it('keeps `turn` and `selection` unchanged', () => {
    const rows = conversation(5);
    expect(resolveWindow(rows, { sessionId: 's1', mode: 'turn' }).messages.length).toBe(2);

    const picked = resolveWindow(rows, {
      sessionId: 's1',
      mode: 'selection',
      messageIds: [rows[1].id],
    });
    expect(picked.messageIds).toEqual([rows[1].id]);
    expect(picked.droppedMessages).toBe(0);
  });
});

describe('parseWindowIntent', () => {
  it('reads Chinese turn and character caps', () => {
    expect(parseWindowIntent('只整理最近 3 轮').turns).toBe(3);
    expect(parseWindowIntent('只看最后 2 个回合').turns).toBe(2);
    expect(parseWindowIntent('不超过 2000 字').charBudget).toBe(2000);
    expect(parseWindowIntent('只看最近 500 字符').charBudget).toBe(500);
    expect(parseWindowIntent('不超过两千字').charBudget).toBe(2000);
  });

  it('reads English equivalents', () => {
    expect(parseWindowIntent('only the last 4 turns').turns).toBe(4);
    expect(parseWindowIntent('summarise the last 3000 characters').charBudget).toBe(3000);
  });

  it('does not mistake a length statement about the material for a window cap', () => {
    // 「这段 500 字的说明」 is a description of the text, not a scope: reading it as a
    // cap would silently cut material the user asked to have summarised in full.
    expect(parseWindowIntent('把这段 500 字的说明整理出来')).toEqual({});
    expect(parseWindowIntent('keep the command you just shared')).toEqual({});
  });

  it('clamps to what the loader and the schema allow', () => {
    expect(parseWindowIntent('最近 99 轮').turns).toBe(20);
    expect(parseWindowIntent('不超过 50 字').charBudget).toBe(200);
  });

  it('leaves the instruction alone when it says nothing about scope', () => {
    expect(parseWindowIntent('')).toEqual({});
    expect(parseWindowIntent(undefined)).toEqual({});
  });
});

describe('renderWindowPrompt', () => {
  it('puts the id in brackets before the role, so citations come back as ids', () => {
    const rows = conversation(1);
    const window = resolveWindow(rows, { sessionId: 's1', mode: 'turn' });
    const prompt = renderWindowPrompt(window.messages);

    expect(prompt).toContain(`[${rows[0].id}] user:`);
    expect(prompt).toContain(`[${rows[1].id}] assistant:`);
  });
});
