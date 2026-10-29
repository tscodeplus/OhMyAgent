/**
 * Read-time decay for graph edges.
 *
 * `entity_edges.confidence` is what the producer asserted and `valid_from` is
 * when it became true; neither changes as time passes, and `graph-sync` only
 * refreshes them when the memory is re-projected. So an edge asserted three
 * years ago weighs exactly as much as one asserted yesterday, and the overview's
 * degree ordering cannot tell "this is still true" from "this was true once".
 *
 * Decaying at read time is the only version that needs no writes: a stored
 * decayed value would have to be recomputed on a schedule, would lose the
 * producer's number, and would make `asOf` queries answer a different question
 * than they appear to. Here `asOf` keeps its meaning — decay is measured from
 * the edge's own `valid_from` to the instant being asked about, so "what did
 * this look like in June" still answers June and not today.
 *
 * Half-life is a threshold, so it is a config knob (`memory.graph.decay_half_life_days`);
 * `0` means off, which is the default — an existing install's ranking does not
 * move until someone asks for it.
 */

/** Age at which an edge's confidence halves. `0` (the default) disables decay. */
export const DEFAULT_DECAY_HALF_LIFE_DAYS = 0;

const MS_PER_DAY = 86_400_000;

/**
 * How much of its confidence an edge asserted at `validFrom` still carries at
 * `nowMs`.
 *
 * Returns `1` — no decay — when decay is off or the edge has no start time.
 * "No `valid_from`" means the producer did not say when this became true, and
 * decaying from an unknown start would be inventing an age, not measuring one.
 */
export function decayFactor(
  validFromMs: number | null | undefined,
  nowMs: number,
  halfLifeDays: number,
): number {
  if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0) return 1;
  if (validFromMs === null || validFromMs === undefined) return 1;
  if (!Number.isFinite(validFromMs) || validFromMs <= 0) return 1;
  // A future start (clock skew, or an `asOf` before the edge existed) is fresh,
  // not negatively aged.
  const ageDays = Math.max(0, (nowMs - validFromMs) / MS_PER_DAY);
  return Math.pow(0.5, ageDays / halfLifeDays);
}

/** The edge's confidence as of `nowMs`, in `[0, 1]`. */
export function decayedConfidence(
  confidence: number,
  validFromMs: number | null | undefined,
  nowMs: number,
  halfLifeDays: number,
): number {
  const raw = Number.isFinite(confidence) ? confidence : 0;
  const value = raw * decayFactor(validFromMs, nowMs, halfLifeDays);
  return Math.max(0, Math.min(1, value));
}
