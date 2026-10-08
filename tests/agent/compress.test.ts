/**
 * Tests for auto context compression (v9 pi-style).
 */

import { describe, it, expect, vi } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import {
  estimateTokens,
  estimateStaticContextTokens,
  findCutPoint,
  compressContext,
  DEFAULT_SETTINGS,
} from '../../src/agent/compress.js';

const { mockAuxLLMCall } = vi.hoisted(() => ({
  mockAuxLLMCall: vi.fn(),
}));

vi.mock('../../src/memory/aux-llm-client.js', async () => {
  const actual = await vi.importActual('../../src/memory/aux-llm-client.js');
  return {
    ...(actual as any),
    auxLLMCall: mockAuxLLMCall,
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUserMessage(content: string): AgentMessage {
  return { role: 'user', content: [{ type: 'text', text: content }], timestamp: Date.now() };
}

function makeAssistantMessage(text: string): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'test',
    model: 'test-model',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  };
}

function makeToolResult(name: string, text: string): AgentMessage {
  return {
    role: 'toolResult',
    toolCallId: 'call_1',
    toolName: name,
    content: [{ type: 'text', text }],
    isError: false,
    timestamp: Date.now(),
  };
}

const baseInput = {
  contextWindow: 128000,
  settings: DEFAULT_SETTINGS,
  sessionKey: 'test-session',
  mainModelRef: 'deepseek/deepseek-v4-pro',
  globalFallbackRefs: [] as string[],
  apiKeys: {} as Record<string, string>,
  baseUrls: {} as Record<string, string>,
  logger: undefined,
};

// ---------------------------------------------------------------------------
// estimateTokens
// ---------------------------------------------------------------------------

describe('estimateTokens', () => {
  it('returns 0 for empty array', () => {
    expect(estimateTokens([])).toBe(0);
  });

  it('uses chars/4 heuristic', () => {
    const msg: AgentMessage = { role: 'user', content: 'hello world', timestamp: Date.now() }; // 11 chars
    expect(estimateTokens([msg])).toBe(Math.ceil(11 / 4)); // 3
  });

  it('estimates from content blocks', () => {
    const msg = makeUserMessage('hello world');
    expect(estimateTokens([msg])).toBeGreaterThan(0);
  });

  it('scales with message count', () => {
    const msgs = Array.from({ length: 10 }, (_, i) => makeUserMessage(`message number ${i}`));
    const halfTokens = estimateTokens(msgs.slice(0, 5));
    const allTokens = estimateTokens(msgs);
    expect(allTokens).toBeGreaterThan(halfTokens);
  });

  it('estimates images at 4800 chars', () => {
    const msg = {
      role: 'user',
      content: [{ type: 'image', data: '...', mimeType: 'image/png' }],
      timestamp: Date.now(),
    } satisfies AgentMessage;
    expect(estimateTokens([msg])).toBe(Math.ceil(4800 / 4)); // 1200
  });

  it('counts tool calls', () => {
    const msg = {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'call_1', name: 'shell', arguments: { command: 'ls' } }],
      api: 'openai-completions',
      provider: 'test',
      model: 'test-model',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'toolUse',
      timestamp: Date.now(),
    } satisfies AgentMessage;
    const tokens = estimateTokens([msg]);
    expect(tokens).toBeGreaterThan(0);
  });

  it('does not crash when a toolCall block has no name (M9)', () => {
    const msg = {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'call_1', arguments: { command: 'ls' } }],
    } as unknown as AgentMessage;
    expect(() => estimateTokens([msg])).not.toThrow();
    expect(estimateTokens([msg])).toBeGreaterThan(0);
  });

  it('returns 0 for malformed content instead of crashing (M9)', () => {
    // BigInt makes JSON.stringify throw — estimation must degrade gracefully
    const msg = {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'call_1', arguments: { big: 1n } }],
    } as unknown as AgentMessage;
    expect(() => estimateTokens([msg])).not.toThrow();
    expect(estimateTokens([msg])).toBe(0);
  });

  it('handles null content without crashing (M9)', () => {
    const msg = { role: 'user', content: null } as unknown as AgentMessage;
    expect(() => estimateTokens([msg])).not.toThrow();
    expect(estimateTokens([msg])).toBe(0);
  });
});

describe('estimateStaticContextTokens', () => {
  it('prices the system prompt and each tool schema', () => {
    const empty = estimateStaticContextTokens(undefined, undefined);
    expect(empty).toBe(0);

    const promptOnly = estimateStaticContextTokens('You are a helpful agent.', []);
    const withTool = estimateStaticContextTokens('You are a helpful agent.', [
      { name: 'shell', description: 'Run a command', parameters: { type: 'object' } },
    ]);
    expect(promptOnly).toBeGreaterThan(0);
    expect(withTool).toBeGreaterThan(promptOnly);
  });

  it('weights non-ASCII prompt text like the transcript estimator', () => {
    const ascii = estimateStaticContextTokens('abcdefgh', []);
    const cjk = estimateStaticContextTokens('你好你好你好你好', []);
    expect(cjk).toBe(ascii * 2);
  });
});

// ---------------------------------------------------------------------------
// findCutPoint
// ---------------------------------------------------------------------------

describe('findCutPoint', () => {
  it('returns 0 when all messages fit in budget', () => {
    const msgs = [makeUserMessage('hi'), makeAssistantMessage('hello')];
    const cut = findCutPoint(msgs, 20000);
    expect(cut).toBe(0);
  });

  it('cuts somewhere when budget is small', () => {
    const msgs = Array.from({ length: 20 }, (_, i) =>
      makeUserMessage(`this is a longer message number ${i} with enough text to consume tokens`),
    );
    const cut = findCutPoint(msgs, 50); // very small budget
    expect(cut).toBeGreaterThan(0);
    expect(cut).toBeLessThan(msgs.length);
  });

  it('avoids cutting at toolResult', () => {
    const msgs = [
      makeUserMessage('run command'),
      makeAssistantMessage('ok'),
      {
        role: 'toolResult' as const,
        toolCallId: '1',
        toolName: 'shell',
        content: [{ type: 'text' as const, text: 'output' }],
        isError: false,
        timestamp: 1,
      },
      makeUserMessage('second message with a lot more content to push past budget'),
    ];
    const cut = findCutPoint(msgs, 20);
    // Should not cut at index 2 (toolResult)
    expect(cut).not.toBe(2);
  });
});

// ---------------------------------------------------------------------------
// compressContext integration
// ---------------------------------------------------------------------------

describe('compressContext', () => {
  it('returns null when token usage is below threshold', async () => {
    const msgs = [makeUserMessage('hi'), makeAssistantMessage('hello')];
    const result = await compressContext({ ...baseInput, messages: msgs });
    expect(result.summaryMessage).toBeNull();
  });

  it('returns null with few compressible messages', async () => {
    const msgs = Array.from({ length: 3 }, (_, i) => makeUserMessage(`msg ${i}`));
    // Token count is tiny → won't trigger
    const result = await compressContext({ ...baseInput, messages: msgs });
    expect(result.summaryMessage).toBeNull();
  });

  it('hard-truncates instead of returning empty when the LLM fails (M3)', async () => {
    mockAuxLLMCall.mockRejectedValue(new Error('boom'));
    // 10 messages × ~130 chars ≈ 30 tokens each → ~300 tokens, above the
    // 200-token threshold (contextWindow 300 - reserve 100); keepRecentTokens
    // 50 → cut point lands inside the history.
    const msgs = Array.from({ length: 10 }, (_, i) =>
      makeUserMessage(
        `message number ${i} with enough text to consume tokens and trigger compression here plus some extra padding`,
      ),
    );
    const result = await compressContext({
      ...baseInput,
      messages: msgs,
      contextWindow: 300,
      settings: { reserveTokens: 100, keepRecentTokens: 50 },
    });

    expect(mockAuxLLMCall).toHaveBeenCalledTimes(1);
    // Real truncation fallback: a marker message + a valid cut point, not empty
    expect(result.summaryMessage).not.toBeNull();
    expect(result.summaryMessage!.role).toBe('user');
    expect(result.compressedIndex).toBeGreaterThan(0);
    expect(result.summary).toBe(''); // empty summary → next turn may retry summarization
    const text = (result.summaryMessage!.content as any[]).map((b: any) => b.text ?? '').join('');
    expect(text).toContain('Truncated');
  });
});

// ---------------------------------------------------------------------------
// kernel M2 `context.compact`: judged pre-compaction prune
// ---------------------------------------------------------------------------

describe('compressContext judgedPrune (context.compact)', () => {
  beforeEach(() => {
    mockAuxLLMCall.mockReset();
  });

  // Ten ~130-char messages: ~325 transcript tokens, above the 200-token
  // threshold (contextWindow 300 - reserve 100); keepRecentTokens 50 puts the
  // cut point at index 8, so the compressible region is messages 0..7.
  function makeTriggeringMessages(count = 10): any[] {
    return Array.from({ length: count }, (_, i) =>
      makeUserMessage(
        `message number ${i} with enough text to consume tokens and trigger compression here plus some extra padding`,
      ),
    );
  }

  const triggeringInput = {
    ...baseInput,
    contextWindow: 300,
    settings: { reserveTokens: 100, keepRecentTokens: 50 },
  };

  it('skips the LLM summarization entirely when the prune clears the watermark', async () => {
    const msgs = makeTriggeringMessages();
    // Keep 2 of the 8 compressible messages → ~66 pruned + ~66 recent tokens,
    // below the 200-token watermark.
    mockAuxLLMCall.mockResolvedValue('## Goals\nshould never be reached');
    const judgedPrune = async (oldMessages: any[]) => ({
      keptMessages: oldMessages.slice(0, 2),
    });

    const result = await compressContext({ ...triggeringInput, messages: msgs, judgedPrune });

    expect(mockAuxLLMCall).not.toHaveBeenCalled(); // summary-free claim
    expect(result.pruned).toBe(true);
    expect(result.summaryMessage).toBeNull();
    expect(result.summary).toBe('');
    // kept old messages + the untouched recent tail
    expect(result.prunedMessages).toHaveLength(4);
    expect(result.prunedMessages![0]).toBe(msgs[0]);
    expect(result.prunedMessages![3]).toBe(msgs[9]);
  });

  it('runs the LLM summary over the PRUNED set when the prune alone is not enough', async () => {
    const msgs = makeTriggeringMessages();
    // Keep 7 of 8 → still above the watermark → LLM summarization continues.
    mockAuxLLMCall.mockResolvedValue('## Goals\n condensed');
    const judgedPrune = async (oldMessages: any[]) => ({
      keptMessages: oldMessages.filter((m: any) => !m.content[0].text.includes('number 7 ')),
    });

    const result = await compressContext({ ...triggeringInput, messages: msgs, judgedPrune });

    expect(mockAuxLLMCall).toHaveBeenCalledTimes(1);
    expect(result.summary).toBe('## Goals\n condensed');
    expect(result.compressedIndex).toBe(8); // split index unchanged by the prune
    const call = mockAuxLLMCall.mock.calls[0]![1] as { userPrompt: string };
    expect(call.userPrompt).toContain('number 0 ');
    expect(call.userPrompt).not.toContain('number 7 '); // dropped segment not summarized
  });

  it('keeps the current LLM path byte-identical when judgedPrune prunes nothing', async () => {
    const msgs = makeTriggeringMessages();
    mockAuxLLMCall.mockResolvedValue('## Goals\n full judge summary');
    const judgedPrune = async (_oldMessages: any[]) => ({
      keptMessages: _oldMessages, // keep-all — nothing dropped
    });

    const result = await compressContext({ ...triggeringInput, messages: msgs, judgedPrune });

    expect(mockAuxLLMCall).toHaveBeenCalledTimes(1);
    expect(result.pruned).toBeUndefined();
    expect(result.prunedMessages).toBeUndefined();
    expect(result.summary).toBe('## Goals\n full judge summary');
  });

  it('degrades to the untouched LLM path when judgedPrune returns undefined', async () => {
    const msgs = makeTriggeringMessages();
    mockAuxLLMCall.mockResolvedValue('## Goals\n plain path');
    const judgedPrune = async (_oldMessages: any[]) => undefined; // shadow / gray / fallback

    const result = await compressContext({ ...triggeringInput, messages: msgs, judgedPrune });

    expect(mockAuxLLMCall).toHaveBeenCalledTimes(1);
    expect(result.pruned).toBeUndefined();
    expect(result.summary).toBe('## Goals\n plain path');
  });

  it('degrades to the untouched LLM path when judgedPrune throws', async () => {
    const msgs = makeTriggeringMessages();
    mockAuxLLMCall.mockResolvedValue('## Goals\n after prune failure');
    const judgedPrune = async (_oldMessages: any[]) => {
      throw new Error('prune hook exploded');
    };

    const result = await compressContext({ ...triggeringInput, messages: msgs, judgedPrune });

    expect(mockAuxLLMCall).toHaveBeenCalledTimes(1);
    expect(result.summary).toBe('## Goals\n after prune failure');
  });
});
