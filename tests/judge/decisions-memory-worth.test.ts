/**
 * `memory.worth` — spec buildState/policy fixtures: only `useful-again`
 * persists; fallback keep-all; shadow writes nothing.
 */

import { describe, expect, it } from 'vitest';
import {
  MEMORY_WORTH_POINT_ID,
  WORTH_ALREADY_KNOWN,
  WORTH_ONE_OFF,
  WORTH_USEFUL_AGAIN,
  createMemoryWorthSpec,
  memoryWorthKeys,
  memoryWorthSpec,
} from '../../src/judge/decisions/memory-worth.js';
import { DECISION_SPECS } from '../../src/judge/decisions/registry.js';
import type { JudgeAnswer } from '../../src/judge/types.js';

const CANDIDATE_A = { id: 'u1', key: 'w1', text: '以后 commit 用英文' };

function answersFor(first: string, second?: string): Record<string, JudgeAnswer> {
  const answers: Record<string, JudgeAnswer> = {
    w1: {
      type: 'choice',
      choice: first,
      probabilities: { [first]: 0.9 },
      confidence: 0.9,
    },
  };
  if (second) {
    answers['w2'] = {
      type: 'choice',
      choice: second,
      probabilities: { [second]: 0.8 },
      confidence: 0.8,
    };
  }
  return answers;
}

describe('memory.worth spec', () => {
  it('is registered with the canonical one-candidate template', () => {
    expect(DECISION_SPECS['memory.worth']).toBe(memoryWorthSpec);
    expect(MEMORY_WORTH_POINT_ID).toBe('memory.worth');
    expect(Object.keys(memoryWorthSpec.questions)).toEqual(['w1']);
  });

  it('keys are positional w1..wN', () => {
    expect(memoryWorthKeys(3)).toEqual(['w1', 'w2', 'w3']);
  });

  it('buildState truncates candidate texts and normalizes fields', () => {
    const spec = createMemoryWorthSpec([{ id: 'u1', key: 'w1' }]);
    const built = spec.buildState?.({
      state: {
        scenario: 'z'.repeat(500),
        candidates: [
          { id: 'u1', key: 'w1', text: 'a'.repeat(500) },
          { id: undefined, key: undefined }, // garbage tolerated
        ],
      },
    }) as { scenario: string; candidates: Array<{ id: string; key: string; text: string }> };
    expect(built.scenario).toHaveLength(200);
    expect(built.candidates[0]!.text).toHaveLength(400);
    expect(built.candidates[1]!.id).toBe('');
  });

  it('policy persists only useful-again candidates', () => {
    const spec = createMemoryWorthSpec([CANDIDATE_A, { id: 'u2', key: 'w2', text: 'x' }]);
    const outcome = spec.policy!(answersFor(WORTH_USEFUL_AGAIN, WORTH_ALREADY_KNOWN), {
      mode: 'active',
      input: { state: { candidates: [CANDIDATE_A, { id: 'u2', key: 'w2', text: 'x' }] } },
    });
    expect(outcome).toEqual({ action: 'keep', ids: ['u1'] });

    const noneOutcome = spec.policy!(answersFor(WORTH_ONE_OFF, WORTH_ONE_OFF), {
      mode: 'active',
      input: { state: { candidates: [CANDIDATE_A, { id: 'u2', key: 'w2', text: 'x' }] } },
    });
    expect(noneOutcome).toEqual({ action: 'none' });
  });

  it('fallback = keep-all (current pre-judge behavior)', () => {
    expect(memoryWorthSpec.fallback).toEqual({ action: 'keep-all' });
  });
});
