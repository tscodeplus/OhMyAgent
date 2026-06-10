// src/memory/coverage-merge.ts
//
// Coverage-aware merge for intent-slotted retrieval.
//
// Standard RRF over a single flat pool lets a dominant entity's evidence drown
// the minority entity's evidence (e.g. "How do Jon and Gina BOTH destress?" —
// Jon's many dance turns push Gina's single evidence turn out of topK).
//
// coverageMerge runs RRF per slot, then guarantees each slot contributes at
// least `perSlotFloor` candidates via round-robin before filling the remaining
// seats by global RRF score. The pool size stays topK*N so downstream decay /
// metadata-expansion / rerank are untouched.

import { rrfMerge } from './rrf-merge.js';
import type { SourceResult, MergedResult } from './rrf-merge.js';

export interface SlotSourceLists {
  slotId: string;
  lists: SourceResult[][]; // [vector, fts, terms, ...] lists for each query in the slot
}

export function coverageMerge(
  slots: SlotSourceLists[],
  k = 60,
  topK = 30,
  perSlotFloor = 2,
): MergedResult[] {
  // Rank within each slot, tagging provenance.
  const ranked: MergedResult[][] = slots.map(slot =>
    rrfMerge(slot.lists, k, topK).map(item => ({ ...item, slot: item.slot ?? slot.slotId })),
  );

  const chosen = new Map<string, MergedResult>();
  const cursors = ranked.map(() => 0);

  const take = (item: MergedResult): void => {
    const existing = chosen.get(item.id);
    // Keep the higher RRF score; preserve the first slot tag that claimed it.
    if (!existing) {
      chosen.set(item.id, item);
    } else if (item.score > existing.score) {
      chosen.set(item.id, { ...item, slot: existing.slot });
    }
  };

  // Phase 1: round-robin guarantee — each slot contributes up to perSlotFloor.
  for (let round = 0; round < perSlotFloor; round++) {
    for (let s = 0; s < ranked.length; s++) {
      const list = ranked[s];
      while (cursors[s] < list.length && chosen.has(list[cursors[s]].id)) {
        cursors[s]++;
      }
      if (cursors[s] < list.length && chosen.size < topK) {
        take(list[cursors[s]]);
        cursors[s]++;
      }
    }
  }

  // Phase 2: fill remaining seats by global RRF score.
  const remainder = ranked
    .flat()
    .filter(item => !chosen.has(item.id))
    .sort((a, b) => b.score - a.score);
  for (const item of remainder) {
    if (chosen.size >= topK) break;
    take(item);
  }

  return Array.from(chosen.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}
