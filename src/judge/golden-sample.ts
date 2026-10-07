/**
 * Golden sample decision — one choice, one noul, one score question over tiny
 * `test` state. Used by `POST /api/judge/test` and by the real-judge contract
 * test (tests/judge/contract.opencode.test.ts) to probe judge health end to
 * end with predictable shapes.
 */

import { choice, noul, score, defineDecision, type DecisionSpec } from './types.js';

export const GOLDEN_POINT_ID = 'test';

export const GOLDEN_SAMPLE_STATE: Record<string, unknown> = {
  task: 'Fix the failing unit test: calculateDiscount(100) returned 0, expected 15, in the payments module (write or debug code).',
  standingRule:
    'The user set a rule worth remembering: all commit messages must be written in English.',
};

export function goldenSampleSpec(): DecisionSpec<{
  q1_domain: ReturnType<typeof choice>;
  q2_keep: ReturnType<typeof noul>;
  q3_difficulty: ReturnType<typeof score>;
}> {
  return defineDecision({
    id: GOLDEN_POINT_ID,
    version: 1,
    questions: {
      q1_domain: choice('Which domain does the described task belong to?', {
        code: 'writing or debugging code',
        web: 'web content or search',
        other: 'anything else',
      }),
      // The probe is a SHAPE check, not a subjective assessment: each question
      // is deterministically answerable from its own part of the state, so a
      // healthy judge passes with high confidence (gray-zone here would mean
      // the wire/parse path is broken, not that the task is ambiguous).
      q2_keep: noul(
        'Does the described state contain an explicit standing rule the user asked to follow?',
        {
          true: 'a rule is explicitly stated',
          false: 'no rule present',
        },
      ),
      q3_difficulty: score('On this scale, how cold is ice water?', ['cold', 'mild', 'hot']),
    },
    fallback: { action: 'none' },
  });
}
