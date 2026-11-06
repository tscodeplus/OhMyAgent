import { beforeEach, describe, it, expect, vi } from 'vitest';
import type { AssistantMessage, AssistantMessageEvent, JsonValue } from '@earendil-works/pi-ai';
import { AssistantMessageEventStream } from '../../src/pi-mono/ai/utils/event-stream.js';
import { agentLoop } from '../../src/pi-mono/agent/agent-loop.js';
import type { AgentEvent, AgentLoopConfig } from '../../src/pi-mono/agent/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: 'openai-completions',
    provider: 'test',
    model: 'test-model',
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
    ...overrides,
  };
}

/** Text-only reply: the natural end of a turn. */
function textStep(text: string): AssistantMessage {
  return assistantMessage({ content: [{ type: 'text', text }], stopReason: 'stop' });
}

/** One round of tool calling. */
function toolStep(
  callId: string,
  args: Record<string, JsonValue>,
  name = 'echo',
): AssistantMessage {
  return assistantMessage({
    content: [{ type: 'toolCall', id: callId, name, arguments: args }],
    stopReason: 'toolUse',
  });
}

function streamOf(message: AssistantMessage): AssistantMessageEventStream {
  const stream = new AssistantMessageEventStream();
  const events: AssistantMessageEvent[] = [
    { type: 'start', partial: message },
    {
      type: 'done',
      reason: message.stopReason === 'stop' ? 'stop' : 'toolUse',
      message,
    } as AssistantMessageEvent,
  ];
  for (const event of events) stream.push(event);
  stream.end(message);
  return stream;
}

/** Deterministic stream function: one scripted assistant message per LLM call. */
function scriptedStreamFn(steps: Array<() => AssistantMessage>) {
  let index = 0;
  return vi.fn(() => {
    const step = steps[Math.min(index, steps.length - 1)];
    index++;
    return streamOf(step());
  });
}

const echoTool = {
  name: 'echo',
  label: 'Echo',
  description: 'Returns a fixed string.',
  parameters: {} as Record<string, unknown>,
  execute: vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'ok' }], details: null })),
};

function makeConfig(maxToolCycles?: number): AgentLoopConfig {
  return {
    model: { provider: 'test', id: 'test-model', api: 'openai-completions' } as any,
    convertToLlm: async (messages) => messages as any,
    ...(maxToolCycles === undefined ? {} : { maxToolCycles }),
  };
}

async function run(config: AgentLoopConfig, streamFn: any) {
  const events: AgentEvent[] = [];
  const stream = agentLoop(
    [{ role: 'user', content: 'hi', timestamp: Date.now() } as any],
    {
      systemPrompt: '',
      messages: [],
      tools: [echoTool],
    } as any,
    config,
    undefined,
    streamFn,
  );
  for await (const event of stream) events.push(event);
  const messages = await stream.result();
  return { events, messages };
}

/** Steering diagnostics the loop injected (user-role messages it authored). */
function guardTexts(messages: any[]): string[] {
  return messages
    .filter((m) => m.role === 'user' && Array.isArray(m.content))
    .flatMap((m) => m.content as Array<{ type: string; text?: string }>)
    .filter((part) => part.type === 'text' && (part.text ?? '').startsWith('[system]'))
    .map((part) => part.text as string);
}

/** Guard steers carry their kind so the transcript can render them as a trace
 *  note instead of a user bubble. */
function guardKinds(messages: any[]): string[] {
  return messages
    .filter((m) => m.role === 'user' && m.ohmyagentGuard)
    .map((m) => String(m.ohmyagentGuard));
}

function toolResultTexts(messages: any[]): string[] {
  return messages
    .filter((m) => m.role === 'toolResult')
    .flatMap((m) => m.content as Array<{ type: string; text?: string }>)
    .filter((part) => part.type === 'text')
    .map((part) => part.text as string);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('agentLoop tool-call budget guard', () => {
  // The tool object is shared across cases; its spy counts each case separately.
  beforeEach(() => echoTool.execute.mockClear());

  it('warns at 70% of the budget and steals the remaining rounds for the summary', async () => {
    const budget = 10;
    // 10 tool rounds with distinct arguments (so the repeat guard stays quiet),
    // then the model replies with text after being told the budget is gone.
    const steps = [
      ...Array.from({ length: budget }, (_, i) => () => toolStep(`c${i}`, { n: i })),
      () => textStep('done'),
    ];
    const streamFn = scriptedStreamFn(steps);

    const { messages } = await run(makeConfig(budget), streamFn);

    const guards = guardTexts(messages);
    // ceil(10 * 0.7) === 7
    expect(guards.some((g) => g.includes('Tool-call budget: 7 of 10 rounds used'))).toBe(true);
    expect(guards.some((g) => g.includes('reached its tool-call budget (10 rounds)'))).toBe(true);
    // Each guard fires exactly once.
    expect(guards.filter((g) => g.includes('Tool-call budget:')).length).toBe(1);
    expect(guards.filter((g) => g.includes('reached its tool-call budget')).length).toBe(1);
    // The final answer still reaches the user.
    expect((messages.at(-1) as any).content[0].text).toBe('done');
    // Both notice kinds travel on the message for the persister.
    expect(guardKinds(messages)).toEqual(['budget_warning', 'budget_halt']);
  });

  it('stops the loop on the first tool call after the budget is exhausted', async () => {
    const budget = 3;
    // Rounds 1-3 spend the budget, round 4 is the ignored "summarize" round.
    // A fifth step exists only to prove it is never requested.
    const steps = [
      ...Array.from({ length: budget + 2 }, (_, i) => () => toolStep(`c${i}`, { n: i })),
      () => textStep('unreachable'),
    ];
    const streamFn = scriptedStreamFn(steps);

    const { messages } = await run(makeConfig(budget), streamFn);

    // budget rounds + exactly one summarized-attempt round, then stop.
    expect(streamFn).toHaveBeenCalledTimes(budget + 1);
    // The refused call is reported back as an error, and the batch terminates.
    const results = toolResultTexts(messages);
    expect(results.at(-1)).toContain('no further tool calls will run');
    // Only the budget rounds actually executed the tool.
    expect(echoTool.execute).toHaveBeenCalledTimes(budget);
  });

  it('steers once when the same successful call repeats with identical arguments', async () => {
    // Distinct call ids, identical arguments and tool: the call succeeds every
    // time, so the failing-streak guard cannot see it.
    const steps = [
      () => toolStep('a', { path: 'README.md' }, 'echo'),
      () => toolStep('b', { path: 'README.md' }, 'echo'),
      () => toolStep('c', { path: 'README.md' }, 'echo'),
      () => textStep('done'),
    ];
    const streamFn = scriptedStreamFn(steps);

    const { messages } = await run(makeConfig(50), streamFn);

    const guards = guardTexts(messages).filter((g) => g.includes('identical arguments'));
    expect(guards).toHaveLength(1);
    expect(guards[0]).toContain('succeeded 3 times in a row');
    expect(guardKinds(messages)).toEqual(['repeat_success']);
    expect(streamFn).toHaveBeenCalledTimes(4);
  });

  it('does not steer when the same tool is called with different arguments', async () => {
    const steps = [
      () => toolStep('a', { path: 'a.md' }, 'echo'),
      () => toolStep('b', { path: 'b.md' }, 'echo'),
      () => toolStep('c', { path: 'c.md' }, 'echo'),
      () => textStep('done'),
    ];
    const streamFn = scriptedStreamFn(steps);

    const { messages } = await run(makeConfig(50), streamFn);

    expect(guardTexts(messages)).toHaveLength(0);
  });

  it('respects argument key order when comparing calls', async () => {
    const steps = [
      () => toolStep('a', { a: 1, b: 2 }, 'echo'),
      () => toolStep('b', { b: 2, a: 1 }, 'echo'),
      () => toolStep('c', { b: 2, a: 1 }, 'echo'),
      () => textStep('done'),
    ];
    const streamFn = scriptedStreamFn(steps);

    const { messages } = await run(makeConfig(50), streamFn);

    // Key order is not a difference: all three calls are the same call.
    const guards = guardTexts(messages).filter((g) => g.includes('identical arguments'));
    expect(guards).toHaveLength(1);
  });

  it('never halts when the budget is disabled', async () => {
    const steps = [
      ...Array.from({ length: 6 }, (_, i) => () => toolStep(`c${i}`, { n: i })),
      () => textStep('done'),
    ];
    const streamFn = scriptedStreamFn(steps);

    const { messages } = await run(makeConfig(0), streamFn);

    expect(guardTexts(messages)).toHaveLength(0);
    expect(streamFn).toHaveBeenCalledTimes(7);
  });
});
