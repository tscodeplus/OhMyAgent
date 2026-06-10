import { describe, it, expect } from 'vitest';
import { rrfMerge } from '../../src/memory/rrf-merge.js';
import type { SourceResult } from '../../src/memory/rrf-merge.js';

function makeResult(id: string, score: number, source: 'vector' | 'fts5' | 'cosine' = 'vector'): SourceResult {
  return { id, content: `content-${id}`, score, source, scope: 'user', scopeKey: 'u1', kind: 'fact', createdAt: Date.now() };
}

describe('rrfMerge', () => {
  it('returns RRF-scored results for single source list', () => {
    const list = [makeResult('a', 0.9), makeResult('b', 0.8), makeResult('c', 0.7)];
    const merged = rrfMerge([list], 60, 3);
    expect(merged).toHaveLength(3);
    // Rank 1 → score = 1/(1+60) = 1/61
    expect(merged[0].score).toBeCloseTo(1 / 61, 4);
    expect(merged[0].id).toBe('a');
  });

  it('merges two source lists with RRF', () => {
    const vec = [makeResult('a', 0.9), makeResult('b', 0.8)];
    const fts = [makeResult('c', 0.7), makeResult('a', 0.6, 'fts5')];
    const merged = rrfMerge([vec, fts], 60, 5);
    // 'a' appears in both → boosted
    const aResult = merged.find(r => r.id === 'a');
    expect(aResult).toBeDefined();
    const bResult = merged.find(r => r.id === 'b');
    expect(bResult).toBeDefined();
    // 'a' should rank higher than 'b' because it gets RRF from both lists
    expect(merged[0].id).toBe('a');
  });

  it('accumulates RRF score from multiple sources', () => {
    const vec = [makeResult('x', 0.9)];          // rank 1 → 1/61
    const fts = [makeResult('x', 0.8, 'fts5')];  // rank 1 → 1/61
    const merged = rrfMerge([vec, fts], 60, 5);
    expect(merged).toHaveLength(1);
    expect(merged[0].score).toBeCloseTo(2 / 61, 4);  // 1/61 + 1/61
  });

  it('handles empty source lists', () => {
    expect(rrfMerge([], 60, 5)).toHaveLength(0);
    expect(rrfMerge([[]], 60, 5)).toHaveLength(0);
    expect(rrfMerge([[], []], 60, 5)).toHaveLength(0);
  });

  it('respects topK limit', () => {
    const list = [makeResult('a',1), makeResult('b',0.9), makeResult('c',0.8), makeResult('d',0.7), makeResult('e',0.6)];
    const merged = rrfMerge([list], 60, 2);
    expect(merged).toHaveLength(2);
  });

  it('k=0 makes rank differences more extreme', () => {
    const list = [makeResult('a',1), makeResult('b',0.9)];
    const mergedK60 = rrfMerge([list], 60, 2);
    const mergedK0 = rrfMerge([list], 0, 2);
    // With k=0: rank1=1.0, rank2=0.5 → ratio 2:1
    // With k=60: rank1≈0.0164, rank2≈0.0161 → ratio ~1.02:1
    const ratioK60 = mergedK60[0].score / mergedK60[1].score;
    const ratioK0 = mergedK0[0].score / mergedK0[1].score;
    expect(ratioK0).toBeGreaterThan(ratioK60);
  });

  it('preserves first-seen content for duplicate ids', () => {
    const vec = [makeResult('dup', 0.9)];   // content = "content-dup"
    // Simulate same id with different content from another source
    const fts: SourceResult[] = [{ id: 'dup', content: 'different-content', score: 0.8, source: 'fts5', scope: 'user', scopeKey: 'u1', kind: 'fact', createdAt: Date.now() }];
    const merged = rrfMerge([vec, fts], 60, 5);
    expect(merged[0].content).toBe('content-dup');  // first-seen preserved
  });
});
