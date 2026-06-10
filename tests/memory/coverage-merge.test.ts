import { describe, it, expect } from 'vitest';
import { coverageMerge } from '../../src/memory/coverage-merge.js';
import type { SlotSourceLists } from '../../src/memory/coverage-merge.js';
import type { SourceResult } from '../../src/memory/rrf-merge.js';

function src(id: string, score: number, speaker?: string): SourceResult {
  return {
    id,
    content: `content ${id}`,
    score,
    source: 'fts5',
    scope: 'public_eval',
    scopeKey: 'k',
    kind: 'dialogue_turn',
    createdAt: 0,
    speaker,
  };
}

describe('coverageMerge', () => {
  it('guarantees a minority slot a seat even when another slot dominates', () => {
    // Slot "jon" has many strong candidates; slot "gina" has a single weaker one.
    const jonList = [src('j1', 0.9, 'Jon'), src('j2', 0.8, 'Jon'), src('j3', 0.7, 'Jon')];
    const ginaList = [src('g1', 0.3, 'Gina')];
    const slots: SlotSourceLists[] = [
      { slotId: 'entity:Jon', lists: [jonList] },
      { slotId: 'entity:Gina', lists: [ginaList] },
    ];
    const merged = coverageMerge(slots, 60, 3, 1);
    const ids = merged.map(m => m.id);
    expect(ids).toContain('g1'); // minority evidence guaranteed despite low score
    expect(ids).toContain('j1');
  });

  it('tags results with their originating slot', () => {
    const slots: SlotSourceLists[] = [
      { slotId: 'entity:Jon', lists: [[src('j1', 0.9)]] },
      { slotId: 'entity:Gina', lists: [[src('g1', 0.5)]] },
    ];
    const merged = coverageMerge(slots, 60, 10, 1);
    expect(merged.find(m => m.id === 'j1')?.slot).toBe('entity:Jon');
    expect(merged.find(m => m.id === 'g1')?.slot).toBe('entity:Gina');
  });

  it('dedupes ids across slots keeping the higher score', () => {
    const slots: SlotSourceLists[] = [
      { slotId: 'a', lists: [[src('x', 0.4)]] },
      { slotId: 'b', lists: [[src('x', 0.9)]] },
    ];
    const merged = coverageMerge(slots, 60, 10, 2);
    expect(merged.filter(m => m.id === 'x')).toHaveLength(1);
  });

  it('respects the topK cap', () => {
    const slots: SlotSourceLists[] = [
      { slotId: 'a', lists: [[src('a1', 0.9), src('a2', 0.8), src('a3', 0.7)]] },
      { slotId: 'b', lists: [[src('b1', 0.6), src('b2', 0.5)]] },
    ];
    const merged = coverageMerge(slots, 60, 2, 1);
    expect(merged).toHaveLength(2);
  });

  it('handles empty slots without throwing', () => {
    const slots: SlotSourceLists[] = [
      { slotId: 'a', lists: [[]] },
      { slotId: 'b', lists: [[src('b1', 0.5)]] },
    ];
    const merged = coverageMerge(slots, 60, 5, 2);
    expect(merged.map(m => m.id)).toEqual(['b1']);
  });
});
