/**
 * Structural equality for `DecisionOutcome` values (src/judge/types.ts).
 *
 * The autopilot (src/judge/autopilot.ts) compares what active mode WOULD
 * decide against the pre-judge floor; both are producer-constructed object
 * literals, so key order can differ across sites — compare normalized.
 */
import type { DecisionOutcome } from './types.js';

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const rec = v as Record<string, unknown>;
    return `{${Object.keys(rec)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(rec[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'undefined';
}

export function outcomeEquals(a: DecisionOutcome, b: DecisionOutcome): boolean {
  if (a === b) return true;
  if (a.action !== b.action) return false;
  return stableStringify(a) === stableStringify(b);
}

/**
 * True when sessionId looks like a real conversation session (UUID shell).
 * Diagnostics / probes / test writes use names like `diag-ping` or `s1`; those
 * must never feed the autopilot's promotion statistics.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isRealSessionId(sessionId: string): boolean {
  return UUID_RE.test(sessionId);
}
