import { describe, it, expect } from 'vitest';
import { rerankMemoryResults } from '../../src/memory/retrieval/reranker.js';
import type { MergedResult } from '../../src/memory/rrf-merge.js';

function mr(id: string, content: string, score: number, extra: Partial<MergedResult> = {}): MergedResult {
  return {
    id,
    content,
    score,
    source: 'fts5',
    scope: 'public_eval',
    scopeKey: 'k',
    kind: 'dialogue_turn',
    createdAt: 0,
    ...extra,
  };
}

describe('rerankMemoryResults — speaker boost', () => {
  it('breaks ties toward the target speaker among comparable candidates', () => {
    // Equal lexical relevance, differing only by speaker — the boost is a
    // tiebreaker. (In production the target speaker's turn reaches topK via its
    // own coverage-merge slot; the boost decides among comparable candidates.)
    const results = [
      mr('maria', 'Maria said: martial arts is great.', 0.5, { speaker: 'Maria' }),
      mr('john', 'John said: martial arts is great.', 0.5, { speaker: 'John' }),
    ];
    const reranked = rerankMemoryResults('What martial arts has John done?', results, {
      targetSpeakers: ['John'],
      speakerBoost: 0.2,
    });
    expect(reranked[0].id).toBe('john');
  });

  it('falls back to parsing speaker from content', () => {
    const results = [
      mr('a', 'Gina said: I love dancing.', 0.5),
      mr('b', 'John said: I lost my job.', 0.5),
    ];
    const reranked = rerankMemoryResults('what did John say', results, { targetSpeakers: ['John'], speakerBoost: 0.3 });
    expect(reranked[0].id).toBe('b');
  });
});

describe('rerankMemoryResults — no options (regression lock)', () => {
  it('produces identical ordering with and without empty options', () => {
    const base = [
      mr('a', 'dance studio passion stress relief', 0.4),
      mr('b', 'banker job loss new business', 0.3),
      mr('c', 'unrelated content here', 0.35),
    ];
    const query = 'dance stress relief';
    const withoutOpts = rerankMemoryResults(query, base.map(r => ({ ...r })));
    const withEmptyOpts = rerankMemoryResults(query, base.map(r => ({ ...r })), {});
    expect(withEmptyOpts.map(r => r.id)).toEqual(withoutOpts.map(r => r.id));
    expect(withEmptyOpts.map(r => r.score)).toEqual(withoutOpts.map(r => r.score));
  });
});

describe('rerankMemoryResults — fused signal is not drowned by lexical overlap (M-H2)', () => {
  it('keeps a strong fusion candidate ahead of a weak one with heavy lexical overlap', () => {
    // Real RRF scores are tiny (single-source rank-0 ≈ 0.0164). 'strong' has a
    // much higher fused score (multi-source consensus) but ZERO lexical overlap
    // with the query; 'weak' is a single-source hit that happens to repeat query
    // words. Before normalization the raw lexical bonus (~0.18) dwarfed the RRF
    // gap (~0.03) and 'weak' won. After normalization the fusion signal holds.
    const results = [
      mr('strong', 'résumé compiled from multiple corroborating sources', 0.05),
      mr('weak', 'alpha bravo charlie delta echo foxtrot golf', 0.0164),
    ];
    const query = 'alpha bravo charlie delta';
    const reranked = rerankMemoryResults(query, results);
    expect(reranked[0].id).toBe('strong');
  });

  it('still lets lexical overlap break ties between comparable fusion scores', () => {
    const results = [
      mr('match', 'alpha bravo charlie delta', 0.0164),
      mr('nomatch', 'totally different words here', 0.0164),
    ];
    const reranked = rerankMemoryResults('alpha bravo charlie delta', results);
    expect(reranked[0].id).toBe('match');
  });
});
