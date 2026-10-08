/**
 * Judge autopilot (impl doc §7 automation) — pure statistics and gate logic.
 *
 * Design: NO human labeling, ever. Shadow entries double-run — the ledger
 * records both what active mode WOULD decide (`outcome`, from `spec.policy`)
 * and the pre-judge rule floor (`floor`, `spec.fallback`). The agreement rate
 * between them is a machine-computable accuracy proxy, which — together with
 * gray-zone / parse-rejection / availability rates — forms the statistical
 * gate for automatic promotion (shadow → active) and automatic demotion
 * (active → shadow). The runtime wiring lives in src/app/judge-autopilot.ts.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DecisionOutcome, JudgmentSource, JudgeMode } from './types.js';
import { isRealSessionId } from './outcome.js';

/** Per-point shadow statistics over the ledger. */
export interface PointStats {
  pointId: string;
  /** Real-session entries (UUID session ids only). */
  total: number;
  /** Entries the judge actually answered (source 'judge'). */
  judged: number;
  /** Gray-zone fallbacks (judge unsure → fail-closed floor). */
  gray: number;
  /** Unavailable / error fallbacks (service layer). */
  serviceFailure: number;
  /** Unparseable judge responses. */
  parseRejected: number;
  /** Judged entries carrying an outcome-vs-floor comparison. */
  comparable: number;
  /** Of those, how many agreed with the floor. */
  agreed: number;
}

export function emptyStats(pointId: string): PointStats {
  return {
    pointId,
    total: 0,
    judged: 0,
    gray: 0,
    serviceFailure: 0,
    parseRejected: 0,
    comparable: 0,
    agreed: 0,
  };
}

export function aggregateStats(acc: PointStats, entry: LedgerLike): void {
  acc.total += 1;
  if (entry.source === 'judge') {
    acc.judged += 1;
    if (entry.agree !== undefined && entry.agree !== null) {
      acc.comparable += 1;
      if (entry.agree === true) acc.agreed += 1;
    }
  } else if (entry.fallbackReason === 'gray-zone') {
    acc.gray += 1;
  } else if (entry.fallbackReason === 'unavailable') {
    acc.serviceFailure += 1;
  } else if (entry.fallbackReason === 'parse-rejected') {
    acc.parseRejected += 1;
  }
}

/** Loose record shape — only what the autopilot reads. */
export interface LedgerLike {
  pointId: string;
  sessionId: string;
  mode?: JudgeMode;
  source: JudgmentSource;
  fallbackReason?: string;
  agree?: boolean | null;
}

/** Walk `<dir>/<yyyy-mm>/*.jsonl`, keeping real-session entries only. */
export function collectLedger(dir: string): {
  stats: Map<string, PointStats>;
  entries: LedgerLike[];
} {
  const entries: LedgerLike[] = [];
  const stats = collectStatsInto(dir, entries);
  return { stats, entries };
}

/** Entries for stats only (no list materialized). */
export function collectStats(dir: string): Map<string, PointStats> {
  return collectStatsInto(dir, undefined);
}

function collectStatsInto(dir: string, sink?: LedgerLike[]): Map<string, PointStats> {
  const stats = new Map<string, PointStats>();
  let months: string[];
  try {
    months = readdirSync(dir).filter((name) => /^\d{4}-\d{2}$/.test(name));
  } catch {
    return stats;
  }
  for (const month of months) {
    let files: string[];
    try {
      files = readdirSync(join(dir, month)).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const file of files) {
      let lines: string[];
      try {
        lines = readFileSync(join(dir, month, file), 'utf8').split('\n');
      } catch {
        continue;
      }
      for (const line of lines) {
        if (!line.trim()) continue;
        let entry: LedgerLike;
        try {
          entry = JSON.parse(line) as LedgerLike;
        } catch {
          continue;
        }
        if (!entry || typeof entry.pointId !== 'string' || !entry.source) continue;
        if (!isRealSessionId(entry.sessionId)) continue;
        sink?.push(entry);
        let acc = stats.get(entry.pointId);
        if (!acc) {
          acc = emptyStats(entry.pointId);
          stats.set(entry.pointId, acc);
        }
        aggregateStats(acc, entry);
      }
    }
  }
  return stats;
}

// ─── Gates ────────────────────────────────────────────────────────────────

export interface PromotionGate {
  /** Minimum real-session samples. */
  minSamples: number;
  /** Minimum shadow agreement rate over comparable judged entries. */
  minAgreement: number;
  /** Maximum gray-zone fallback rate. */
  maxGrayRate: number;
  /** Maximum parse-rejection rate. */
  maxParseRejectedRate: number;
  /** Maximum unavailable/service-failure rate. */
  maxServiceFailureRate: number;
}

/** Standard gate for behavioural low-risk points. */
export const LOW_RISK_GATE: PromotionGate = {
  minSamples: 30,
  minAgreement: 0.9,
  maxGrayRate: 0.2,
  maxParseRejectedRate: 0.05,
  maxServiceFailureRate: 0.1,
};

/** Stricter gate for high-risk points (tool/notify/channel gating). */
export const HIGH_RISK_GATE: PromotionGate = {
  minSamples: 60,
  minAgreement: 0.95,
  maxGrayRate: 0.15,
  maxParseRejectedRate: 0.02,
  maxServiceFailureRate: 0.05,
};

/** Points whose wrong decisions affect message routing, tool admission,
 * notification delivery or security screening. */
export const HIGH_RISK_POINTS = new Set([
  'tool.admission',
  'tool.risk',
  'injection.screen',
  'channel.triage',
  'notify.routing',
]);

export function gateFor(pointId: string): PromotionGate {
  return HIGH_RISK_POINTS.has(pointId) ? HIGH_RISK_GATE : LOW_RISK_GATE;
}

export interface GateVerdict {
  pass: boolean;
  reasons: string[];
}

export function agreementRate(s: PointStats): number | undefined {
  return s.comparable > 0 ? s.agreed / s.comparable : undefined;
}

function rate(part: number, total: number): number {
  return total > 0 ? part / total : 0;
}

export function checkPromotionGate(s: PointStats, gate: PromotionGate): GateVerdict {
  const reasons: string[] = [];
  if (s.total < gate.minSamples) reasons.push(`samples ${s.total} < ${gate.minSamples}`);
  const agreement = agreementRate(s);
  if (agreement === undefined || s.comparable < Math.min(10, gate.minSamples)) {
    reasons.push(`agreement unresolved (${s.comparable} comparable)`);
  } else if (agreement < gate.minAgreement) {
    reasons.push(
      `agreement ${(agreement * 100).toFixed(1)}% < ${(gate.minAgreement * 100).toFixed(0)}%`,
    );
  }
  const gray = rate(s.gray, s.total);
  if (gray > gate.maxGrayRate)
    reasons.push(`gray rate ${(gray * 100).toFixed(1)}% > ${(gate.maxGrayRate * 100).toFixed(0)}%`);
  const rejected = rate(s.parseRejected, s.total);
  if (rejected > gate.maxParseRejectedRate)
    reasons.push(
      `parse-rejected rate ${(rejected * 100).toFixed(1)}% > ${(gate.maxParseRejectedRate * 100).toFixed(0)}%`,
    );
  const unavailable = rate(s.serviceFailure, s.total);
  if (unavailable > gate.maxServiceFailureRate)
    reasons.push(
      `unavailable rate ${(unavailable * 100).toFixed(1)}% > ${(gate.maxServiceFailureRate * 100).toFixed(0)}%`,
    );
  return { pass: reasons.length === 0, reasons };
}

/**
 * Demotion gate — evaluated over the RECENT window (the last `window` real
 * entries, default 20) of an autopilot-managed active point. The windowed
 * view catches a judge degrading AFTER promotion; lifetime stats would hide
 * it behind the healthy shadow history that earned the promotion.
 */
export function checkDemotionGate(
  window: PointStats,
  minSamples = 10,
  maxGrayRate = 0.4,
  maxServiceFailureRate = 0.4,
  minAgreement = 0.7,
): GateVerdict {
  const reasons: string[] = [];
  const unusable = rate(window.gray + window.serviceFailure + window.parseRejected, window.total);
  if (window.total >= minSamples && unusable > maxGrayRate)
    reasons.push(
      `unusable rate ${(unusable * 100).toFixed(1)}% > ${(maxGrayRate * 100).toFixed(0)}%`,
    );
  const agreement = agreementRate(window);
  if (window.comparable >= minSamples && agreement !== undefined && agreement < minAgreement)
    reasons.push(
      `agreement ${(agreement * 100).toFixed(1)}% < ${(minAgreement * 100).toFixed(0)}%`,
    );
  return { pass: reasons.length === 0, reasons };
}

/** Slip the last `size` real entries of one point out of the record list (newest last). */
export function windowStats(entries: LedgerLike[], pointId: string, size = 20): PointStats {
  const acc = emptyStats(pointId);
  const owned = entries.filter((e) => e.pointId === pointId);
  for (const e of owned.slice(-size)) aggregateStats(acc, e);
  return acc;
}

// ─── Audit decision ──────────────────────────────────────────────────────

export interface AuditInput {
  /** per-point lifetime stats (real sessions only). */
  stats: Map<string, PointStats>;
  /** ALL real-session entries in ledger order (for windowed demotion checks). */
  entries: LedgerLike[];
  /** Effective mode per point (modes[id] ?? modes.default ?? 'shadow'). */
  currentModes: Record<string, JudgeMode>;
  /** Points the autopilot promoted itself — demotion only applies to these. */
  managed: Record<string, { promotedAt: string }>;
}

export interface AuditDecision {
  promote: string[];
  demote: string[];
  report: PointReport[];
}

export interface PointReport {
  pointId: string;
  mode: JudgeMode;
  stats: PointStats;
  gate: GateVerdict;
  decision: 'promote' | 'demote' | 'hold';
  reasons: string[];
}

export function runAudit(input: AuditInput): AuditDecision {
  const promote: string[] = [];
  const demote: string[] = [];
  const report: PointReport[] = [];

  const pointIds = new Set<string>([...input.stats.keys(), ...Object.keys(input.currentModes)]);
  for (const pointId of pointIds) {
    const mode = input.currentModes[pointId] ?? 'shadow';
    const stats = input.stats.get(pointId) ?? emptyStats(pointId);
    let decision: PointReport['decision'] = 'hold';
    let reasons: string[] = [];

    if (mode === 'off') {
      // Never auto-manage an explicitly disabled point.
      report.push({ pointId, mode, stats, gate: { pass: false, reasons: [] }, decision, reasons });
      continue;
    }
    if (mode === 'shadow') {
      const gate = checkPromotionGate(stats, gateFor(pointId));
      reasons = gate.reasons;
      if (gate.pass) {
        decision = 'promote';
        promote.push(pointId);
      }
    }
    if (mode === 'active' && input.managed[pointId]) {
      // Windowed health check → automatic demote (self-correction).
      const window = windowStats(input.entries, pointId);
      const gate = checkDemotionGate(window);
      reasons = gate.reasons;
      if (!gate.pass) {
        decision = 'demote';
        demote.push(pointId);
      }
    }
    report.push({
      pointId,
      mode,
      stats,
      gate: reasons.length === 0 ? { pass: true, reasons } : { pass: false, reasons },
      decision,
      reasons,
    });
  }
  return { promote, demote, report };
}

/** Types re-exported for the wiring layer. */
export type { DecisionOutcome };
