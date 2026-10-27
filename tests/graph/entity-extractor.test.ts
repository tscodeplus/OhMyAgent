import { describe, it, expect, vi } from 'vitest';
import {
  TRIPLET_EXTRACTION_PROMPT,
  TRIPLET_RELATIONS,
  extractTriplets,
  parseTriplets,
} from '../../src/graph/entity-extractor';
import { createLogger } from '../../src/app/logger';

// The aux-LLM client is the project-wide completion path; stand it in for the
// extraction tests so no network is involved. `auxState.response === ''` makes
// the call reject, exercising the never-throws path.
const auxState = vi.hoisted(() => ({ response: '', calls: 0 }));

vi.mock('../../src/memory/aux-llm-client', () => ({
  auxLLMCall: async (): Promise<string> => {
    auxState.calls++;
    if (auxState.response === '') throw new Error('model unavailable');
    return auxState.response;
  },
}));

describe('parseTriplets', () => {
  it('parses a plain JSON array', () => {
    const triplets = parseTriplets(
      '[{"subject":"Alice","relation":"likes","object":"tea","confidence":0.9}]',
    );
    expect(triplets).toEqual([
      { subject: 'Alice', relation: 'likes', object: 'tea', confidence: 0.9 },
    ]);
  });

  it('unwraps ```json fences and surrounding prose', () => {
    const raw = [
      'Here are the facts:',
      '```json',
      '[{"subject":"Alice","relation":"works_on","object":"OhMyAgent","confidence":0.8}]',
      '```',
      'Those are all.',
    ].join('\n');

    expect(parseTriplets(raw)).toEqual([
      { subject: 'Alice', relation: 'works_on', object: 'OhMyAgent', confidence: 0.8 },
    ]);
  });

  it('accepts a top-level object with a triplets array', () => {
    const triplets = parseTriplets(
      '{"triplets":[{"subject":"Alice","relation":"lives_in","object":"Shanghai","confidence":1}]}',
    );
    expect(triplets).toHaveLength(1);
    expect(triplets[0].object).toBe('Shanghai');
  });

  it('accepts a single bare triplet object', () => {
    expect(parseTriplets('{"subject":"Bob","relation":"knows","object":"Alice"}')).toEqual([
      { subject: 'Bob', relation: 'knows', object: 'Alice', confidence: 1 },
    ]);
  });

  it('treats "predicate" as the relation key', () => {
    expect(
      parseTriplets('[{"subject":"Bob","predicate":"owns","object":"laptop"}]')[0].relation,
    ).toBe('owns');
  });

  it('clamps confidence into 0..1 and defaults to 1 when absent or unusable', () => {
    const triplets = parseTriplets(
      JSON.stringify([
        { subject: 'a', relation: 'likes', object: 'b', confidence: 4.2 },
        { subject: 'c', relation: 'likes', object: 'd', confidence: -1 },
        { subject: 'e', relation: 'likes', object: 'f', confidence: '0.25' },
        { subject: 'g', relation: 'likes', object: 'h' },
        { subject: 'i', relation: 'likes', object: 'j', confidence: 'n/a' },
      ]),
    );

    expect(triplets.map((triplet) => triplet.confidence)).toEqual([1, 0, 0.25, 1, 1]);
  });

  it('drops malformed entries but keeps the good ones', () => {
    const raw = JSON.stringify([
      { subject: 'Alice', relation: 'likes', object: 'tea' },
      { subject: '', relation: 'likes', object: 'coffee' },
      { subject: 'Bob', relation: '', object: 'tea' },
      { subject: 'Carol', relation: 'likes' },
      { subject: 42, relation: 'likes', object: 'tea' },
      null,
      'not an object',
      { subject: 'Dave', relation: 'prefers', object: 'vim' },
    ]);

    expect(parseTriplets(raw).map((triplet) => triplet.subject)).toEqual(['Alice', 'Dave']);
  });

  it('normalises relation spacing to snake_case', () => {
    expect(
      parseTriplets('[{"subject":"Alice","relation":"Works On","object":"OhMyAgent"}]')[0].relation,
    ).toBe('works_on');
  });

  it('handles brace characters inside a quoted value', () => {
    const triplets = parseTriplets(
      '[{"subject":"Alice","relation":"likes","object":"{weird} tea","confidence":1}]',
    );
    expect(triplets[0].object).toBe('{weird} tea');
  });

  it('salvages intact entries from a truncated payload', () => {
    // The model hit maxTokens mid-array: the outer JSON is unparseable.
    const raw =
      '[{"subject":"Alice","relation":"likes","object":"tea","confidence":0.9}, {"subject":"Bob","rel';

    expect(parseTriplets(raw)).toEqual([
      { subject: 'Alice', relation: 'likes', object: 'tea', confidence: 0.9 },
    ]);
  });

  it('never throws on garbage input', () => {
    for (const raw of [
      '',
      '   ',
      'no json here',
      '```',
      '[]',
      '{}',
      '[1,2,3]',
      '{"subject":}',
      '[[[[',
      'null',
      '\u0000\u0001',
    ]) {
      expect(() => parseTriplets(raw)).not.toThrow();
      expect(Array.isArray(parseTriplets(raw))).toBe(true);
    }
    expect(parseTriplets('no json here')).toEqual([]);
  });

  it('returns no triplets for an empty array', () => {
    expect(parseTriplets('[]')).toEqual([]);
  });

  it('is typed as a non-throwing pure function over undefined-ish input', () => {
    // Defensive: a misbehaving caller must not crash the turn.
    expect(parseTriplets(undefined as unknown as string)).toEqual([]);
  });
});

describe('TRIPLET_EXTRACTION_PROMPT', () => {
  it('names the closed edge vocabulary', () => {
    for (const relation of TRIPLET_RELATIONS) {
      expect(TRIPLET_EXTRACTION_PROMPT).toContain(relation);
    }
  });

  it('demands only facts stated in the turn', () => {
    expect(TRIPLET_EXTRACTION_PROMPT).toMatch(/explicitly stated in the turn/i);
  });
});

describe('extractTriplets', () => {
  const logger = createLogger();

  it('returns [] without touching the model when disabled', async () => {
    auxState.response = '[{"subject":"Alice","relation":"likes","object":"tea"}]';
    auxState.calls = 0;

    const triplets = await extractTriplets(
      { userMessage: 'I like tea', assistantReply: 'Noted.' },
      { enabled: false, logger },
    );

    expect(triplets).toEqual([]);
    expect(auxState.calls).toBe(0);
  });

  it('returns [] when no model is configured', async () => {
    auxState.calls = 0;
    const triplets = await extractTriplets(
      { userMessage: 'I like tea', assistantReply: 'Noted.' },
      { enabled: true, logger },
    );

    expect(triplets).toEqual([]);
    expect(auxState.calls).toBe(0);
  });

  it('returns parsed triplets from the model response', async () => {
    auxState.response = '[{"subject":"Alice","relation":"likes","object":"tea","confidence":0.9}]';

    const triplets = await extractTriplets(
      { userMessage: 'Alice likes tea', assistantReply: 'Noted.' },
      { enabled: true, logger, auxConfig: { modelRef: 'stub-model' } },
    );

    expect(triplets).toEqual([
      { subject: 'Alice', relation: 'likes', object: 'tea', confidence: 0.9 },
    ]);
  });

  it('drops triplets below minConfidence', async () => {
    auxState.response =
      '[{"subject":"Alice","relation":"likes","object":"tea","confidence":0.2},' +
      '{"subject":"Bob","relation":"likes","object":"tea","confidence":0.9}]';

    const triplets = await extractTriplets(
      { userMessage: 'Alice and Bob like tea', assistantReply: 'Noted.' },
      { enabled: true, logger, minConfidence: 0.5, auxConfig: { modelRef: 'stub-model' } },
    );

    expect(triplets.map((triplet) => triplet.subject)).toEqual(['Bob']);
  });

  it('returns [] and swallows model failures', async () => {
    auxState.response = ''; // the mock rejects

    const triplets = await extractTriplets(
      { userMessage: 'I like tea', assistantReply: 'Noted.' },
      { enabled: true, logger, auxConfig: { modelRef: 'stub-model' } },
    );

    expect(triplets).toEqual([]);
  });
});
