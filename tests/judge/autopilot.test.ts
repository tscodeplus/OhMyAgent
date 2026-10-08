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
  HIGH_RISK_POINTS,
  LOW_RISK_GATE,
  runAudit,
  windowStats,
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
    });
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
    for (let i = 0; i < 30; i++) {
      aggregateStats(base, { pointId: 'p', sessionId: REAL, source: 'judge', agree: true });
    }
    expect(checkPromotionGate(base, LOW_RISK_GATE)).toEqual({ pass: true, reasons: [] });

    const lowAgreement = { ...base, comparable: 30, agreed: 26 };
    expect(checkPromotionGate(lowAgreement, LOW_RISK_GATE).pass).toBe(false);

    const grayHeavy = { ...base, gray: 8 };
    expect(checkPromotionGate(grayHeavy, LOW_RISK_GATE).pass).toBe(false);

    const small = emptyStats('p');
    expect(checkPromotionGate(small, LOW_RISK_GATE).pass).toBe(false);
  });
});

describe('demotion gate + windowed stats', () => {
  it('windows the last N entries and flags judge degradation', () => {
    const entries: LedgerLike[] = [
      ...Array.from({ length: 20 }, () => ({
        pointId: 'p',
        sessionId: REAL,
        source: 'judge',
        agree: true,
      })),
      ...Array.from({ length: 10 }, () => ({
        pointId: 'p',
        sessionId: REAL,
        source: 'fallback',
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
      source: 'judge',
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

  function passingEntries(pointId: string, n = 30): LedgerLike[] {
    return Array.from({ length: n }, () => ({
      pointId,
      sessionId: REAL,
      source: 'judge',
      agree: true,
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
