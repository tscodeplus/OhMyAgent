import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from 'pino';

const auxLLMCall = vi.fn();
vi.mock('../../src/memory/aux-llm-client.js', () => ({
  auxLLMCall: (...args: unknown[]) => auxLLMCall(...args),
}));

import { generateAnswer, judgeAnswer } from '../../src/memory/eval/answer-judge.js';
import type { JudgeConfig } from '../../src/memory/eval/answer-judge.js';

const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;

function cfg(overrides: Partial<JudgeConfig> = {}): JudgeConfig {
  return {
    auxConfig: { modelRef: 'test-model' },
    maxContexts: 10,
    maxContextChars: 600,
    logger,
    ...overrides,
  };
}

beforeEach(() => auxLLMCall.mockReset());

describe('generateAnswer — gold leakage guard', () => {
  it('NEVER passes the gold answer into the generation prompt', async () => {
    auxLLMCall.mockResolvedValue('Jon enjoys hiking.');
    const GOLD = 'SECRET_GOLD_TOKEN_42';
    // judgeAnswer is the only entry that knows the gold; ensure generation call is clean.
    await judgeAnswer('What does Jon enjoy?', ['Jon said: I love hiking.'], GOLD, cfg());

    // First auxLLMCall is the generator; its prompts must not contain the gold.
    const genCall = auxLLMCall.mock.calls[0][1];
    expect(genCall.systemPrompt).not.toContain(GOLD);
    expect(genCall.userPrompt).not.toContain(GOLD);
  });

  it('returns empty string when no model is configured', async () => {
    const out = await generateAnswer('q', ['ctx'], cfg({ auxConfig: {} }));
    expect(out).toBe('');
    expect(auxLLMCall).not.toHaveBeenCalled();
  });

  it('returns empty string when there is no context', async () => {
    const out = await generateAnswer('q', [], cfg());
    expect(out).toBe('');
    expect(auxLLMCall).not.toHaveBeenCalled();
  });

  it('numbers and truncates context snippets', async () => {
    auxLLMCall.mockResolvedValue('answer');
    await generateAnswer('q', ['aaaa', 'bbbb'], cfg({ maxContextChars: 2 }));
    const prompt = auxLLMCall.mock.calls[0][1].userPrompt as string;
    expect(prompt).toContain('[1] aa');
    expect(prompt).toContain('[2] bb');
  });
});

describe('judgeAnswer — LLM path', () => {
  it('returns the LLM verdict when grading succeeds', async () => {
    auxLLMCall
      .mockResolvedValueOnce('Jon enjoys hiking.')                       // generate
      .mockResolvedValueOnce('{"verdict":"correct","reason":"same"}');   // judge
    const r = await judgeAnswer('What does Jon enjoy?', ['Jon said: I love hiking.'], 'hiking', cfg());
    expect(r.verdict).toBe('correct');
    expect(r.llmJudged).toBe(true);
    expect(r.generatedAnswer).toBe('Jon enjoys hiking.');
  });

  it('skips when generation yields nothing', async () => {
    const r = await judgeAnswer('q', ['ctx'], 'gold', cfg({ auxConfig: {} }));
    expect(r.verdict).toBe('skipped');
    expect(r.llmJudged).toBe(false);
  });
});

describe('judgeAnswer — lexical fallback', () => {
  it('grades by lexical overlap when judge output is unparseable', async () => {
    auxLLMCall
      .mockResolvedValueOnce('Jon enjoys hiking and climbing')  // generate
      .mockResolvedValueOnce('not json at all');                // judge (bad)
    const r = await judgeAnswer('q', ['ctx'], 'hiking climbing', cfg());
    expect(r.llmJudged).toBe(false);
    expect(r.verdict).toBe('correct'); // full token overlap
  });

  it('marks incorrect when the generated answer is INSUFFICIENT', async () => {
    auxLLMCall
      .mockResolvedValueOnce('INSUFFICIENT')
      .mockRejectedValueOnce(new Error('judge unreachable'));
    const r = await judgeAnswer('q', ['ctx'], 'hiking', cfg());
    expect(r.verdict).toBe('incorrect');
    expect(r.llmJudged).toBe(false);
  });

  it('marks partial on moderate overlap', async () => {
    auxLLMCall
      .mockResolvedValueOnce('hiking trips somewhere far away off the grid alone')
      .mockResolvedValueOnce('garbage');
    const r = await judgeAnswer('q', ['ctx'], 'hiking biking swimming running climbing', cfg());
    expect(['partial', 'incorrect']).toContain(r.verdict);
  });
});
