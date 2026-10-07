/**
 * Golden sample decision — one choice, one noul, one score question over tiny
 * `test` state. Used by `POST /api/judge/test` and by the real-judge contract
 * test (tests/judge/contract.opencode.test.ts) to probe judge health end to
 * end with predictable shapes.
 */

import { choice, noul, score, defineDecision, type DecisionSpec } from './types.js';

export const GOLDEN_POINT_ID = 'test';

export const GOLDEN_SAMPLE_STATE: Record<string, unknown> = {
  task: 'golden sample of the judge kernel: question shapes probe',
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
      q2_keep: noul('Is the described state worth keeping for later?', {
        true: 'contains facts or decisions worth remembering',
        false: 'transient noise',
      }),
      q3_difficulty: score('How hard is the described task for a large model?', [
        'trivial',
        'normal',
        'hard',
      ]),
    },
    fallback: { action: 'none' },
  });
}
