/**
 * Decision point `testlog.fold` (phase-1 M1, plan §6 point 2, impl doc §4.2).
 *
 * Layer 1 — pure rules (`./admission/testlog-fold-rules.js`): byte-identical
 * repeated line blocks are folded with no judge call at all, whenever
 * `features.testLogFold` is `rules` or `jev`. `off` (default) never invokes
 * this module.
 *
 * Layer 2 — goal-aware judge pass (only `features.testLogFold: 'jev'`): after
 * rule folding, the remaining blocks get one `decideMany` noul each ("is this
 * block needed for the current task?"); a block is evicted (replaced with a
 * pointer line) only at P(needed) <= 0.1 (P(not-needed) >= 0.9); gray keeps.
 * The point's mode (`engine.modeFor('testlog.fold')`) still governs whether the
 * pass runs at all; shadow records but never evicts.
 */

import { defineDecision, noul, type DecisionOutcome, type DecisionSpec } from './types.js';

export const TESTLOG_FOLD_POINT_ID = 'testlog.fold';

/** One judged block (a line-boundary chunk of the rule-folded text). */
export interface TestLogFoldBlock {
  /** Answer key ("t1".."tN"). */
  id: string;
  firstLine: string;
  sizeChars: number;
  /** Block body (state truncates to the admission chunk cap). */
  text: string;
}

export interface TestLogFoldState {
  /** First 200 chars of the turn's user message (goal awareness). */
  taskHint: string;
  toolName?: string;
  blocks: TestLogFoldBlock[];
}

/** Re-exported pure layer (tests import the function from here OR from the rules module). */
export {
  foldTestLogBlocks,
  foldMarkerLine,
  type FoldResult,
  type FoldStats,
} from './admission/testlog-fold-rules.js';

const BLOCK_TEXT_MAX = 1500;

const QUESTION_INSTRUCTIONS =
  'does the current task still need this block of test/diagnostic output?';
const QUESTION_CRITERIA = {
  true: 'contains failures, errors or facts the current task still needs',
  false: 'repeated noise the task no longer needs',
} as const;

/** Evict only at P(not needed) >= 0.9 (conservative; gray keeps). */
export const TESTLOG_FOLD_EVICT_DROP_PROBABILITY = 0.9;

function testLogFoldPolicy(
  answers: Record<string, unknown>,
  ctx: { input: { state: unknown } },
): DecisionOutcome {
  const state = (ctx.input.state ?? {}) as Partial<TestLogFoldState>;
  const blocks = Array.isArray(state.blocks) ? state.blocks : [];
  const evicted = new Set<string>();
  for (const block of blocks) {
    const answer = answers[String((block as TestLogFoldBlock)?.id ?? '')] as
      { type?: string; probability?: number } | undefined;
    if (answer?.type === 'noul' && typeof answer.probability === 'number') {
      if (1 - answer.probability >= TESTLOG_FOLD_EVICT_DROP_PROBABILITY) {
        evicted.add(String((block as TestLogFoldBlock).id));
      }
    }
  }
  if (evicted.size === 0) return { action: 'keep-all' };
  return {
    action: 'keep',
    ids: blocks
      .map((b) => String((b as TestLogFoldBlock).id))
      .filter((id) => id.length > 0 && !evicted.has(id)),
  };
}

const TESTLOG_FOLD_FALLBACK: DecisionOutcome = { action: 'keep-all' };

/** Per-call spec: one noul per block id; identity comes from the state. */
export function createTestLogFoldSpec(blockIds: string[]): DecisionSpec {
  const questions: Record<string, DecisionSpec['questions'][string]> = {};
  for (const id of blockIds) {
    questions[id] = noul(QUESTION_INSTRUCTIONS, QUESTION_CRITERIA);
  }
  return defineDecision({
    id: TESTLOG_FOLD_POINT_ID,
    version: 1,
    questions,
    buildState: (raw: unknown): TestLogFoldState => {
      // engine.decide passes the whole DecisionInput — unwrap `state`.
      const call = raw as { state?: unknown } | undefined;
      const input = ((call && typeof call === 'object' && 'state' in call ? call.state : raw) ??
        {}) as Partial<TestLogFoldState>;
      return {
        taskHint: typeof input.taskHint === 'string' ? input.taskHint.slice(0, 200) : '',
        ...(input.toolName !== undefined ? { toolName: String(input.toolName).slice(0, 120) } : {}),
        blocks: (Array.isArray(input.blocks) ? input.blocks : []).map((b) => ({
          id: String((b as TestLogFoldBlock)?.id ?? ''),
          firstLine: String((b as TestLogFoldBlock)?.firstLine ?? '').slice(0, 120),
          sizeChars: Number((b as TestLogFoldBlock)?.sizeChars ?? 0),
          text: String((b as TestLogFoldBlock)?.text ?? '').slice(0, BLOCK_TEXT_MAX),
        })),
      };
    },
    policy: testLogFoldPolicy as DecisionSpec['policy'],
    fallback: TESTLOG_FOLD_FALLBACK,
  });
}

/** Canonical registered instance (one-block template; hooks create per-call specs). */
export const testLogFoldSpec: DecisionSpec = createTestLogFoldSpec(['t1']);

/** Marker line for a judge-evicted block (distinct from the rules-fold marker). */
export function testLogFoldPointerLine(blockId: string, toolName: string, pointer: string): string {
  return `[folded-out: block ${blockId} of ${toolName} result, full text at ${pointer}]`;
}
