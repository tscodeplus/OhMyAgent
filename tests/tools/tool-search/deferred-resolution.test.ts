// ---------------------------------------------------------------------------
// Deferred tool resolution — the Tool Search bug-fix invariants
// ---------------------------------------------------------------------------
//
// Proves the two-part fix:
//   1. A tool flagged `deferred: true` is EXCLUDED from the tool list sent to
//      the LLM (compactToolsForPrompt hides it) → prompt token savings kept.
//   2. The same deferred tool STAYS resolvable by name in context.tools → when
//      the model calls it directly, the agent loop finds & executes it
//      (no "Tool not found"). This is the Bug #2 regression guard.

import { describe, it, expect, vi } from 'vitest';
import { Type } from 'typebox';
import { Agent } from '../../../src/pi-mono/agent/agent.js';
import { AssistantMessageEventStream } from '../../../src/pi-mono/ai/utils/event-stream.js';
import { getCurrentTools } from '../../../src/pi-mono/ai/utils/transcript.js';
import type { AssistantMessage } from '../../../src/pi-mono/ai/types.js';
import type { AgentTool } from '../../../src/pi-mono/agent/types.js';

const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function makeModel(): any {
  return {
    id: 'test-model',
    name: 'Test Model',
    api: 'openai-completions',
    provider: 'test-provider',
    baseUrl: '',
    reasoning: false,
    input: [],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 4096,
    maxTokens: 2048,
  };
}

function makeTool(
  name: string,
  opts: { deferred?: boolean; addedToolNames?: string[] } = {},
): AgentTool {
  return {
    name,
    label: name,
    description: `Tool: ${name}`,
    parameters: Type.Object({}),
    deferred: opts.deferred,
    execute: vi.fn(async (_toolCallId: string, _params: unknown) => ({
      content: [{ type: 'text' as const, text: `${name} ran` }],
      details: {},
      ...(opts.addedToolNames ? { addedToolNames: opts.addedToolNames } : {}),
    })),
  };
}

describe('deferred tool resolution', () => {
  it('excludes deferred tools from the LLM prompt but keeps core tools', async () => {
    const core = makeTool('file_read');
    const deferred = makeTool('memory_rebuild_persona', { deferred: true });

    let capturedToolNames: string[] | undefined;
    const streamFn = (_model: any, context: any): AssistantMessageEventStream => {
      // v0.86.0+ carries tool declarations in the transcript's system messages,
      // not on the context itself.
      capturedToolNames = getCurrentTools(context.messages).map((t: any) => t.name);
      const message: AssistantMessage = {
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
        api: 'openai-completions',
        provider: 'test-provider',
        model: 'test-model',
        usage: EMPTY_USAGE,
        stopReason: 'stop',
        timestamp: Date.now(),
      };
      const stream = new AssistantMessageEventStream();
      stream.push({ type: 'start', partial: { ...message } });
      stream.push({ type: 'text_start', contentIndex: 0, partial: { ...message } });
      stream.push({ type: 'text_delta', contentIndex: 0, delta: 'done', partial: { ...message } });
      stream.push({ type: 'text_end', contentIndex: 0, content: 'done', partial: { ...message } });
      stream.push({ type: 'done', reason: 'stop', message });
      return stream;
    };

    const agent = new Agent({
      initialState: { systemPrompt: 'test', model: makeModel(), tools: [core, deferred] },
      streamFn,
    });
    await agent.prompt('hi');

    expect(capturedToolNames).toContain('file_read');
    // The deferred tool must NOT be advertised to the model.
    expect(capturedToolNames).not.toContain('memory_rebuild_persona');
  });

  it('resolves & executes a deferred tool when the model calls it by name', async () => {
    const core = makeTool('file_read');
    const deferred = makeTool('memory_rebuild_persona', { deferred: true });

    let callCount = 0;
    const streamFn = (): AssistantMessageEventStream => {
      callCount++;
      const stream = new AssistantMessageEventStream();
      if (callCount === 1) {
        // Model directly invokes the deferred tool by name.
        const message: AssistantMessage = {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 'tc-1', name: 'memory_rebuild_persona', arguments: {} },
          ],
          api: 'openai-completions',
          provider: 'test-provider',
          model: 'test-model',
          usage: EMPTY_USAGE,
          stopReason: 'toolUse',
          timestamp: Date.now(),
        };
        stream.push({ type: 'start', partial: { ...message } });
        stream.push({ type: 'toolcall_start', contentIndex: 0, partial: { ...message } });
        stream.push({
          type: 'toolcall_delta',
          contentIndex: 0,
          delta: '{}',
          partial: { ...message },
        });
        stream.push({
          type: 'toolcall_end',
          contentIndex: 0,
          toolCall: { type: 'toolCall', id: 'tc-1', name: 'memory_rebuild_persona', arguments: {} },
          partial: { ...message },
        });
        stream.push({ type: 'done', reason: 'toolUse', message });
      } else {
        const message: AssistantMessage = {
          role: 'assistant',
          content: [{ type: 'text', text: 'rebuilt' }],
          api: 'openai-completions',
          provider: 'test-provider',
          model: 'test-model',
          usage: EMPTY_USAGE,
          stopReason: 'stop',
          timestamp: Date.now(),
        };
        stream.push({ type: 'start', partial: { ...message } });
        stream.push({ type: 'text_start', contentIndex: 0, partial: { ...message } });
        stream.push({
          type: 'text_delta',
          contentIndex: 0,
          delta: 'rebuilt',
          partial: { ...message },
        });
        stream.push({
          type: 'text_end',
          contentIndex: 0,
          content: 'rebuilt',
          partial: { ...message },
        });
        stream.push({ type: 'done', reason: 'stop', message });
      }
      return stream;
    };

    const agent = new Agent({
      initialState: { systemPrompt: 'test', model: makeModel(), tools: [core, deferred] },
      streamFn,
    });
    await agent.prompt('rebuild my persona');

    // The deferred tool resolved and executed — no "Tool not found".
    expect(deferred.execute).toHaveBeenCalledTimes(1);
  });

  it('unlocks a deferred tool for the model after a tool result reports it', async () => {
    const core = makeTool('file_read');
    const deferred = makeTool('memory_rebuild_persona', { deferred: true });
    // A discovery tool (tool_search) reports the deferred tool through
    // addedToolNames; the loop must turn that into a transcript system message
    // declaring the tool from that point on.
    const search = makeTool('tool_search', { addedToolNames: ['memory_rebuild_persona'] });

    const declaredPerCall: string[][] = [];
    let callCount = 0;
    const streamFn = (_model: any, context: any): AssistantMessageEventStream => {
      callCount++;
      declaredPerCall.push(getCurrentTools(context.messages).map((t: any) => t.name));
      const stream = new AssistantMessageEventStream();
      const message: AssistantMessage =
        callCount === 1
          ? {
              role: 'assistant',
              content: [{ type: 'toolCall', id: 'tc-1', name: 'tool_search', arguments: {} }],
              api: 'openai-completions',
              provider: 'test-provider',
              model: 'test-model',
              usage: EMPTY_USAGE,
              stopReason: 'toolUse',
              timestamp: Date.now(),
            }
          : {
              role: 'assistant',
              content: [{ type: 'text', text: 'done' }],
              api: 'openai-completions',
              provider: 'test-provider',
              model: 'test-model',
              usage: EMPTY_USAGE,
              stopReason: 'stop',
              timestamp: Date.now(),
            };
      stream.push({ type: 'start', partial: { ...message } });
      stream.push({ type: 'text_start', contentIndex: 0, partial: { ...message } });
      stream.push({ type: 'text_delta', contentIndex: 0, delta: 'x', partial: { ...message } });
      stream.push({ type: 'text_end', contentIndex: 0, content: 'x', partial: { ...message } });
      stream.push({ type: 'done', reason: 'stop', message });
      return stream;
    };

    const agent = new Agent({
      initialState: { systemPrompt: 'test', model: makeModel(), tools: [core, search, deferred] },
      streamFn,
    });
    await agent.prompt('find a tool');

    // Hidden before discovery...
    expect(declaredPerCall[0]).toContain('file_read');
    expect(declaredPerCall[0]).not.toContain('memory_rebuild_persona');
    // ...and declared to the model once a result reported it.
    expect(declaredPerCall[1]).toContain('memory_rebuild_persona');
  });
});
