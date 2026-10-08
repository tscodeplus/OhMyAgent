import { describe, it, expect, vi } from 'vitest';

import { persistMessages } from '../../src/agent/message-persister';

function makeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeAgent(messages: unknown[]) {
  return { state: { messages }, ohmyagent_agentName: undefined } as never;
}

function userMsg(text: string, timestamp = Date.now()) {
  return { role: 'user', content: [{ type: 'text', text }], timestamp };
}

function assistantMsg(text: string, timestamp = Date.now()) {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    timestamp,
  };
}

function systemMsgWithTools(timestamp = Date.now()) {
  return {
    role: 'system',
    content: [],
    toolsAdded: [{ name: 'read', description: 'd', parameters: { type: 'object' } }],
    toolsRemoved: [],
    timestamp,
  };
}

function toolResult(text: string) {
  return {
    role: 'toolResult',
    toolName: 'webui_send_media',
    toolCallId: 'tc1',
    content: [{ type: 'text', text }],
    timestamp: Date.now(),
  };
}

function setup() {
  const rows: Array<{ id: string; role: string; content: string; metadata?: unknown }> = [];
  const repo = {
    create: (input: { id: string; role: string; content: string; metadata?: unknown }) => {
      rows.push({ ...input });
    },
  } as never;
  return { rows, repo };
}

describe('persistMessages counter semantics', () => {
  it('does not re-persist the eager user message when a system message precedes it (first-turn duplicate bug)', async () => {
    // Fresh-session first turn: the agent loop injected a tool-declaration
    // system message at index 0, so the raw transcript is 3 entries but only
    // 2 are persistable (user + assistant). persistedMessageCount === 1 must
    // skip the user message, not the injected system message.
    const { rows, repo } = setup();
    await persistMessages({
      agent: makeAgent([systemMsgWithTools(), userMsg('hello'), assistantMsg('hi there')]),
      sessionKey: 's1',
      runtime: { persistedMessageCount: 1 },
      messageRepository: repo,
      logger: makeLogger(),
      ensureSession: () => {},
    } as never);
    expect(rows.map((r) => `${r.role}:${r.content}`)).toEqual(['assistant:hi there']);
  });

  it('keeps toolResult image extraction scoped to the current batch with interleaved toolResults', async () => {
    const { rows, repo } = setup();
    const imgText = 'here ![pic](/api/files/serve?path=%2Ftmp%2Fpic.png)';
    // Turn 1 already persisted [u1, a1]; turn 2 appends u2, a2 (tool call is
    // folded away here) plus a toolResult carrying media before final a3.
    await persistMessages({
      agent: makeAgent([
        userMsg('q1'),
        assistantMsg('a1'),
        userMsg('generate an image'),
        toolResult(imgText),
        assistantMsg('done, image is above'),
      ]),
      sessionKey: 's2',
      runtime: { persistedMessageCount: 2 },
      messageRepository: repo,
      logger: makeLogger(),
      ensureSession: () => {},
    } as never);
    const persisted = rows.map((r) => `${r.role}:${(r.content as string).slice(0, 12)}`);
    // user2 + final assistant only — no re-persisted q1/a1.
    expect(persisted.filter((r) => r.startsWith('user:')).length).toBe(1);
  });

  it('advances the counter so sequential turns do not overlap', async () => {
    const { rows, repo } = setup();
    const runtime = { persistedMessageCount: 1 };
    await persistMessages({
      agent: makeAgent([userMsg('q1'), assistantMsg('a1')]),
      sessionKey: 's3',
      runtime,
      messageRepository: repo,
      logger: makeLogger(),
      ensureSession: () => {},
    } as never);
    await persistMessages({
      agent: makeAgent([userMsg('q1'), assistantMsg('a1'), userMsg('q2'), assistantMsg('a2')]),
      sessionKey: 's3',
      runtime,
      messageRepository: repo,
      logger: makeLogger(),
      ensureSession: () => {},
    } as never);
    expect(rows.map((r) => r.content)).toEqual(['a1', 'q2', 'a2']);
  });
});
