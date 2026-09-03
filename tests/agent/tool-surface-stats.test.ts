import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordToolSurfaceTurn,
  getToolSurfaceSnapshot,
  resetToolSurfaceStats,
} from '../../src/agent/tool-surface-stats.js';

describe('tool-surface stats (P5)', () => {
  beforeEach(() => resetToolSurfaceStats());

  it('returns an empty snapshot when nothing recorded', () => {
    const snap = getToolSurfaceSnapshot();
    expect(snap.windowSize).toBe(0);
    expect(snap.avgVisibleTools).toBe(0);
    expect(snap.narrowRate).toBe(0);
  });

  it('aggregates averages and rates over the window', () => {
    recordToolSurfaceTurn({
      sessionId: 's1',
      profile: 'standard',
      skillStrict: false,
      intentDomain: 'bare-chat',
      visibleCount: 10,
      deferredCount: 20,
      toolSearchActivated: false,
      at: Date.now(),
    });
    recordToolSurfaceTurn({
      sessionId: 's2',
      profile: 'standard',
      skillStrict: false,
      visibleCount: 30,
      at: Date.now(),
    });
    recordToolSurfaceTurn({
      sessionId: 's3',
      profile: 'full',
      skillStrict: true,
      visibleCount: 40,
      at: Date.now(),
    });

    const snap = getToolSurfaceSnapshot();
    expect(snap.windowSize).toBe(3);
    // (10 + 30 + 40) / 3 = 26.7
    expect(snap.avgVisibleTools).toBe(26.7);
    // Only 1 turn carried tool-search data: 20 / 1 = 20
    expect(snap.avgDeferredTools).toBe(20);
    expect(snap.narrowTurns).toBe(1);
    expect(snap.narrowRate).toBeCloseTo(1 / 3, 3);
    expect(snap.strictTurns).toBe(1);
    expect(snap.byProfile).toEqual({ standard: 2, full: 1 });
    expect(snap.byIntentDomain).toEqual({ 'bare-chat': 1 });
  });

  it('keeps a bounded ring window', () => {
    for (let i = 0; i < 600; i++) {
      recordToolSurfaceTurn({
        sessionId: `s${i}`,
        profile: 'standard',
        skillStrict: false,
        visibleCount: 1,
        at: Date.now(),
      });
    }
    expect(getToolSurfaceSnapshot().windowSize).toBe(500);
  });
});
