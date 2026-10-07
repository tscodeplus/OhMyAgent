/**
 * `memory.merge` — spec + judgedMergeOutcome mapping (impl doc §4.5):
 * duplicate → drop new, more-precise → replace old, contradicts → both kept,
 * unrelated → both kept; fallback keeps the LLM merge path untouched.
 */

import { describe, expect, it, vi } from 'vitest';

// aux-llm-client is mocked so the LLM-merge fallback path can be stubbed
// without network/config wiring (the judged path must REPLACE the call).
vi.mock('../../src/memory/aux-llm-client.js', () => ({
  auxLLMCall: vi.fn(),
}));

import { auxLLMCall } from '../../src/memory/aux-llm-client.js';
import type { Memory } from '../../src/memory/repositories/memory-repository.js';
import type { MergeConfig } from '../../src/memory/memory-merge.js';
import type { Logger } from 'pino';
import {
  MEMORY_MERGE_POINT_ID,
  MERGE_CONTRADICTS,
  MERGE_DUPLICATE,
  MERGE_MORE_PRECISE,
  MERGE_UNRELATED,
  judgeMemoryMergeRelation,
  memoryMergeSpec,
} from '../../src/judge/decisions/memory-merge.js';
import { DECISION_SPECS } from '../../src/judge/decisions/registry.js';
import {
  appendMemoryDispute,
  judgedMergeOutcome,
  mergeMemory,
} from '../../src/memory/memory-merge.js';
import { makeEngine } from './decisions-helpers.js';

const EXISTING = '用户偏好 pnpm，提交信息用英文。';
const NEW = '用户偏好用 pnpm；提交信息必须用英文。';

const mergeConfigBase: Omit<MergeConfig, 'auxConfig' | 'judgeGet'> = {
  mergeThreshold: 0.85,
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() } as unknown as Logger,
};

const existingMemory = { id: 'old1', content: EXISTING, metadata: null } as unknown as Memory;

describe('memory.merge spec', () => {
  it('is registered; the question is an atomic choice over 4 relations', () => {
    expect(DECISION_SPECS['memory.merge']).toBe(memoryMergeSpec);
    expect(MEMORY_MERGE_POINT_ID).toBe('memory.merge');
    const question = memoryMergeSpec.questions['merge.relation'];
    expect(question?.type).toBe('choice');
    if (question?.type === 'choice') {
      expect(Object.keys(question.criteria).sort()).toEqual(
        ['contradicts', 'duplicate', 'more-precise', 'unrelated'].sort(),
      );
    }
  });

  it('routes winner choice; fallback = none (LLM merge path unchanged)', () => {
    const outcome = memoryMergeSpec.policy!(
      {
        'merge.relation': {
          type: 'choice',
          choice: MERGE_MORE_PRECISE,
          probabilities: { [MERGE_MORE_PRECISE]: 0.7 },
          confidence: 0.7,
        },
      },
      { mode: 'active', input: { state: { existing: EXISTING, incoming: NEW } } },
    );
    expect(outcome).toEqual({ action: 'route', choice: MERGE_MORE_PRECISE });
    expect(memoryMergeSpec.fallback).toEqual({ action: 'none' });
  });

  it('buildState truncates both texts', () => {
    const built = memoryMergeSpec.buildState?.({
      state: { existing: 'e'.repeat(500), incoming: 'i'.repeat(500) },
    }) as { existing: string; incoming: string };
    expect(built.existing.length).toBe(400);
    expect(built.incoming.length).toBe(400);
  });

  it('judgedMergeOutcome maps all four relations', () => {
    const duplicate = judgedMergeOutcome(EXISTING, NEW, MERGE_DUPLICATE);
    if (duplicate && 'mergedContent' in duplicate) {
      expect(duplicate.mergedContent).toBe(EXISTING);
      expect(duplicate.judgedRelation).toBe(MERGE_DUPLICATE);
    } else throw new Error('expected merged outcome');

    const precise = judgedMergeOutcome(EXISTING, NEW, MERGE_MORE_PRECISE);
    if (precise && 'mergedContent' in precise) {
      expect(precise.mergedContent).toBe(NEW.trim());
    } else throw new Error('expected merged outcome');

    expect(judgedMergeOutcome(EXISTING, NEW, MERGE_CONTRADICTS)).toEqual({
      judgedRelation: 'contradicts',
      timelineEntry: expect.objectContaining({ previousContent: EXISTING }),
    });
    expect(judgedMergeOutcome(EXISTING, NEW, MERGE_UNRELATED)).toEqual({
      judgedRelation: 'unrelated',
    });
  });

  it('appends the dispute marker without schema migration', async () => {
    const { appendMemoryDispute } = await import('../../src/memory/memory-merge.js');
    expect(JSON.parse(appendMemoryDispute(null))).toEqual({ judge_dispute: true });
    expect(JSON.parse(appendMemoryDispute('{"a":1}'))).toEqual({ a: 1, judge_dispute: true });
  });
});

describe('mergeMemory judge hook (with mock judge)', () => {
  it('judged duplicate replaces the LLM merge call entirely', async () => {
    const { engine, calls } = makeEngine('active', {
      answers: {
        'merge.relation': {
          type: 'choice',
          choice: MERGE_DUPLICATE,
          probabilities: { [MERGE_DUPLICATE]: 0.95 },
          confidence: 0.95,
        },
      },
    });
    const config = { ...mergeConfigBase, judgeGet: () => engine } as never;
    const existing = { id: 'old1', content: EXISTING, metadata: null } as never;
    const result = await mergeMemory(existing, NEW, 0.9, config);
    expect(result && 'mergedContent' in result && result.judgedRelation).toBe(MERGE_DUPLICATE);
    expect(calls.length).toBe(1); // ONE judge call, no aux chat-LLM
    expect(calls[0]!.context.state).toEqual(expect.objectContaining({ incoming: NEW }));
  });

  it('judged contradicts / unrelated return keep-both markers', async () => {
    for (const relation of [MERGE_CONTRADICTS, MERGE_UNRELATED]) {
      const { engine } = makeEngine('active', {
        answers: {
          'merge.relation': {
            type: 'choice',
            choice: relation,
            probabilities: { [relation]: 0.9 },
            confidence: 0.9,
          },
        },
      });
      const config = { ...mergeConfigBase, judgeGet: () => engine } as never;
      const result = await mergeMemory(
        { id: 'old1', content: EXISTING, metadata: null } as never,
        NEW,
        0.9,
        config,
      );
      if (relation === MERGE_CONTRADICTS) {
        expect(result && 'judgedRelation' in result && result.judgedRelation).toBe('contradicts');
      } else {
        expect(result && 'judgedRelation' in result && result.judgedRelation).toBe('unrelated');
      }
    }
  });

  it('shadow keeps the LLM merge path (judge asked, no mapping)', async () => {
    const { engine, calls } = makeEngine('shadow', {
      answers: {
        'merge.relation': {
          type: 'choice',
          choice: MERGE_DUPLICATE,
          probabilities: { [MERGE_DUPLICATE]: 0.99 },
          confidence: 0.99,
        },
      },
    });
    vi.mocked(auxLLMCall).mockResolvedValueOnce('{"mergedContent":"merged text"}');
    const config = {
      ...mergeConfigBase,
      auxConfig: { modelRef: 'a/b' },
      judgeGet: () => engine,
    } as never;
    const result = await mergeMemory(
      { id: 'old1', content: EXISTING, metadata: null } as never,
      NEW,
      0.9,
      config,
    );
    expect(result && 'mergedContent' in result && result.mergedContent).toBe('merged text');
    expect(calls[0]?.context).toBeDefined(); // judged question WAS asked (ledger)
  });

  it('judge failure falls back to the LLM merge path', async () => {
    const { engine } = makeEngine('active', {
      failWith: { stopReason: 'error', errorMessage: 'boom' },
    });
    vi.mocked(auxLLMCall).mockResolvedValueOnce('{"mergedContent":"merged text"}');
    const config = {
      ...mergeConfigBase,
      auxConfig: { modelRef: 'a/b' },
      judgeGet: () => engine,
    } as never;
    const result = await mergeMemory(
      { id: 'old1', content: EXISTING, metadata: null } as never,
      NEW,
      0.9,
      config,
    );
    expect(result && 'mergedContent' in result && result.mergedContent).toBe('merged text');
  });

  it('judgeMemoryMergeRelation no-ops when the engine is absent', async () => {
    const res = await judgeMemoryMergeRelation({
      existingContent: EXISTING,
      newContent: NEW,
    });
    expect(res).toEqual({ asked: false });
  });
});

describe('appendMemoryDispute (dream-cycle / memory-writer contradiction path)', () => {
  it('adds judge_dispute to parsed metadata, preserving existing fields', () => {
    const out = JSON.parse(appendMemoryDispute('{"scene":"work","source":"chat"}'));
    expect(out.judge_dispute).toBe(true);
    expect(out.scene).toBe('work');
    expect(out.source).toBe('chat');
  });

  it('handles null and corrupt JSON by starting from an empty object', () => {
    expect(JSON.parse(appendMemoryDispute(null)).judge_dispute).toBe(true);
    const corrupt = JSON.parse(appendMemoryDispute('{not json'));
    expect(corrupt.judge_dispute).toBe(true);
    expect(Object.keys(corrupt)).toEqual(['judge_dispute']);
  });
});
