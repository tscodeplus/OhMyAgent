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
  /**
   * Fallbacks caused by the service layer rather than the answer's confidence:
   * `unavailable`, `no-key`, `circuit-open`, `aborted`, `unsupported-ref`,
   * `unknown-model`. All of them make the sample unusable, so they share one
   * bucket — before this, the last four were counted into `total` only, which
   * diluted every rate AND quietly helped satisfy `minSamples`.
   */
  serviceFailure: number;
  /** Unparseable judge responses. */
  parseRejected: number;
  /** Judged entries carrying an outcome-vs-floor comparison. */
  comparable: number;
  /** Of those, how many agreed with the floor. */
  agreed: number;
  /**
   * Per answer key: how often it was answered and how often it came back gray.
   * A multi-candidate point (`context.forget` k1..kN, `tool.admission`
   * c1..cN) fails a whole call on ONE gray key, so the point-level gray rate
   * hides which key is actually the problem.
   */
  keyStats: Record<string, { answered: number; gray: number }>;
  /**
   * Gray calls in which at least one other key was confidently answered —
   * i.e. "one hedged key poisoned N good answers".
   */
  partialGray: number;
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
    keyStats: {},
    partialGray: 0,
  };
}

/** Fallback reasons that mean "the judge was never properly asked". */
const SERVICE_FAILURE_REASONS = new Set([
  'unavailable',
  'no-key',
  'circuit-open',
  'aborted',
  'unsupported-ref',
  'unknown-model',
]);

/** Fold one entry's answer keys into the per-key table. */
function noteKeys(acc: PointStats, keys: string[], grayKeys: Set<string>): void {
  for (const key of keys) {
    const slot = (acc.keyStats[key] ??= { answered: 0, gray: 0 });
    slot.answered += 1;
    if (grayKeys.has(key)) slot.gray += 1;
  }
}

export function aggregateStats(acc: PointStats, entry: LedgerLike): void {
  acc.total += 1;
  const answeredKeys = Object.keys(entry.answers ?? {});
  if (entry.source === 'judge') {
    acc.judged += 1;
    noteKeys(acc, answeredKeys, new Set());
    if (entry.agree !== undefined && entry.agree !== null) {
      acc.comparable += 1;
      if (entry.agree === true) acc.agreed += 1;
    }
  } else if (entry.fallbackReason === 'gray-zone') {
    acc.gray += 1;
    // Rows written before grayKeys existed carry no answers — they still count
    // toward the point-level rate, just not toward the per-key table.
    const grayKeys = new Set(entry.grayKeys ?? []);
    const sighted = Object.keys(entry.grayAnswers ?? {});
    if (sighted.length > 0) noteKeys(acc, sighted, grayKeys);
    if (grayKeys.size > 0 && hasConfidentSibling(entry.grayAnswers, grayKeys)) acc.partialGray += 1;
  } else if (entry.fallbackReason === 'parse-rejected') {
    acc.parseRejected += 1;
  } else if (entry.fallbackReason === 'mode-off') {
    // Off-mode calls write no ledger line; an old line with this reason is not
    // a judge defect and must not be blamed on the model.
  } else if (
    entry.fallbackReason === undefined ||
    SERVICE_FAILURE_REASONS.has(entry.fallbackReason)
  ) {
    acc.serviceFailure += 1;
  }
}

/** True when at least one answer key outside the gray set was confident. */
function hasConfidentSibling(
  answers: Record<string, unknown> | undefined,
  grayKeys: Set<string>,
): boolean {
  if (!answers) return false;
  return Object.keys(answers).some((key) => !grayKeys.has(key));
}

/** Loose record shape — only what the autopilot reads. */
export interface LedgerLike {
  pointId: string;
  sessionId: string;
  mode?: JudgeMode;
  source: JudgmentSource;
  fallbackReason?: string;
  agree?: boolean | null;
  /** ISO timestamp of the call (recency windows). */
  ts?: string;
  /** Judge that answered (`provider/model` or the custom judge name). */
  judgeId?: string;
  /** Judged only: the answers the judge committed to. */
  answers?: Record<string, unknown>;
  /** Gray fallbacks only: the answers that tripped the gray band. */
  grayAnswers?: Record<string, unknown>;
  /** Gray fallbacks only: which of those keys were gray. */
  grayKeys?: string[];
}

/** Which ledger entries a promotion audit is allowed to look at. */
export interface LedgerFilter {
  /** Drop entries older than this (epoch ms). */
  sinceMs?: number;
  /**
   * Keep only entries produced by these judges. Entries WITHOUT a judgeId
   * (every fallback) always survive: availability is a property of the
   * environment, not of one model, and dropping them would hide outages.
   */
  judgeIds?: Set<string>;
}

/**
 * Promotion statistics window. Long enough that a low-traffic point can still
 * reach the sample floors, short enough that a year-old history from a
 * different model cannot keep vouching for the current chain.
 */
export const PROMOTION_WINDOW_DAYS = 90;

function keepEntry(entry: LedgerLike, filter?: LedgerFilter): boolean {
  if (!filter) return true;
  if (filter.judgeIds && entry.judgeId && !filter.judgeIds.has(entry.judgeId)) return false;
  if (filter.sinceMs !== undefined) {
    const ts = entry.ts ? Date.parse(entry.ts) : Number.NaN;
    // An unparseable/absent timestamp is kept — never silently drop a sample
    // because of a malformed field.
    if (Number.isFinite(ts) && ts < filter.sinceMs) return false;
  }
  return true;
}

/** Walk `<dir>/<yyyy-mm>/*.jsonl`, keeping real-session entries only. */
export function collectLedger(
  dir: string,
  filter?: LedgerFilter,
): {
  stats: Map<string, PointStats>;
  entries: LedgerLike[];
} {
  const entries: LedgerLike[] = [];
  const stats = collectStatsInto(dir, entries, filter);
  return { stats, entries };
}

/** Entries for stats only (no list materialized). */
export function collectStats(dir: string, filter?: LedgerFilter): Map<string, PointStats> {
  return collectStatsInto(dir, undefined, filter);
}

function collectStatsInto(
  dir: string,
  sink?: LedgerLike[],
  filter?: LedgerFilter,
): Map<string, PointStats> {
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
        if (!keepEntry(entry, filter)) continue;
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
  /**
   * Minimum INFORMATIVE comparisons: shadow decisions that actually diverged
   * from the floor. A point that never diverged proves nothing about its own
   * judgment (it may simply map everything onto the floor), and promoting it
   * would change no behavior while paying for a judge call on every turn.
   *
   * Deliberately 1 for every risk class rather than a bigger number: an
   * agreement LOWER bound and a divergence count pull in opposite directions
   * (each divergence spends confidence budget), so demanding several
   * divergences would make the gate unreachable below a few hundred samples.
   * One divergence is the minimal non-degeneracy evidence; the agreement bound
   * keeps doing the safety work.
   */
  minInformative: number;
}

/** Standard gate for behavioural low-risk points. */
export const LOW_RISK_GATE: PromotionGate = {
  minSamples: 30,
  minAgreement: 0.9,
  maxGrayRate: 0.2,
  maxParseRejectedRate: 0.05,
  maxServiceFailureRate: 0.1,
  minInformative: 1,
};

/** Stricter gate for high-risk points (tool/notify/channel gating). */
export const HIGH_RISK_GATE: PromotionGate = {
  minSamples: 60,
  minAgreement: 0.95,
  maxGrayRate: 0.15,
  maxParseRejectedRate: 0.02,
  maxServiceFailureRate: 0.05,
  minInformative: 1,
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

/**
 * Stable identifier for one failed gate condition. The UI localizes by code +
 * params; `message` is the English text the process log prints.
 */
export type GateReasonCode =
  | 'samples'
  | 'comparable'
  | 'agreement'
  | 'no-divergence'
  | 'gray-rate'
  | 'parse-rejected-rate'
  | 'unavailable-rate'
  | 'unusable-rate'
  | 'window-agreement';

export interface GateReason {
  code: GateReasonCode;
  /** English one-liner (logs, API consumers without i18n). */
  message: string;
  /** Numbers behind the verdict, for `t(key, params)` on the client. */
  params: Record<string, number | string>;
}

export interface GateVerdict {
  pass: boolean;
  reasons: GateReason[];
}

function reason(code: GateReasonCode, message: string, params: GateReason['params']): GateReason {
  return { code, message, params };
}

export function agreementRate(s: PointStats): number | undefined {
  return s.comparable > 0 ? s.agreed / s.comparable : undefined;
}

/** One-sided 95% z (1.645) — the width every gate interval is built on. */
export const GATE_Z = 1.645;

/**
 * Wilson score interval, lower bound. Used for a claim we must not overstate:
 * promoting after 10 agreed decisions is noise, and the point estimate (100%)
 * says nothing about the next 10. A lower bound does.
 */
export function wilsonLowerBound(successes: number, n: number, z = GATE_Z): number {
  if (n <= 0) return 0;
  const p = successes / n;
  const z2 = z * z;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return Math.max(0, (centre - margin) / (1 + z2 / n));
}

function rate(part: number, total: number): number {
  return total > 0 ? part / total : 0;
}

/**
 * Promotion gate — every condition must hold at once.
 *
 * Two independent sample floors:
 * - `total` (all real-session entries) guards the failure-rate ceilings below;
 * - `comparable` (entries carrying an outcome-vs-floor comparison) guards the
 *   agreement claim. Before this, 10 comparables were enough to pass a
 *   90%/95% agreement bar no matter how many gray entries surrounded them.
 *
 * Agreement is checked as a Wilson LOWER bound, so a lucky run of 12
 * agreements cannot promote a point. The failure ceilings keep their point
 * estimates on purpose: at the sample floors (30/60) a one-sided upper bound
 * would cost ~9pp of headroom on a 15%/20% cap and put promotion out of reach
 * of any realistic traffic — and unlike agreement, a high failure rate is
 * already self-limiting (it also shrinks `comparable`).
 */
export function checkPromotionGate(s: PointStats, gate: PromotionGate): GateVerdict {
  const reasons: GateReason[] = [];
  if (s.total < gate.minSamples)
    reasons.push(
      reason('samples', `samples ${s.total} < ${gate.minSamples}`, {
        total: s.total,
        min: gate.minSamples,
      }),
    );
  if (s.comparable < gate.minSamples) {
    reasons.push(
      reason('comparable', `comparable ${s.comparable} < ${gate.minSamples}`, {
        comparable: s.comparable,
        min: gate.minSamples,
      }),
    );
  } else {
    const lower = wilsonLowerBound(s.agreed, s.comparable);
    if (lower < gate.minAgreement) {
      reasons.push(
        reason(
          'agreement',
          `agreement ${(lower * 100).toFixed(1)}% (lower bound of ${s.agreed}/${s.comparable}) < ${(gate.minAgreement * 100).toFixed(0)}%`,
          {
            rate: (lower * 100).toFixed(1),
            agreed: s.agreed,
            comparable: s.comparable,
            min: (gate.minAgreement * 100).toFixed(0),
          },
        ),
      );
    }
    // Agreement with the floor only means something once the judge has shown
    // it can go the other way: 100% agreement over 30+ comparisons is either
    // a judge that always defers to the floor (promotion = pure token cost) or
    // a floor that is never wrong (nothing to promote).
    const informative = s.comparable - s.agreed;
    if (informative < gate.minInformative)
      reasons.push(
        reason(
          'no-divergence',
          `informative comparisons ${informative} < ${gate.minInformative} (shadow never diverged from the floor)`,
          { informative, min: gate.minInformative, comparable: s.comparable },
        ),
      );
  }
  const gray = rate(s.gray, s.total);
  if (gray > gate.maxGrayRate)
    reasons.push(
      reason(
        'gray-rate',
        `gray rate ${(gray * 100).toFixed(1)}% > ${(gate.maxGrayRate * 100).toFixed(0)}%`,
        { rate: (gray * 100).toFixed(1), max: (gate.maxGrayRate * 100).toFixed(0) },
      ),
    );
  const rejected = rate(s.parseRejected, s.total);
  if (rejected > gate.maxParseRejectedRate)
    reasons.push(
      reason(
        'parse-rejected-rate',
        `parse-rejected rate ${(rejected * 100).toFixed(1)}% > ${(gate.maxParseRejectedRate * 100).toFixed(0)}%`,
        { rate: (rejected * 100).toFixed(1), max: (gate.maxParseRejectedRate * 100).toFixed(0) },
      ),
    );
  const unavailable = rate(s.serviceFailure, s.total);
  if (unavailable > gate.maxServiceFailureRate)
    reasons.push(
      reason(
        'unavailable-rate',
        `unavailable rate ${(unavailable * 100).toFixed(1)}% > ${(gate.maxServiceFailureRate * 100).toFixed(0)}%`,
        {
          rate: (unavailable * 100).toFixed(1),
          max: (gate.maxServiceFailureRate * 100).toFixed(0),
        },
      ),
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
  const reasons: GateReason[] = [];
  const unusable = rate(window.gray + window.serviceFailure + window.parseRejected, window.total);
  if (window.total >= minSamples && unusable > maxGrayRate)
    reasons.push(
      reason(
        'unusable-rate',
        `unusable rate ${(unusable * 100).toFixed(1)}% > ${(maxGrayRate * 100).toFixed(0)}%`,
        { rate: (unusable * 100).toFixed(1), max: (maxGrayRate * 100).toFixed(0) },
      ),
    );
  const agreement = agreementRate(window);
  if (window.comparable >= minSamples && agreement !== undefined && agreement < minAgreement)
    reasons.push(
      reason(
        'window-agreement',
        `agreement ${(agreement * 100).toFixed(1)}% < ${(minAgreement * 100).toFixed(0)}%`,
        { rate: (agreement * 100).toFixed(1), min: (minAgreement * 100).toFixed(0) },
      ),
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
  reasons: GateReason[];
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
    let reasons: GateReason[] = [];

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
