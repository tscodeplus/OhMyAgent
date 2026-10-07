/**
 * context.forget decision spec + hook (kernel M2, impl doc §4.6).
 *
 * Deterministic mock judge (./mock.ts): nomination rules (≥400 tokens, no
 * errors, ≤8 per call, current turn excluded), the conservative 0.9 drop
 * threshold with gray keeps, tombstone format, per-session judged-claim
 * marking (judged+active never re-asked, fallback rounds can re-ask), and the
 * strict no-op invariant (judge absent OR point off → not asked, zero change).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DROP_PROBABILITY,
  MAX_CANDIDATES_PER_CALL,
  MIN_CANDIDATE_TOKENS,
  createContextForgetSpec,
  forgetTombstoneLine,
} from '../../src/judge/decisions/context-forget.js';
import { judgeContextForget } from '../../src/judge/hooks/context-forget.js';
import { JudgeEngine } from '../../src/judge/index.js';
import { JudgeLedger } from '../../src/judge/ledger.js';
import { createMockResolver, createMockTier, mockJudgeConfig, type MockTierSpec } from './mock.js';
import type { AgentMessage } from '@earendil-works/pi-agent-core';

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'judge-context-forget-'));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeEngine(
  mode: 'active' | 'shadow' | 'off',
  overrides: Partial<MockTierSpec> = {},
): {
  engine: JudgeEngine;
  calls: NonNullable<MockTierSpec['calls']>;
} {
  const calls: NonNullable<MockTierSpec['calls']> = [];
  const tier = createMockTier({ judgeId: 'mock/j1', calls, ...overrides });
  const engine = new JudgeEngine({
    config: mockJudgeConfig(mode === 'active' ? {} : { modes: { default: mode } }),
    resolver: () => ({ tiers: [tier], noKeyRefs: [], unresolvableRefs: [] }),
    ledger: new JudgeLedger({ dir: tmpDir }),
  });
  return { engine, calls };
}

/** ASCII text long enough to clear the 400-token nomination floor. */
function bigResultText(id: string): string {
  return `${id} `.repeat(700).trim(); // ~2100 chars → ~525 tokens
}

function makeToolResult(
  toolName: string,
  text: string,
  opts: { isError?: boolean } = {},
): AgentMessage {
  return {
    role: 'toolResult',
    toolCallId: `call_${toolName}`,
    toolName,
    content: [{ type: 'text', text }],
    isError: opts.isError ?? false,
    timestamp: Date.now(),
  } as AgentMessage;
}

function makeUser(text: string): AgentMessage {
  return { role: 'user', content: text, timestamp: Date.now() } as AgentMessage;
}

/**
 * Transcripts for the hook: N stale tool results, each separated by its own
 * user turn, then the current turn's user message last.
 */
function makeTranscript(results: AgentMessage[]): AgentMessage[] {
  const messages: AgentMessage[] = [makeUser('start the work')];
  for (const result of results) {
    messages.push({
      role: 'assistant',
      content: 'doing it',
      timestamp: Date.now(),
    } as AgentMessage);
    messages.push(result);
    messages.push(makeUser('next step please'));
  }
  return messages;
}

// keep-probabilities: evicted only at P(drop) = 1 - probability >= 0.9
const KEEP = 0.95;
const GRAY = 0.25; // decided "not needed" at 75% — kept (conservative, below the gray zone)
const EVICT = 0.05; // P(drop) = 0.95

describe('context.forget spec policy', () => {
  it('evicts only P(drop) >= 0.9, keeps gray candidates; kept ids listed', async () => {
    const { engine } = makeEngine('active', {
      answers: {
        k1: { type: 'noul', probability: KEEP },
        k2: { type: 'noul', probability: GRAY },
        k3: { type: 'noul', probability: EVICT },
      },
    });
    const spec = createContextForgetSpec([
      { key: 'k1', tool: 'shell', sizeTokens: 500, ageTurns: 3, firstLine: 'a', text: 'aaa' },
      { key: 'k2', tool: 'shell', sizeTokens: 500, ageTurns: 3, firstLine: 'b', text: 'bbb' },
      { key: 'k3', tool: 'shell', sizeTokens: 500, ageTurns: 3, firstLine: 'c', text: 'ccc' },
    ]);
    const verdict = await engine.decideMany(spec, {
      state: {
        taskHint: 'fix the build',
        candidates: [
          { key: 'k1', tool: 'shell', sizeTokens: 500, ageTurns: 3, firstLine: 'a', text: 'aaa' },
          { key: 'k2', tool: 'shell', sizeTokens: 500, ageTurns: 3, firstLine: 'b', text: 'bbb' },
          { key: 'k3', tool: 'shell', sizeTokens: 500, ageTurns: 3, firstLine: 'c', text: 'ccc' },
        ],
      },
      sessionId: 's1',
    });
    expect(verdict.source).toBe('judge');
    expect(verdict.mode).toBe('active');
    expect(verdict.outcome).toEqual({ action: 'keep', ids: ['k1', 'k2'] });
  });

  it('all-clear verdicts are keep-all', async () => {
    const { engine } = makeEngine('active', {
      answers: { k1: { type: 'noul', probability: KEEP } },
    });
    const verdict = await engine.decideMany(createContextForgetSpec([{ key: 'k1' } as any]), {
      state: {
        candidates: [
          { key: 'k1', tool: 'shell', sizeTokens: 500, ageTurns: 1, firstLine: 'a', text: 'a' },
        ],
      },
    });
    expect(verdict.outcome).toEqual({ action: 'keep-all' });
  });

  it('shadow asks (ledger line) but outcome is the keep-all fallback', async () => {
    const { engine } = makeEngine('shadow');
    const verdict = await engine.decideMany(createContextForgetSpec([{ key: 'k1' } as any]), {
      state: {
        candidates: [
          { key: 'k1', tool: 'shell', sizeTokens: 500, ageTurns: 1, firstLine: 'a', text: 'a' },
        ],
      },
      sessionId: 's1',
    });
    expect(verdict.mode).toBe('shadow');
    expect(verdict.outcome).toEqual({ action: 'keep-all' });
    expect(engine.ledger.recent(1).length).toBe(1);
  });
});

describe('forgetTombstoneLine', () => {
  it('names the tool, the turn gap and a truncated first line', () => {
    const line = forgetTombstoneLine('shell', 4, 'build output: 3 tests failed '.repeat(10));
    expect(line).toMatch(/^\[evicted: shell result from ~4 turn\(s\) ago, firstLine: build output/);
    expect(line).toContain('full text kept in the session record');
    expect(line.length).toBeLessThanOrEqual(220);
  });

  it('omits the digest when the first line is empty', () => {
    const line = forgetTombstoneLine('web_fetch', 2, '');
    expect(line).toBe(
      '[evicted: web_fetch result from ~2 turn(s) ago, full text kept in the session record — recall via memory/session history if needed]',
    );
  });
});

describe('judgeContextForget hook', () => {
  it('no engine → not asked (strict no-op)', async () => {
    const messages = makeTranscript([makeToolResult('shell', bigResultText('r1'))]);
    const result = await judgeContextForget({
      messages,
      lastUserIndex: messages.length - 1,
      sessionKey: 'no-engine',
    });
    expect(result).toEqual({ asked: false });
  });

  it('mode off → not asked', async () => {
    const { engine } = makeEngine('off');
    const messages = makeTranscript([makeToolResult('shell', bigResultText('r1'))]);
    const result = await judgeContextForget({
      engine,
      messages,
      lastUserIndex: messages.length - 1,
      sessionKey: 'mode-off',
    });
    expect(result).toEqual({ asked: false });
  });

  it('judged eviction: entries carry the ORIGINAL index and a tombstone; batch is ONE decideMany', async () => {
    const { engine, calls } = makeEngine('active', {
      answers: {
        k1: { type: 'noul', probability: EVICT },
        k2: { type: 'noul', probability: KEEP },
        k3: { type: 'noul', probability: EVICT },
      },
    });
    const messages = makeTranscript([
      makeToolResult('shell', bigResultText('r1')),
      makeToolResult('web_fetch', bigResultText('r2')),
      makeToolResult('shell', bigResultText('r3')),
    ]);
    const result = await judgeContextForget({
      engine,
      messages,
      lastUserIndex: messages.length - 1,
      sessionKey: 'evict-flow',
      taskHint: 'continue the refactor',
    });
    expect(result.asked).toBe(true);
    expect(result.entries).toHaveLength(2);
    // r1 is at index 2, r3 at index 6 (assistant/result/user triplets)
    expect(result.entries![0]).toMatchObject({ index: 2 });
    expect(result.entries![1]).toMatchObject({ index: 8 });
    expect(result.entries![0].tombstone).toContain('[evicted: shell result from ~3 turn(s) ago');
    expect(result.entries![1].tombstone).toContain('r3');
    // one batched decideMany over all three nominees, state billed once
    expect(calls).toHaveLength(1);
    const state = calls[0]!.context.state as { taskHint: string; candidates: unknown[] };
    expect(state.taskHint).toBe('continue the refactor');
    expect(state.candidates).toHaveLength(3);
  });

  it('nomination rules: errors, small results and the current turn are never nominated', async () => {
    const { engine, calls } = makeEngine('active', { answers: {} });
    const messages = makeTranscript([
      makeToolResult('shell', bigResultText('err'), { isError: true }),
      makeToolResult('shell', 'tiny output'),
      makeToolResult('shell', bigResultText('ok')),
    ]);
    // lastUserIndex points at the LAST user message — the current turn.
    const result = await judgeContextForget({
      engine,
      messages,
      lastUserIndex: messages.length - 1,
      sessionKey: 'nomination-rules',
    });
    expect(result.asked).toBe(true);
    expect(calls).toHaveLength(1);
    const state = calls[0]!.context.state as { candidates: Array<{ key: string }> };
    // only the non-error, big result got nominated
    expect(state.candidates).toHaveLength(1);
    expect(state.candidates[0].key).toBe('k1');
  });

  it('frequency control: at most MAX_CANDIDATES_PER_CALL nominees per invocation', async () => {
    const { engine, calls } = makeEngine('active', { answers: {} });
    const results = Array.from({ length: 12 }, (_, i) =>
      makeToolResult('shell', bigResultText(`r${i}`)),
    );
    const messages = makeTranscript(results);
    await judgeContextForget({
      engine,
      messages,
      lastUserIndex: messages.length - 1,
      sessionKey: 'freq-cap',
    });
    expect(calls).toHaveLength(1);
    const state = calls[0]!.context.state as { candidates: unknown[] };
    expect(state.candidates).toHaveLength(MAX_CANDIDATES_PER_CALL);
  });

  it('nothing eligible → not asked, no judge call', async () => {
    const { engine, calls } = makeEngine('active', { answers: {} });
    const messages = [makeUser('hi'), makeToolResult('shell', 'small')];
    const result = await judgeContextForget({
      engine,
      messages,
      lastUserIndex: messages.length - 1,
      sessionKey: 'nothing-eligible',
    });
    expect(result).toEqual({ asked: false });
    expect(calls).toHaveLength(0);
  });

  it('judged+active marks nominees as final claims (judged keeps are never re-asked)', async () => {
    const { engine, calls } = makeEngine('active', {
      answers: { k1: { type: 'noul', probability: KEEP } },
    });
    const messages = makeTranscript([makeToolResult('shell', bigResultText('kept'))]);
    const shared = {
      engine,
      messages,
      lastUserIndex: messages.length - 1,
      sessionKey: 'final-claim',
    };
    const first = await judgeContextForget(shared);
    expect(first.entries).toBeUndefined();
    expect(calls).toHaveLength(1);
    const second = await judgeContextForget(shared);
    expect(second).toEqual({ asked: false }); // no candidates left → not even asked
    expect(calls).toHaveLength(1); // judge NOT called again
  });

  it('evicted tombstones are final claims too', async () => {
    const { engine, calls } = makeEngine('active', {
      answers: { k1: { type: 'noul', probability: EVICT } },
    });
    const messages = makeTranscript([makeToolResult('shell', bigResultText('gone'))]);
    const shared = {
      engine,
      messages,
      lastUserIndex: messages.length - 1,
      sessionKey: 'evict-final',
    };
    const first = await judgeContextForget(shared);
    expect(first.entries).toHaveLength(1);
    const second = await judgeContextForget(shared);
    expect(second).toEqual({ asked: false });
    expect(calls).toHaveLength(1);
  });

  it('fallback does NOT mark candidates — a later watermark can re-ask', async () => {
    const { engine, calls } = makeEngine('active', {
      failWith: { stopReason: 'error', errorMessage: 'judge down' },
    });
    const messages = makeTranscript([makeToolResult('shell', bigResultText('r1'))]);
    const shared = { engine, messages, lastUserIndex: messages.length - 1, sessionKey: 're-ask' };
    const first = await judgeContextForget(shared);
    expect(first.asked).toBe(true);
    expect(first.entries).toBeUndefined();
    const second = await judgeContextForget(shared);
    expect(second.asked).toBe(true); // re-nominated and re-asked
    expect(calls).toHaveLength(2);
  });

  it('shadow: asked but behavior-neutral (no entries, no tombstones)', async () => {
    const { engine, calls } = makeEngine('shadow', {
      answers: { k1: { type: 'noul', probability: EVICT } },
    });
    const messages = makeTranscript([makeToolResult('shell', bigResultText('r1'))]);
    const result = await judgeContextForget({
      engine,
      messages,
      lastUserIndex: messages.length - 1,
      sessionKey: 'shadow-neutral',
    });
    expect(result.asked).toBe(true);
    expect(result.entries).toBeUndefined();
    expect(calls).toHaveLength(1);
    // the message content is untouched
    const text = (messages[2]!.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain('r1');
  });

  it('judge failure never throws', async () => {
    const { engine } = makeEngine('active', {
      failWith: { stopReason: 'error', errorMessage: 'boom' },
    });
    const messages = makeTranscript([makeToolResult('shell', bigResultText('r1'))]);
    const result = await judgeContextForget({
      engine,
      messages,
      lastUserIndex: messages.length - 1,
      sessionKey: 'never-throws',
    });
    expect(result.asked).toBe(true);
    expect(result.entries).toBeUndefined();
  });
});

describe('context.forget constants', () => {
  it('match the impl doc §4.6 risk control', () => {
    expect(DROP_PROBABILITY).toBe(0.9);
    expect(MIN_CANDIDATE_TOKENS).toBe(400);
    expect(MAX_CANDIDATES_PER_CALL).toBe(8);
  });
});
