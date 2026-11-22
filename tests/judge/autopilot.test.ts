/**
 * Judge autopilot (impl doc §7 automation): structural gate math, ledger
 * statistics (real-session filtering) and the automatic promotion/demotion
 * audit — the entire path is statistical, no human labeling anywhere.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { outcomeEquals, isRealSessionId } from '../../src/judge/outcome.js';
import {
  aggregateStats,
  checkDemotionGate,
  checkPromotionGate,
  collectLedger,
  collectStats,
  emptyStats,
  gateFor,
  HIGH_RISK_GATE,
  HIGH_RISK_POINTS,
  LOW_RISK_GATE,
  runAudit,
  windowStats,
  wilsonLowerBound,
  type LedgerLike,
} from '../../src/judge/autopilot.js';
import type { DecisionOutcome } from '../../src/judge/types.js';
import { JudgeEngine, JudgeLedger } from '../../src/judge/index.js';
import { createMockTier, mockJudgeConfig } from './mock.js';

const REAL = 'a1b2c3d4-1111-4222-8333-444455556666';
const DIAG = 'diag-ping';

describe('outcomeEquals', () => {
  it('compares structurally regardless of key order', () => {
    const a: DecisionOutcome = { action: 'keep', ids: ['a', 'b'] };
    const b: DecisionOutcome = { ids: ['a', 'b'], action: 'keep' };
    expect(outcomeEquals(a, b)).toBe(true);
  });

  it('distinguishes actions and payloads', () => {
    expect(outcomeEquals({ action: 'keep-all' }, { action: 'discard' })).toBe(false);
    expect(outcomeEquals({ action: 'none' }, { action: 'none' })).toBe(true);
    expect(
      outcomeEquals({ action: 'route', choice: 'memory' }, { action: 'route', choice: 'code' }),
    ).toBe(false);
    expect(
      outcomeEquals({ action: 'steer', message: 'x' }, { action: 'steer', message: 'x' }),
    ).toBe(true);
  });
});

describe('isRealSessionId', () => {
  it('accepts UUID sessions and rejects diagnostics / probes / tests', () => {
    expect(isRealSessionId(REAL)).toBe(true);
    expect(isRealSessionId('unknown')).toBe(false);
    expect(isRealSessionId(DIAG)).toBe(false);
    expect(isRealSessionId('s1')).toBe(false);
    expect(isRealSessionId('judge-test')).toBe(false);
  });
});

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'judge-autopilot-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeLedger(entries: LedgerLike[], sessionId: string): void {
  const month = '2026-02';
  mkdirSync(join(dir, month), { recursive: true });
  // Several files (also exercises the multi-file walk); each file holds a
  // disjoint slice — real ledgers are one entry per line, appended.
  for (let i = 0; i < entries.length; i++) {
    const file = `${sessionId}-${i}.jsonl`;
    writeFileSync(
      join(dir, month, file),
      `${JSON.stringify({
        ...entries[i]!,
        sessionId: entries[i]!.sessionId,
      })}\n`,
    );
  }
}

describe('collectStats', () => {
  it('counts real sessions only and aggregates agreement', () => {
    writeLedger(
      [
        { pointId: 'p1', sessionId: REAL, source: 'judge', agree: true },
        { pointId: 'p1', sessionId: REAL, source: 'judge', agree: false },
        { pointId: 'p1', sessionId: REAL, source: 'fallback', fallbackReason: 'gray-zone' },
        { pointId: 'p1', sessionId: DIAG, source: 'judge', agree: true },
      ],
      'mixed',
    );
    const stats = collectStats(dir);
    const p1 = stats.get('p1')!;
    expect(p1).toEqual({
      pointId: 'p1',
      total: 3,
      judged: 2,
      gray: 1,
      serviceFailure: 0,
      parseRejected: 0,
      comparable: 2,
      agreed: 1,
      keyStats: {},
      partialGray: 0,
    });
  });
});

describe('per-key gray tracking', () => {
  it('shows which key hedged and how often one key poisoned the batch', () => {
    writeLedger(
      [
        {
          pointId: 'p2',
          sessionId: REAL,
          source: 'judge',
          agree: true,
          answers: {
            k1: { type: 'noul', probability: 0.05 },
            k2: { type: 'noul', probability: 0.02 },
          },
        },
        {
          pointId: 'p2',
          sessionId: REAL,
          source: 'fallback',
          fallbackReason: 'gray-zone',
          grayAnswers: {
            k1: { type: 'noul', probability: 0.5 }, // hedged
            k2: { type: 'noul', probability: 0.02 }, // confident
          },
          grayKeys: ['k1'],
        },
        // Legacy row (written before grayKeys existed): point-level only.
        { pointId: 'p2', sessionId: REAL, source: 'fallback', fallbackReason: 'gray-zone' },
      ],
      'keys',
    );
    const p2 = collectStats(dir).get('p2')!;
    expect(p2.gray).toBe(2);
    expect(p2.keyStats).toEqual({
      k1: { answered: 2, gray: 1 },
      k2: { answered: 2, gray: 0 },
    });
    expect(p2.partialGray).toBe(1);
  });
});

describe('promotion gates', () => {
  it('high-risk points get the stricter gate', () => {
    expect(gateFor('tool.admission')).not.toEqual(LOW_RISK_GATE);
    expect(HIGH_RISK_POINTS.has('channel.triage')).toBe(true);
    expect(HIGH_RISK_POINTS.has('memory.capture')).toBe(false);
  });

  it('gate passes on healthy stats and fails each regime', () => {
    const base = emptyStats('p');
    // 44 agreed + 1 divergence: the one divergence is what makes the agreement
    // claim meaningful (and 44/45 still clears a 90% Wilson lower bound).
    for (let i = 0; i < 45; i++) {
      aggregateStats(base, {
        pointId: 'p',
        sessionId: REAL,
        source: 'judge',
        agree: i !== 0,
      });
    }
    expect(checkPromotionGate(base, LOW_RISK_GATE)).toEqual({ pass: true, reasons: [] });

    const lowAgreement = { ...base, comparable: 45, agreed: 40 };
    expect(checkPromotionGate(lowAgreement, LOW_RISK_GATE).pass).toBe(false);

    const grayHeavy = { ...base, gray: 18 };
    expect(checkPromotionGate(grayHeavy, LOW_RISK_GATE).pass).toBe(false);

    const small = emptyStats('p');
    expect(checkPromotionGate(small, LOW_RISK_GATE).pass).toBe(false);
  });

  it('holds a point whose shadow decisions never diverged from the floor', () => {
    // 60 impeccable agreements: promotion would change nothing and still pay a
    // judge call on every turn — no evidence the judge decides anything.
    const s = { ...emptyStats('p'), total: 60, judged: 60, comparable: 60, agreed: 60 };
    const verdict = checkPromotionGate(s, LOW_RISK_GATE);
    expect(verdict.pass).toBe(false);
    expect(verdict.reasons.map((r) => r.code)).toContain('no-divergence');
  });

  it('counts every service-layer fallback into serviceFailure', () => {
    const acc = emptyStats('p');
    for (const fallbackReason of [
      'unavailable',
      'no-key',
      'circuit-open',
      'aborted',
      'unsupported-ref',
      'unknown-model',
    ]) {
      aggregateStats(acc, { pointId: 'p', sessionId: REAL, source: 'fallback', fallbackReason });
    }
    aggregateStats(acc, {
      pointId: 'p',
      sessionId: REAL,
      source: 'fallback',
      fallbackReason: 'gray-zone',
    });
    aggregateStats(acc, {
      pointId: 'p',
      sessionId: REAL,
      source: 'fallback',
      fallbackReason: 'parse-rejected',
    });
    // Off-mode never reaches the ledger; an old line must not be blamed on the model.
    aggregateStats(acc, {
      pointId: 'p',
      sessionId: REAL,
      source: 'fallback',
      fallbackReason: 'mode-off',
    });
    expect(acc.serviceFailure).toBe(6);
    expect(acc.gray).toBe(1);
    expect(acc.parseRejected).toBe(1);
    expect(acc.total).toBe(9);
  });

  it('demands comparable samples, not just raw ones', () => {
    // 88 judged entries but only 12 carried an outcome-vs-floor comparison:
    // before, 10 comparables were enough to clear a 90% agreement bar.
    const s = { ...emptyStats('p'), total: 88, judged: 88, comparable: 12, agreed: 12 };
    const verdict = checkPromotionGate(s, LOW_RISK_GATE);
    expect(verdict.pass).toBe(false);
    expect(verdict.reasons.map((r) => r.code)).toContain('comparable');
    expect(verdict.reasons.map((r) => r.message).join(' | ')).toContain('comparable 12 < 30');
  });

  it('uses a Wilson lower bound so a lucky run of agreements cannot promote', () => {
    // 30/30 agrees → 91.7% lower bound, still clears the 90% low-risk bar…
    expect(wilsonLowerBound(30, 30)).toBeGreaterThan(0.9);
    expect(wilsonLowerBound(30, 30)).toBeLessThan(1);
    // …but a 95% point estimate over 60 samples (57/60) does NOT clear 95%.
    expect(wilsonLowerBound(57, 60)).toBeLessThan(0.95);
    expect(wilsonLowerBound(60, 60)).toBeGreaterThan(0.95);

    const lucky = { ...emptyStats('p'), total: 60, judged: 60, comparable: 60, agreed: 57 };
    const verdict = checkPromotionGate(lucky, HIGH_RISK_GATE);
    expect(verdict.pass).toBe(false);
    expect(verdict.reasons.map((r) => r.code)).toContain('agreement');
    expect(verdict.reasons.map((r) => r.message).join(' | ')).toContain('lower bound');
  });
});

describe('ledger filtering (promotion window)', () => {
  it('keeps only in-window entries from the current judge, and all fallbacks', () => {
    writeLedger(
      [
        {
          pointId: 'p1',
          sessionId: REAL,
          source: 'judge',
          agree: true,
          judgeId: 'current/m1',
          ts: '2026-02-10T00:00:00.000Z',
        },
        {
          pointId: 'p1',
          sessionId: REAL,
          source: 'judge',
          agree: true,
          judgeId: 'retired/m0',
          ts: '2026-02-10T00:00:00.000Z',
        },
        {
          pointId: 'p1',
          sessionId: REAL,
          source: 'fallback',
          fallbackReason: 'gray-zone',
          ts: '2026-02-10T00:00:00.000Z',
        },
        {
          pointId: 'p1',
          sessionId: REAL,
          source: 'judge',
          agree: true,
          judgeId: 'current/m1',
          ts: '2025-01-01T00:00:00.000Z',
        },
      ],
      'filtered',
    );
    const { stats, entries } = collectLedger(dir, {
      judgeIds: new Set(['current/m1']),
      sinceMs: Date.parse('2026-01-01T00:00:00.000Z'),
    });
    expect(entries).toHaveLength(2); // retired judge + stale window dropped
    const p1 = stats.get('p1')!;
    expect(p1.total).toBe(2);
    expect(p1.comparable).toBe(1);
    expect(p1.gray).toBe(1);
  });

  it('drops nothing when no filter is given', () => {
    writeLedger(
      [{ pointId: 'p1', sessionId: REAL, source: 'judge', agree: true, judgeId: 'retired/m0' }],
      'unfiltered',
    );
    expect(collectLedger(dir).entries).toHaveLength(1);
  });
});

describe('demotion gate + windowed stats', () => {
  it('windows the last N entries and flags judge degradation', () => {
    const entries: LedgerLike[] = [
      ...Array.from({ length: 20 }, () => ({
        pointId: 'p',
        sessionId: REAL,
        source: 'judge' as const,
        agree: true,
      })),
      ...Array.from({ length: 10 }, () => ({
        pointId: 'p',
        sessionId: REAL,
        source: 'fallback' as const,
        fallbackReason: 'gray-zone',
      })),
    ];
    const lifetime = emptyStats('p');
    for (const e of entries) aggregateStats(lifetime, e);
    // Lifetime looks fine (20 agreed vs 10 gray)…
    expect(lifetime.agreed).toBe(20);
    // …but the recent window is all gray → must demote.
    const w = windowStats(entries, 'p', 20);
    expect(w.total).toBe(20);
    expect(w.gray).toBe(10);
    expect(checkDemotionGate(w).pass).toBe(false);
  });

  it('healthy recent window holds', () => {
    const entries = Array.from({ length: 12 }, () => ({
      pointId: 'p',
      sessionId: REAL,
      source: 'judge' as const,
      agree: true,
    }));
    const w = windowStats(entries, 'p', 20);
    expect(checkDemotionGate(w).pass).toBe(true);
  });
});

describe('runAudit decisions', () => {
  function statsFrom(entries: LedgerLike[]): Map<string, ReturnType<typeof emptyStats>> {
    const map = new Map<string, ReturnType<typeof emptyStats>>();
    for (const e of entries) {
      let acc = map.get(e.pointId);
      if (!acc) {
        acc = emptyStats(e.pointId);
        map.set(e.pointId, acc);
      }
      aggregateStats(acc, e);
    }
    return map;
  }

  /**
   * Gate-passing history: every entry agrees with the floor except the first,
   * which diverged — the divergence is required evidence (a point that never
   * diverged is only re-deriving the floor), and 44/45 still clears the 90%
   * Wilson lower bound.
   */
  function passingEntries(pointId: string, n = 45): LedgerLike[] {
    return Array.from({ length: n }, (_, i) => ({
      pointId,
      sessionId: REAL,
      source: 'judge',
      agree: i !== 0,
    }));
  }

  it('promotes a shadow point through the gate', () => {
    const entries = passingEntries('memory.capture');
    const d = runAudit({
      stats: statsFrom(entries),
      entries,
      currentModes: {},
      managed: {},
    });
    expect(d.promote).toContain('memory.capture');
  });

  it('holds a failing gate and reports reasons', () => {
    const d = runAudit({
      stats: statsFrom([passingEntries('memory.capture', 5)[0]!]),
      entries: [passingEntries('memory.capture', 5)[0]!],
      currentModes: {},
      managed: {},
    });
    const rep = d.report.find((r) => r.pointId === 'memory.capture')!;
    expect(rep.decision).toBe('hold');
    expect(rep.reasons.length).toBeGreaterThan(0);
  });

  it('demotes a MANAGED active point whose recent window degraded', () => {
    const entries = [
      ...passingEntries('channel.triage', 60),
      ...Array.from({ length: 12 }, () => ({
        pointId: 'channel.triage',
        sessionId: REAL,
        source: 'fallback' as const,
        fallbackReason: 'unavailable',
      })),
    ];
    const d = runAudit({
      stats: statsFrom(entries),
      entries,
      currentModes: { 'channel.triage': 'active' },
      managed: { 'channel.triage': { promotedAt: '2026-02-01T00:00:00Z' } },
    });
    expect(d.demote).toContain('channel.triage');
  });

  it('never manages an explicitly active-but-unmanaged (user-pinned) point', () => {
    const entries = [
      ...passingEntries('channel.triage', 60),
      ...Array.from({ length: 20 }, () => ({
        pointId: 'channel.triage',
        sessionId: REAL,
        source: 'fallback' as const,
        fallbackReason: 'unavailable',
      })),
    ];
    const d = runAudit({
      stats: statsFrom(entries),
      entries,
      currentModes: { 'channel.triage': 'active' },
      managed: {},
    });
    expect(d.promote).not.toContain('channel.triage');
    expect(d.demote).not.toContain('channel.triage');
  });

  it('quietly skips off points', () => {
    const d = runAudit({
      stats: statsFrom(passingEntries('memory.capture')),
      entries: passingEntries('memory.capture'),
      currentModes: { 'memory.capture': 'off' },
      managed: {},
    });
    expect(d.promote).toEqual([]);
  });
});

// ─── Engine shadow-flight telemetry ──────────────────────────────────────

describe('engine agreement telemetry', () => {
  const SPEC_BASE = {
    id: 'telemetry.test',
    version: 1,
    questions: {
      q1: { type: 'choice', instructions: 'route?', criteria: { a: null, b: null } },
    },
  } as const;

  function make(mode: 'active' | 'shadow', policyAnswer: 'a' | 'b') {
    const tier = createMockTier({
      judgeId: 'mock/j1',
      answers: { q1: { type: 'choice', choice: policyAnswer, confidence: 0.9 } },
    });
    return new JudgeEngine({
      config: mockJudgeConfig(mode === 'active' ? {} : { modes: { default: mode } }),
      resolver: () => ({ tiers: [tier], noKeyRefs: [], unresolvableRefs: [] }),
      ledger: new JudgeLedger({ dir }),
    });
  }

  const spec = {
    ...SPEC_BASE,
    buildState: undefined,
    // policy only agrees with 'a' — 'b' would flip behavior.
    policy: (answers: { q1?: { choice?: string } }) =>
      answers.q1?.choice === 'a' ? { action: 'none' as const } : { action: 'discard' as const },
    fallback: { action: 'none' as const },
  } as never;

  it('judged shadow entry records agree/outcome/floor and keeps fallback behavior', async () => {
    const engine = make('shadow', 'a');
    const verdict = await engine.decide(spec as never, { state: {}, sessionId: REAL } as never);
    expect(verdict.outcome).toEqual({ action: 'none' });
    const rec = engine.ledger.recent(1)[0]! as unknown as Record<string, unknown>;
    expect(rec.agree).toBe(true);
    expect(rec.outcome).toEqual({ action: 'none' });
    expect(rec.floor).toEqual({ action: 'none' });
  });

  it('disagreement is recorded so the autopilot can see it', async () => {
    const engine = make('shadow', 'b');
    const verdict = await engine.decide(spec as never, { state: {}, sessionId: REAL } as never);
    expect(verdict.outcome).toEqual({ action: 'none' }); // shadow never applies
    const rec = engine.ledger.recent(1)[0]! as unknown as Record<string, unknown>;
    expect(rec.agree).toBe(false);
    expect(rec.outcome).toEqual({ action: 'discard' });
  });

  it('active mode applies the judgment AND records the agreement stat', async () => {
    const engine = make('active', 'b');
    const verdict = await engine.decide(spec as never, { state: {}, sessionId: REAL } as never);
    expect(verdict.outcome).toEqual({ action: 'discard' }); // applied
    const rec = engine.ledger.recent(1)[0]! as unknown as Record<string, unknown>;
    expect(rec.agree).toBe(false);
  });
});
