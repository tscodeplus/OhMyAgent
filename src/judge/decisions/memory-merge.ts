/**
 * Decision point `memory.merge` (kernel M2, plan §6 point 7, impl doc §4.5).
 *
 * Replaces the aux chat-LLM merge call with ONE bounded choice over the
 * relation between a new experience and a similar old memory:
 *
 *   duplicate    → drop the new content (keep the old record unchanged)
 *   more-precise → the new content replaces the old record's content
 *   contradicts  → keep BOTH records and mark the conflict in metadata
 *   unrelated    → keep both (plain create)
 *
 * Hook contract (`judgeMemoryMergeRelation`): consults the judge only when
 * `mode !== 'off'`; returns `undefined` unless the verdict is judged+active —
 * `undefined` means "fall back to the existing LLM merge path" exactly as
 * before.
 */

import { choice, defineDecision, type DecisionOutcome, type DecisionSpec } from '../types.js';

export const MEMORY_MERGE_POINT_ID = 'memory.merge';

export const MERGE_DUPLICATE = 'duplicate';
export const MERGE_MORE_PRECISE = 'more-precise';
export const MERGE_CONTRADICTS = 'contradicts';
export const MERGE_UNRELATED = 'unrelated';

export type MemoryMergeRelation = 'duplicate' | 'more-precise' | 'contradicts' | 'unrelated';

export interface MemoryMergeState {
  /** The existing memory's current text (truncated). */
  existing: string;
  /** The incoming new experience text (truncated). */
  incoming: string;
}

/** Merge relation texts carried into the judge state. */
export const MEMORY_MERGE_TEXT_MAX = 400;

const MERGE_QUESTION = choice('How does the new experience relate to the existing memory?', {
  [MERGE_DUPLICATE]: 'says the same thing with no new information',
  [MERGE_MORE_PRECISE]:
    'same subject but sharper, more current, or more complete — the new wording is better',
  [MERGE_CONTRADICTS]: 'the two cannot both be true — the new one likely reflects the latest truth',
  [MERGE_UNRELATED]: 'different subjects that merely share keywords',
});

/** Answer keys are positional: w1..wN over the candidate order. */
function mergePolicy(answers: Record<string, unknown>): DecisionOutcome {
  const answer = answers['merge.relation'] as { type?: string; choice?: string } | undefined;
  if (!answer || answer.type !== 'choice' || typeof answer.choice !== 'string') {
    return { action: 'none' };
  }
  return { action: 'route', choice: answer.choice };
}

/**
 * Fallback: `{ action: 'none' }` — without a verdict the existing LLM merge
 * logic runs exactly as before.
 */
const MEMORY_MERGE_FALLBACK: DecisionOutcome = { action: 'none' };

/** Canonical single-question spec. The mapping from answer key to relation is 1:1. */
export const memoryMergeSpec: DecisionSpec = defineDecision({
  id: MEMORY_MERGE_POINT_ID,
  version: 1,
  questions: { 'merge.relation': MERGE_QUESTION },
  buildState: (raw: unknown): MemoryMergeState => {
    // engine.decide passes the whole DecisionInput — unwrap `state`.
    const call = raw as { state?: unknown } | undefined;
    const input = ((call && typeof call === 'object' && 'state' in call ? call.state : raw) ??
      {}) as Partial<MemoryMergeState>;
    return {
      existing:
        typeof input.existing === 'string' ? input.existing.slice(0, MEMORY_MERGE_TEXT_MAX) : '',
      incoming:
        typeof input.incoming === 'string' ? input.incoming.slice(0, MEMORY_MERGE_TEXT_MAX) : '',
    };
  },
  policy: mergePolicy as DecisionSpec['policy'],
  fallback: MEMORY_MERGE_FALLBACK,
});

export interface JudgeMemoryMergeResult {
  asked: boolean;
  /** Present only when judged+active: the chosen relation choice. */
  relation?: MemoryMergeRelation;
}

/**
 * Judge the merge relation between a new experience and a similar old memory.
 * STRICT no-op: engine absent or point mode 'off' → no call, no ledger line.
 * Shadow or any fallback → asks + ledger but no behavioral mapping — the
 * caller then runs the existing aux-LLM merge logic unchanged.
 */
export async function judgeMemoryMergeRelation(input: {
  engine?: import('../engine.js').JudgeEngine;
  existingContent: string;
  newContent: string;
  sessionId?: string;
}): Promise<JudgeMemoryMergeResult> {
  const engine = input.engine;
  if (!engine) return { asked: false };
  if (engine.modeFor(MEMORY_MERGE_POINT_ID) === 'off') return { asked: false };

  const verdict = await engine.decideMany(memoryMergeSpec, {
    state: {
      existing: input.existingContent,
      incoming: input.newContent,
    },
    sessionId: input.sessionId,
  });
  if (verdict.source !== 'judge' || verdict.mode !== 'active') return { asked: true };
  if (verdict.outcome.action !== 'route') return { asked: true };
  const relation = verdict.outcome.choice as MemoryMergeRelation;
  return {
    asked: true,
    relation: [MERGE_DUPLICATE, MERGE_MORE_PRECISE, MERGE_CONTRADICTS, MERGE_UNRELATED].includes(
      relation,
    )
      ? relation
      : undefined,
  };
}
