import { describe, it, expect } from 'vitest';
import { applyTemporalDecay } from '../../src/memory/temporal-decay.js';
import type { MergedResult } from '../../src/memory/rrf-merge.js';

function makeMerged(id: string, score: number, kind: string = 'fact', createdAt: number = Date.now()): MergedResult {
  return { id, content: `content-${id}`, score, source: 'vector', scope: 'user', scopeKey: 'u1', kind, createdAt };
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

describe('applyTemporalDecay', () => {
  it('decays 30-day-old memory by factor 0.5', () => {
    const now = Date.now();
    const thirtyDaysAgo = now - 30 * MS_PER_DAY;
    const results = [makeMerged('old', 1.0, 'fact', thirtyDaysAgo)];
    const decayed = applyTemporalDecay(results, { halfLifeDays: 30, nowMs: now });
    expect(decayed[0].score).toBeCloseTo(0.5, 2);
  });

  it('decays 60-day-old memory by factor 0.25', () => {
    const now = Date.now();
    const sixtyDaysAgo = now - 60 * MS_PER_DAY;
    const results = [makeMerged('old', 1.0, 'fact', sixtyDaysAgo)];
    const decayed = applyTemporalDecay(results, { halfLifeDays: 30, nowMs: now });
    expect(decayed[0].score).toBeCloseTo(0.25, 2);
  });

  it('exempts preference kind from decay', () => {
    const now = Date.now();
    const thirtyDaysAgo = now - 30 * MS_PER_DAY;
    const results = [makeMerged('pref', 1.0, 'preference', thirtyDaysAgo)];
    const decayed = applyTemporalDecay(results, { halfLifeDays: 30, nowMs: now });
    expect(decayed[0].score).toBeCloseTo(1.0, 5);  // unchanged
  });

  it('exempts custom coreKinds from decay', () => {
    const now = Date.now();
    const thirtyDaysAgo = now - 30 * MS_PER_DAY;
    const results = [makeMerged('sum', 1.0, 'summary', thirtyDaysAgo)];
    const decayed = applyTemporalDecay(results, { halfLifeDays: 30, nowMs: now }, ['preference', 'summary']);
    expect(decayed[0].score).toBeCloseTo(1.0, 5);
  });

  it('disables decay when halfLifeDays=0', () => {
    const thirtyDaysAgo = Date.now() - 30 * MS_PER_DAY;
    const results = [makeMerged('old', 1.0, 'fact', thirtyDaysAgo)];
    const decayed = applyTemporalDecay(results, { halfLifeDays: 0 });
    expect(decayed[0].score).toBeCloseTo(1.0, 5);
  });

  it('exempts zero createdAt from decay', () => {
    const results = [makeMerged('unknown', 1.0, 'fact', 0)];
    const decayed = applyTemporalDecay(results, { halfLifeDays: 30 });
    expect(decayed[0].score).toBeCloseTo(1.0, 5);
  });

  it('does not mutate input array', () => {
    const results = [makeMerged('a', 1.0, 'fact', Date.now() - 30 * MS_PER_DAY)];
    const originalScore = results[0].score;
    applyTemporalDecay(results, { halfLifeDays: 30 });
    expect(results[0].score).toBe(originalScore);  // unchanged
  });

  it('handles new memory with minimal decay', () => {
    const results = [makeMerged('new', 1.0, 'fact', Date.now())];
    const decayed = applyTemporalDecay(results, { halfLifeDays: 30 });
    expect(decayed[0].score).toBeCloseTo(1.0, 2);  // ~1 day old → ~0.977
  });

  it('handles future timestamps by clamping age to 0', () => {
    const future = Date.now() + 100 * MS_PER_DAY;
    const results = [makeMerged('future', 1.0, 'fact', future)];
    const decayed = applyTemporalDecay(results, { halfLifeDays: 30 });
    expect(decayed[0].score).toBeCloseTo(1.0, 5);
  });
});
