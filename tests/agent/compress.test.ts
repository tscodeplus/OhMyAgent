/**
 * Tests for auto context compression (v9 pi-style).
 */

import { describe, it, expect } from 'vitest';
import {
  estimateTokens,
  findCutPoint,
  compressContext,
  DEFAULT_SETTINGS,
} from '../../src/agent/compress.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUserMessage(content: string) {
  return { role: 'user' as const, content: [{ type: 'text' as const, text: content }] };
}

function makeAssistantMessage(text: string) {
  return { role: 'assistant' as const, content: [{ type: 'text' as const, text }] };
}

function makeToolResult(name: string, text: string) {
  return {
    role: 'toolResult' as const,
    toolCallId: 'call_1',
    toolName: name,
    content: [{ type: 'text' as const, text }],
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
    const msg = { role: 'user' as const, content: 'hello world' }; // 11 chars
    expect(estimateTokens([msg])).toBe(Math.ceil(11 / 4)); // 3
  });

  it('estimates from content blocks', () => {
    const msg = makeUserMessage('hello world');
    expect(estimateTokens([msg])).toBeGreaterThan(0);
  });

  it('scales with message count', () => {
    const msgs = Array.from({ length: 10 }, (_, i) =>
      makeUserMessage(`message number ${i}`),
    );
    const halfTokens = estimateTokens(msgs.slice(0, 5));
    const allTokens = estimateTokens(msgs);
    expect(allTokens).toBeGreaterThan(halfTokens);
  });

  it('estimates images at 4800 chars', () => {
    const msg = { role: 'user' as const, content: [{ type: 'image' as const, source: '...' }] };
    expect(estimateTokens([msg])).toBe(Math.ceil(4800 / 4)); // 1200
  });

  it('counts tool calls', () => {
    const msg = { role: 'assistant' as const, content: [
      { type: 'toolCall' as const, name: 'shell', arguments: { command: 'ls' } },
    ]};
    const tokens = estimateTokens([msg]);
    expect(tokens).toBeGreaterThan(0);
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
      { role: 'toolResult' as const, toolCallId: '1', toolName: 'shell', content: [{ type: 'text' as const, text: 'output' }], isError: false, timestamp: 1 },
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
    const result = await compressContext({ ...baseInput, messages: msgs as any });
    expect(result.summaryMessage).toBeNull();
  });

  it('returns null with few compressible messages', async () => {
    const msgs = Array.from({ length: 3 }, (_, i) =>
      makeUserMessage(`msg ${i}`),
    );
    // Token count is tiny → won't trigger
    const result = await compressContext({ ...baseInput, messages: msgs as any });
    expect(result.summaryMessage).toBeNull();
  });
});
