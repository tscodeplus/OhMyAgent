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

function assistantToolCall(callId: string, timestamp = Date.now()) {
  return {
    role: 'assistant',
    content: [{ type: 'toolCall', id: callId, name: 'echo', arguments: { n: 1 } }],
    timestamp,
  };
}

/** A tool-cycle guard steer (user-role, marked so it never becomes a chat row). */
function guardMsg(kind: string, text: string, timestamp = Date.now()) {
  return { role: 'user', content: [{ type: 'text', text }], timestamp, ohmyagentGuard: kind };
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

  it('keeps the answer as a text segment when a skill is activated without tool calls', async () => {
    // A segments array holding only the skill card makes the WebUI render the
    // card and drop the reply — the streamed answer then "disappears" once the
    // post-turn refetch swaps in the persisted row.
    const { rows, repo } = setup();
    await persistMessages({
      agent: makeAgent([userMsg('调研一下'), assistantMsg('这是调研结论')]),
      sessionKey: 's-skill',
      runtime: { persistedMessageCount: 1, skillActivatedName: 'Researcher' },
      messageRepository: repo,
      logger: makeLogger(),
      ensureSession: () => {},
    } as never);

    const assistant = rows.find((r) => r.role === 'assistant')!;
    const meta = JSON.parse(String(assistant.metadata)) as {
      segments?: unknown[];
      skill_activated?: string;
    };
    expect(meta.skill_activated).toBe('Researcher');
    expect(meta.segments).toEqual([
      { type: 'skill', name: 'Researcher' },
      { type: 'text', content: '这是调研结论' },
    ]);
    // Flat content keeps the banner for channels that render text only.
    expect(assistant.content).toContain('这是调研结论');
    expect(assistant.content.startsWith('⚡️')).toBe(true);
  });

  it('keeps a tool-cycle guard notice out of the transcript and puts it in the trace', async () => {
    // Guard steers are user-role messages that exist only to stop a looping
    // model. Persisting them as user rows put English "[system] ..." bubbles in
    // the chat; they belong in the trace of the round they steered.
    const { rows, repo } = setup();
    await persistMessages({
      agent: makeAgent([
        userMsg('跑一个长任务'),
        assistantToolCall('tc1'),
        guardMsg('budget_warning', '[system] Tool-call budget: 7 of 10 rounds used.'),
        assistantToolCall('tc2'),
        guardMsg('budget_halt', '[system] The agent has reached its tool-call budget (10 rounds).'),
        assistantMsg('到这里，已有结果如下'),
      ]),
      sessionKey: 's-guard',
      // 0 = persist the whole transcript, so a leaked guard WOULD show up as a
      // second user row and fail the assertion below.
      runtime: { persistedMessageCount: 0 },
      messageRepository: repo,
      logger: makeLogger(),
      ensureSession: () => {},
    } as never);

    // No guard ever became a chat row: exactly the one real prompt, nothing else.
    expect(rows.filter((r) => r.role === 'user').map((r) => r.content)).toEqual(['跑一个长任务']);
    expect(rows.some((r) => r.content.includes('[system]'))).toBe(false);

    // Both notices survive as trace segments, in injection order.
    const segments = rows
      .filter((r) => r.role === 'assistant')
      .flatMap((r) => (JSON.parse(String(r.metadata)).segments ?? []) as Array<{ type: string }>)
      .filter((seg) => seg.type === 'guard');
    expect(segments).toEqual([
      {
        type: 'guard',
        kind: 'budget_warning',
        text: '[system] Tool-call budget: 7 of 10 rounds used.',
      },
      {
        type: 'guard',
        kind: 'budget_halt',
        text: '[system] The agent has reached its tool-call budget (10 rounds).',
      },
    ]);
  });

  it('attaches a guard notice to a text-only answer row too', async () => {
    const { rows, repo } = setup();
    await persistMessages({
      agent: makeAgent([
        userMsg('查三次'),
        guardMsg('repeat_success', '[system] The same tool call has succeeded 3 times in a row.'),
        assistantMsg('已经查过了'),
      ]),
      sessionKey: 's-guard-text',
      runtime: { persistedMessageCount: 0 },
      messageRepository: repo,
      logger: makeLogger(),
      ensureSession: () => {},
    } as never);

    const assistant = rows.find((r) => r.role === 'assistant')!;
    expect(JSON.parse(String(assistant.metadata)).segments).toEqual([
      {
        type: 'guard',
        kind: 'repeat_success',
        text: '[system] The same tool call has succeeded 3 times in a row.',
      },
      { type: 'text', content: '已经查过了' },
    ]);
    expect(assistant.content).toBe('已经查过了');
  });
});
