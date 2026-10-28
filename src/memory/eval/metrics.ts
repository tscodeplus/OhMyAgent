/**
 * The report contract for `src/memory/eval/knowledge-eval.ts` (plan §6 K0).
 *
 * Every field below is actually computed by that runner. The previous
 * declaration of this interface listed `recallPrecisionAtK` / `personaFreshness`
 * / `stalePreferenceRate` / `inactiveLeakageCount` / `averageRetrievalLatencyMs`
 * with zero implementations and zero importers, while `eval-runner.ts` used its
 * own private `EvalMetrics` (pAt5/rAt5/rAt10/mrr/ndcgAt5) — two shapes, one name.
 * `recallPrecisionAtK` is gone for good: it was a concept duplicate of
 * `pAt5`/`rAt5`, and two names for one number is how a report stops being
 * comparable across milestones.
 *
 * Denominator rule for the whole interface: a case marked `"unlabelled": true`
 * in its dataset (no honest golden could be derived from the live database)
 * contributes to NO metric. It is counted separately, per dataset, so a 60%
 * labelled set reads as 60% labelled rather than as a 40% failure.
 *
 * Nullable rule (harness v2): `null` means **not applicable**, never "zero".
 * A dataset whose goldens were quoted from another corpus reports `null` for
 * every metric it would otherwise have scored, because a `0.0%` there reads as
 * a failed gate while saying only "wrong corpus" — and the whole reason this
 * harness was rebuilt is that such a number is worse than no number. `null`
 * propagates to the aggregate when no dataset backed a metric at all.
 */
export interface EvalMetrics {
  /** Mean fraction of the top 5 that is relevant, over id-labelled cases. Math: `computeMetrics` in `eval-runner.ts`. */
  pAt5: number | null;
  /** Mean recall of the expected id set within the top 5, over id-labelled cases. */
  rAt5: number | null;
  /** Same as `rAt5` at depth 10 — measured, not aliased: the search is called at depth 10. */
  rAt10: number | null;
  /** Mean reciprocal rank of the first expected id, over id-labelled cases. G3 judges this against 0.6. */
  mrr: number | null;
  /** Mean NDCG@5 over id-labelled cases. */
  ndcgAt5: number | null;
  /**
   * Id-labelled cases that contributed to `pAt5`..`ndcgAt5` — episodic cases
   * with `expectedMessageIds` plus semantic cases with `expectedMemoryIds`.
   * Preference cases are scored by `stalePreferenceRate` instead, and
   * keyword-only semantic cases by `keywordRecallAt5`.
   */
  totalQueries: number;
  /**
   * Of `totalQueries`, how many got at least one id back in the fused top-K.
   * `0` here with `totalQueries > 0` means the fused list was empty —
   * a retrieval gap, not a wrong answer — which is why it is reported apart
   * from the accuracy metrics.
   */
  queriesWithResults: number;
  /**
   * Fraction of keyword-labelled semantic cases whose top-K fused text
   * contains ALL `expectedKeywords` (lower-cased, full-width → half-width,
   * whitespace-collapsed, substring match). `null` when the semantic dataset is
   * not applicable here or carries no keyword cases.
   */
  keywordRecallAt5: number | null;
  /**
   * Fraction of id-labelled cases with ANY expected message/memory id in the
   * top-K fused id set (union across every lane that ran). Set-based, not
   * ranked: ranking quality is what `mrr`/`ndcgAt5` measure.
   */
  idRecallAt5: number | null;
  /**
   * Fraction of changed-preference cases (non-empty `mustNotContain`) whose
   * superseded value still appears in the injected text. G1's judgement number:
   * target ≤ 10%.
   */
  stalePreferenceRate: number | null;
  /**
   * `stale` when the newest active preference memory is newer than the persona
   * by more than the runner's tolerance (see `PERSONA_FRESHNESS_TOLERANCE_MS`);
   * `unknown` when either timestamp could not be read (missing persona row or
   * no active preference memory yet).
   */
  personaFreshness: 'fresh' | 'stale' | 'unknown';
  /**
   * Distinct injected memory ids whose `memories.status` is not `'active'`
   * (superseded / invalidated / archived). `0` also means "no status lookup was
   * wired" — `KnowledgeEvalRun.statusLookupProvided` distinguishes the two.
   */
  inactiveLeakageCount: number;
  /** Arithmetic mean over every timed search call; `null` when no query ran. */
  averageRetrievalLatencyMs: number | null;
  /** Nearest-rank 50th percentile of the per-call latencies. */
  latencyP50Ms: number | null;
  /** Nearest-rank 95th percentile — G4's "≤ 30% increase" is judged on this one, not on the mean. */
  latencyP95Ms: number | null;
}

export interface EvalResult {
  metrics: EvalMetrics;
  summary: string;
  timestamp: string;
}
