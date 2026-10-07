/**
 * Protocol mapping tests (impl doc §2 "线上协议映射 "):
 * builders → pi-mono ClassifierQuestion, including noul-without-criteria
 * sending NO criteria key, and the fail-closed answer validation.
 */

import { describe, expect, it } from 'vitest';
import {
  isGrayAnswer,
  toClassifierQuestion,
  toClassifierQuestions,
  toJudgeAnswer,
  validateAnswers,
} from '../../src/judge/protocol-map.js';
import type { ClassifierAnswer } from '../../src/pi-mono/ai/types.js';
import { choice, noul, score } from '../../src/judge/types.js';

describe('question builders → ClassifierQuestion', () => {
  it('noul with criteria → bool with criteria', () => {
    const q = toClassifierQuestion(noul('Keep it?', { true: 'useful', false: 'noise' }));
    expect(q).toEqual({
      type: 'bool',
      instructions: 'Keep it?',
      criteria: { true: 'useful', false: 'noise' },
    });
  });

  it('noul WITHOUT criteria sends NO criteria key (never an empty object)', () => {
    const q = toClassifierQuestion(noul('Is it fine?')) as Record<string, unknown>;
    expect(q.type).toBe('bool');
    expect(Object.hasOwn(q as object, 'criteria')).toBe(false);
  });

  it('choice: null criteria descriptions map to empty strings', () => {
    const q = toClassifierQuestion(choice('Which?', { code: 'code things', web: null })) as Record<
      string,
      unknown
    >;
    expect(q.type).toBe('choice');
    expect(q.criteria).toEqual({ code: 'code things', web: '' });
  });

  it('score: criteria array passes through', () => {
    expect(toClassifierQuestion(score('How hard?', ['trivial', 'normal', 'hard']))).toEqual({
      type: 'score',
      instructions: 'How hard?',
      criteria: ['trivial', 'normal', 'hard'],
    });
  });

  it('toClassifierQuestions maps a whole question set', () => {
    const out = toClassifierQuestions({
      a: noul('a?'),
      b: choice('b?', { x: 'x', y: 'y' }),
      c: score('c?', ['l', 'm', 'h']),
    });
    expect(Object.keys(out)).toEqual(['a', 'b', 'c']);
    expect(out.a.type).toBe('bool');
    expect(out.b.type).toBe('choice');
    expect(out.c.type).toBe('score');
  });
});

describe('toJudgeAnswer — fail-closed', () => {
  const keepQ = noul('Keep it?', { true: 'useful', false: 'noise' });
  const domainQ = choice('Which?', { code: 'code', web: 'web', other: 'escape' });
  const hardQ = score('How hard?', ['trivial', 'normal', 'hard']);

  it('bool → noul', () => {
    expect(toJudgeAnswer(keepQ, { type: 'bool', probability: 0.9 })).toEqual({
      type: 'noul',
      probability: 0.9,
    });
  });

  it('choice inside criteria maps and keeps probabilities', () => {
    const answer: ClassifierAnswer = {
      type: 'choice',
      choice: 'code',
      probabilities: { code: 0.8, web: 0.2 },
      confidence: 0.8,
    };
    expect(toJudgeAnswer(domainQ, answer)).toEqual(answer);
  });

  it('choice key OUTSIDE criteria is undefined (discarded)', () => {
    const answer: ClassifierAnswer = {
      type: 'choice',
      choice: 'injected-key',
      probabilities: { 'injected-key': 1 },
      confidence: 0.9,
    };
    expect(toJudgeAnswer(domainQ, answer)).toBeUndefined();
  });

  it('score with numeric score+confidence maps', () => {
    expect(toJudgeAnswer(hardQ, { type: 'score', score: 1.5, confidence: 0.7 })).toEqual({
      type: 'score',
      score: 1.5,
      confidence: 0.7,
    });
  });

  it('wrong types / missing fields / NaN → undefined', () => {
    expect(
      toJudgeAnswer(keepQ, { type: 'choice', choice: 'code', probabilities: {}, confidence: 1 }),
    ).toBeUndefined();
    expect(toJudgeAnswer(domainQ, { type: 'bool', probability: 1 })).toBeUndefined();
    expect(
      toJudgeAnswer(hardQ, { type: 'score', score: Number.NaN, confidence: 1 }),
    ).toBeUndefined();
    expect(toJudgeAnswer(hardQ, undefined)).toBeUndefined();
  });
});

describe('gray-zone rules', () => {
  it('noul: probability strictly inside (0.25, 0.75) is gray; boundaries are not', () => {
    const q = noul('q?');
    expect(isGrayAnswer(q, { type: 'noul', probability: 0.5 })).toBe(true);
    expect(isGrayAnswer(q, { type: 'noul', probability: 0.26 })).toBe(true);
    expect(isGrayAnswer(q, { type: 'noul', probability: 0.25 })).toBe(false);
    expect(isGrayAnswer(q, { type: 'noul', probability: 0.75 })).toBe(false);
  });

  it('choice: confidence < 0.5 is gray', () => {
    const q = choice('q?', { a: 'a', b: 'b' });
    expect(
      isGrayAnswer(q, { type: 'choice', choice: 'a', probabilities: { a: 1 }, confidence: 0.49 }),
    ).toBe(true);
    expect(
      isGrayAnswer(q, { type: 'choice', choice: 'a', probabilities: { a: 1 }, confidence: 0.5 }),
    ).toBe(false);
  });

  it('score: gray unless confidence >= 0.5', () => {
    const q = score('q?', ['l', 'h']);
    expect(isGrayAnswer(q, { type: 'score', score: 1, confidence: 0.3 })).toBe(true);
    expect(isGrayAnswer(q, { type: 'score', score: 1, confidence: 0.5 })).toBe(false);
  });
});

describe('validateAnswers', () => {
  it('discards invalid, keeps valid, reports anyGray', () => {
    const questions = {
      keep: noul('keep?'),
      domain: choice('which?', { a: 'a', b: 'b' }),
    };
    const result = validateAnswers(questions, {
      keep: { type: 'bool', probability: 0.5 },
      domain: { type: 'choice', choice: 'junk', probabilities: {}, confidence: 1 },
    });
    expect(Object.keys(result.valid)).toEqual(['keep']);
    expect(result.anyGray).toBe(true);
  });

  it('all valid and clear → anyGray false', () => {
    const result = validateAnswers(
      { keep: noul('k?') },
      { keep: { type: 'bool', probability: 0.99 } },
    );
    expect(result.valid).toEqual({ keep: { type: 'noul', probability: 0.99 } });
    expect(result.anyGray).toBe(false);
  });
});
