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
import type { AssistantMessage } from '../../../src/pi-mono/ai/types.js';
import type { AgentTool } from '../../../src/pi-mono/agent/types.js';

const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
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

function makeTool(name: string, opts: { deferred?: boolean } = {}): AgentTool {
  return {
    name,
    label: name,
    description: `Tool: ${name}`,
    parameters: Type.Object({}),
    deferred: opts.deferred,
    execute: vi.fn(async () => ({
      content: [{ type: 'text', text: `${name} ran` }],
      details: {},
    })),
  };
}

describe('deferred tool resolution', () => {
  it('excludes deferred tools from the LLM prompt but keeps core tools', async () => {
    const core = makeTool('file_read');
    const deferred = makeTool('memory_rebuild_persona', { deferred: true });

    let capturedToolNames: string[] | undefined;
    const streamFn = (_model: any, context: any): AssistantMessageEventStream => {
      capturedToolNames = (context.tools ?? []).map((t: any) => t.name);
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
          content: [{ type: 'toolCall', id: 'tc-1', name: 'memory_rebuild_persona', arguments: {} }],
          api: 'openai-completions',
          provider: 'test-provider',
          model: 'test-model',
          usage: EMPTY_USAGE,
          stopReason: 'toolUse',
          timestamp: Date.now(),
        };
        stream.push({ type: 'start', partial: { ...message } });
        stream.push({ type: 'toolcall_start', contentIndex: 0, partial: { ...message } });
        stream.push({ type: 'toolcall_delta', contentIndex: 0, delta: '{}', partial: { ...message } });
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
        stream.push({ type: 'text_delta', contentIndex: 0, delta: 'rebuilt', partial: { ...message } });
        stream.push({ type: 'text_end', contentIndex: 0, content: 'rebuilt', partial: { ...message } });
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
});

