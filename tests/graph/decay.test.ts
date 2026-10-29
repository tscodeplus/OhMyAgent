/**
 * Read-time edge decay (I8).
 *
 * The failure this file exists to prevent: `entity_edges.confidence` never
 * changes after projection, so a relation asserted three years ago ranks exactly
 * as high as one asserted yesterday and the overview's degree ordering cannot
 * tell "still true" from "true once".
 *
 * Decay is read-time and measured from each edge's own `valid_from`, which keeps
 * three properties that a stored-decayed value would lose: the producer's number
 * stays readable (`confidence`), `asOf` keeps answering about *that* instant
 * (not today), and no migration or scheduled rewrite is needed.
 *
 * Off by default (`0`), because an existing install's ranking must not move on
 * upgrade.
 */

import { describe, expect, it } from 'vitest';
import { decayFactor, decayedConfidence } from '../../src/graph/decay.js';

const DAY = 86_400_000;
const NOW = 1_767_225_600_000; // 2026-01-01T00:00:00Z, fixed so the maths is exact

describe('decay', () => {
  it('leaves everything alone when the half-life is 0 or absent', () => {
    expect(decayFactor(NOW - 3650 * DAY, NOW, 0)).toBe(1);
    expect(decayedConfidence(0.9, NOW - 3650 * DAY, NOW, 0)).toBe(0.9);
  });

  it('halves per half-life, measured from the edge’s own valid_from', () => {
    expect(decayFactor(NOW, NOW, 30)).toBe(1);
    expect(decayFactor(NOW - 30 * DAY, NOW, 30)).toBeCloseTo(0.5, 6);
    expect(decayFactor(NOW - 60 * DAY, NOW, 30)).toBeCloseTo(0.25, 6);
    expect(decayedConfidence(0.8, NOW - 30 * DAY, NOW, 30)).toBeCloseTo(0.4, 6);
  });

  it('does not decay an edge whose start is unknown or in the future', () => {
    // No valid_from means the producer did not say when this became true;
    // decaying from an unknown start would be inventing an age.
    expect(decayFactor(null, NOW, 30)).toBe(1);
    expect(decayFactor(undefined, NOW, 30)).toBe(1);
    expect(decayFactor(0, NOW, 30)).toBe(1);
    // Clock skew, or an asOf that predates the edge: fresh, not negatively aged.
    expect(decayFactor(NOW + 10 * DAY, NOW, 30)).toBe(1);
  });

  it('measures age against the instant asked about, not against today', () => {
    const sixtyDaysAgo = NOW - 60 * DAY;
    // Same edge, same half-life, but "what was true 60 days ago" sees an edge
    // that had just been asserted — that is the whole point of the asOf path.
    expect(decayFactor(NOW, sixtyDaysAgo, 30)).toBe(1);
    expect(decayFactor(sixtyDaysAgo, sixtyDaysAgo, 30)).toBe(1);
    expect(decayFactor(sixtyDaysAgo, NOW, 30)).toBeCloseTo(0.25, 6);
  });

  it('clamps to [0, 1] whatever it is handed', () => {
    expect(decayedConfidence(2, NOW, NOW, 30)).toBe(1);
    expect(decayedConfidence(-1, NOW, NOW, 30)).toBe(0);
    expect(decayedConfidence(Number.NaN, NOW, NOW, 30)).toBe(0);
    // A very old edge with a one-day half-life decays to zero, never below it.
    expect(decayedConfidence(0.5, NOW - 10_000 * DAY, NOW, 1)).toBeGreaterThanOrEqual(0);
    expect(decayedConfidence(0.5, NOW - 10_000 * DAY, NOW, 1)).toBeLessThan(1e-6);
  });
});
