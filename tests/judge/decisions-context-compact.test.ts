/**
 * context.compact decision spec + hook (kernel M2, impl doc §4.6).
 *
 * Deterministic mock judge (./mock.ts): segmentation (never straddles message
 * boundaries, joined digests cover every message), the 0.85 drop threshold
 * with gray keeps, verdict interplay (judged keep → pruned array; judged
 * keep-all / shadow / fallback → no prune, existing LLM path), the 24K state
 * cap split into sequential decideMany batches where ONE bail-out batch
 * cancels the whole prune, and the strict no-op invariant (judge absent OR
 * point off OR tiny transcript → not asked).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import {
  COMPACT_DROP_PROBABILITY,
  createContextCompactSpec,
  segmentCompressibleMessages,
} from '../../src/judge/decisions/context-compact.js';
import { judgeContextCompactPrune } from '../../src/judge/hooks/context-compact.js';
import { JudgeEngine } from '../../src/judge/index.js';
import { JudgeLedger } from '../../src/judge/ledger.js';
import { createMockResolver, createMockTier, mockJudgeConfig, type MockTierSpec } from './mock.js';

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'judge-context-compact-'));
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

function makeUser(text: string): AgentMessage {
  return { role: 'user', content: text, timestamp: Date.now() } as AgentMessage;
}

/**
 * N long messages. The digest helper caps each message at ~408 chars
 * (`[user] ` + 400-char truncate + ellipsis), so five messages fill one
 * ~1800-char segment: segments are [0,5), [5,10), … and every digest is
 * truncated uniformly (pad ≥ 400 ⇒ identical digest sizes, deterministic
 * segment boundaries regardless of the index width).
 */
function makeOldMessages(count: number, digestPad = 950): AgentMessage[] {
  return Array.from({ length: count }, (_, i) =>
    makeUser(`history chunk ${i} ${'x'.repeat(digestPad)}`),
  );
}
const MESSAGES_PER_SEGMENT = 5;

// keep-probabilities: a segment is dropped only at P(drop) = 1 - probability >= 0.85
const KEEP = 0.95;
const GRAY = 0.2; // decided "not needed" at 80% — kept (conservative)
const DROP = 0.05; // P(drop) = 0.95

describe('segmentCompressibleMessages', () => {
  it('segments never straddle message boundaries and keys ascend', () => {
    const oldMessages = makeOldMessages(10); // five ~408-char digests → one ~1800-char segment
    const segments = segmentCompressibleMessages(oldMessages);
    expect(segments.map((s) => s.key)).toEqual(['g1', 'g2']);
    expect(segments[0]).toMatchObject({ start: 0, end: 5 });
    expect(segments[1]).toMatchObject({ start: 5, end: 10 });
  });

  it('every message appears in exactly one segment (rounds up to one final segment)', () => {
    const oldMessages = makeOldMessages(3, 100); // small digests → single segment
    const segments = segmentCompressibleMessages(oldMessages);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ start: 0, end: 3 });
    expect(segments[0]!.text).toContain('history chunk 0');
    expect(segments[0]!.text).toContain('history chunk 2');
  });

  it('empty input → no segments', () => {
    expect(segmentCompressibleMessages([])).toEqual([]);
  });
});

describe('context.compact spec policy', () => {
  it('drops only P(drop) >= 0.85, keeps gray segments; kept ids listed', async () => {
    const { engine, calls } = makeEngine('active', {
      answers: {
        g1: { type: 'noul', probability: DROP },
        g2: { type: 'noul', probability: KEEP },
        g3: { type: 'noul', probability: GRAY },
      },
    });
    const verdict = await engine.decideMany(
      createContextCompactSpec([{ key: 'g1' }, { key: 'g2' }, { key: 'g3' }]),
      {
        state: {
          taskHint: 'continue the migration',
          segments: [
            { key: 'g1', text: 'a'.repeat(300) },
            { key: 'g2', text: 'b'.repeat(300) },
            { key: 'g3', text: 'c'.repeat(300) },
          ],
        },
        sessionId: 's1',
      },
    );
    expect(verdict.source).toBe('judge');
    expect(verdict.mode).toBe('active');
    expect(verdict.outcome).toEqual({ action: 'keep', ids: ['g2', 'g3'] });
    const state = calls[0]!.context.state as { taskHint: string; segments: unknown[] };
    expect(state.taskHint).toBe('continue the migration');
    expect(state.segments).toHaveLength(3);
  });

  it('shadow asks (ledger line) but outcome is the keep-all fallback', async () => {
    const { engine } = makeEngine('shadow');
    const verdict = await engine.decideMany(createContextCompactSpec([{ key: 'g1' }]), {
      state: { segments: [{ key: 'g1', text: 'a' }] },
      sessionId: 's1',
    });
    expect(verdict.mode).toBe('shadow');
    expect(verdict.outcome).toEqual({ action: 'keep-all' });
    expect(engine.ledger.recent(1).length).toBe(1);
  });
});

describe('judgeContextCompactPrune hook', () => {
  it('no engine → not asked (strict no-op)', async () => {
    const result = await judgeContextCompactPrune({
      oldMessages: makeOldMessages(4),
      messageCount: 10,
      sessionId: 'no-engine',
    });
    expect(result).toEqual({ asked: false });
  });

  it('mode off → not asked', async () => {
    const { engine, calls } = makeEngine('off');
    const result = await judgeContextCompactPrune({
      engine,
      oldMessages: makeOldMessages(4),
      messageCount: 10,
      sessionId: 'mode-off',
    });
    expect(result).toEqual({ asked: false });
    expect(calls).toHaveLength(0);
  });

  it('tiny transcript (messageCount < 4) → not asked', async () => {
    const { engine, calls } = makeEngine('active', { answers: {} });
    const result = await judgeContextCompactPrune({
      engine,
      oldMessages: makeOldMessages(4),
      messageCount: 3,
      sessionId: 'tiny',
    });
    expect(result).toEqual({ asked: false });
    expect(calls).toHaveLength(0);
  });

  it('judged drop: keptMessages preserves the SURVIVING messages in order, by identity', async () => {
    const { engine, calls } = makeEngine('active', {
      answers: {
        g1: { type: 'noul', probability: DROP },
        g2: { type: 'noul', probability: KEEP },
      },
    });
    const oldMessages = makeOldMessages(10); // g1 = [0,5), g2 = [5,10)
    const result = await judgeContextCompactPrune({
      engine,
      oldMessages,
      messageCount: 12,
      sessionId: 'judged-drop',
      taskHint: 'finish the migration',
    });
    expect(result.asked).toBe(true);
    expect(result.keptMessages).toEqual(oldMessages.slice(MESSAGES_PER_SEGMENT));
    expect(result.keptMessages![0]).toBe(oldMessages[MESSAGES_PER_SEGMENT]); // identity preserved
    // ONE batched decideMany (state under the cap), taskHint included
    expect(calls).toHaveLength(1);
    const state = calls[0]!.context.state as { taskHint: string; segments: unknown[] };
    expect(state.taskHint).toBe('finish the migration');
    expect(state.segments).toHaveLength(2);
  });

  it('judged keep-all → asked, nothing pruned', async () => {
    const { engine, calls } = makeEngine('active', {
      answers: {
        g1: { type: 'noul', probability: KEEP },
        g2: { type: 'noul', probability: KEEP },
      },
    });
    const result = await judgeContextCompactPrune({
      engine,
      oldMessages: makeOldMessages(10),
      messageCount: 12,
      sessionId: 'keep-all',
    });
    expect(result).toEqual({ asked: true });
    expect(calls).toHaveLength(1);
  });

  it('shadow → asked but behavior-neutral (no keptMessages)', async () => {
    const { engine, calls } = makeEngine('shadow', {
      answers: { g1: { type: 'noul', probability: DROP }, g2: { type: 'noul', probability: DROP } },
    });
    const result = await judgeContextCompactPrune({
      engine,
      oldMessages: makeOldMessages(10),
      messageCount: 12,
      sessionId: 'shadow-neutral',
    });
    expect(result).toEqual({ asked: true });
    expect(calls).toHaveLength(1);
  });

  it('fallback (judge down) → asked but no prune', async () => {
    const { engine } = makeEngine('active', {
      failWith: { stopReason: 'error', errorMessage: 'judge down' },
    });
    const result = await judgeContextCompactPrune({
      engine,
      oldMessages: makeOldMessages(10),
      messageCount: 12,
      sessionId: 'judge-down',
    });
    expect(result).toEqual({ asked: true });
  });

  it('state cap: sequential decideMany batches; ONE bail-out batch cancels the prune', async () => {
    // 85 long messages → 17 segments; 16 × 1500 state-chars fills the 24K
    // cap, the 17th segment opens batch #2.
    const { engine, calls } = makeEngine('active', {
      answers: {
        // every judged batch drops its segments… except the last one keeps
        ...Object.fromEntries(
          Array.from({ length: 17 }, (_, i) => [
            `g${i + 1}`,
            { type: 'noul', probability: i === 16 ? KEEP : DROP } as const,
          ]),
        ),
      },
    });
    const oldMessages = makeOldMessages(17 * MESSAGES_PER_SEGMENT);
    const result = await judgeContextCompactPrune({
      engine,
      oldMessages,
      messageCount: 17 * MESSAGES_PER_SEGMENT + 5,
      sessionId: 'batched',
    });
    // both batches judged: g1..g16 dropped, g17 kept
    expect(result.keptMessages).toEqual(oldMessages.slice(16 * MESSAGES_PER_SEGMENT));
    expect(calls.length).toBe(2);
    const firstState = calls[0]!.context.state as { segments: Array<{ key: string }> };
    const secondState = calls[1]!.context.state as { segments: Array<{ key: string }> };
    expect(firstState.segments).toHaveLength(16);
    expect(secondState.segments.map((s) => s.key)).toEqual(['g17']);
  });

  it('one gray batch in a multi-batch run → NO partial prune (bail out to the LLM path)', async () => {
    const { engine, calls } = makeEngine('active', {
      answers: Object.fromEntries(
        Array.from({ length: 17 }, (_, i) =>
          // the last batch gets NO answer → parse-rejected → fallback
          i === 16 ? [] : [`g${i + 1}`, { type: 'noul', probability: DROP } as const],
        ),
      ),
    });
    const result = await judgeContextCompactPrune({
      engine,
      oldMessages: makeOldMessages(17 * MESSAGES_PER_SEGMENT),
      messageCount: 17 * MESSAGES_PER_SEGMENT + 5,
      sessionId: 'batch-bail',
    });
    expect(result).toEqual({ asked: true }); // no keptMessages — existing LLM path
    expect(calls.length).toBe(2);
  });
});

describe('context.compact constants', () => {
  it('match the impl doc §4.6 drop threshold', () => {
    expect(COMPACT_DROP_PROBABILITY).toBe(0.85);
  });
});
