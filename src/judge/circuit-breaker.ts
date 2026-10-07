/**
 * Per-decision-point circuit breaker (plan §9, impl doc §1 circuit-breaker.ts).
 *
 * 5 consecutive failed judge calls (service error/timeout/unreachable — NOT
 * parse-rejections of a healthy response, NOT gray-zone exhaustion) open the
 * circuit for 5 minutes; after the cooldown a probe is allowed through.
 * A healthy service that simply produces no verdict must never trip it.
 */

export type JudgeCircuitState = 'closed' | 'open' | 'half-open';

export interface JudgeBreakerState {
  pointId: string;
  state: JudgeCircuitState;
  consecutiveFailures: number;
  /** Epoch ms when the circuit opened; undefined while closed. */
  openedAt?: number;
}

export interface JudgeCircuitBreakerConfig {
  /** Consecutive service failures before opening. Default 5. */
  failureThreshold?: number;
  /** Open cooldown before the half-open probe. Default 300_000 (5 min). */
  cooldownMs?: number;
  /** Injectable for tests. */
  nowFn?: () => number;
}

interface PointEntry {
  state: JudgeCircuitState;
  failures: number;
  openedAt?: number;
}

export class JudgeCircuitBreaker {
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly nowFn: () => number;
  private readonly points = new Map<string, PointEntry>();

  constructor(config: JudgeCircuitBreakerConfig = {}) {
    this.failureThreshold = config.failureThreshold ?? 5;
    this.cooldownMs = config.cooldownMs ?? 5 * 60_000;
    this.nowFn = config.nowFn ?? (() => Date.now());
  }

  /**
   * True while the circuit blocks calls. An OPEN circuit whose cooldown has
   * elapsed transitions to half-open and lets the next call probe.
   */
  isOpen(pointId: string): boolean {
    const entry = this.points.get(pointId);
    if (!entry) return false;
    if (entry.state === 'open') {
      const elapsed = this.nowFn() - (entry.openedAt ?? 0);
      if (elapsed >= this.cooldownMs) {
        // Probe allowed: a success closes it, a failure re-opens.
        entry.state = 'half-open';
        return false;
      }
      return true;
    }
    // half-open already lets (concurrent) probes through — kept simple and
    // optimistic for M0; a failing probe re-opens immediately.
    return false;
  }

  /** A call ended in a fallback caused by service-level failures (error/timeout/abort). */
  recordFailure(pointId: string): void {
    const entry = this.points.get(pointId) ?? { state: 'closed' as JudgeCircuitState, failures: 0 };
    entry.failures += 1;
    if (entry.state === 'half-open' || entry.failures >= this.failureThreshold) {
      entry.state = 'open';
      entry.openedAt = this.nowFn();
    }
    this.points.set(pointId, entry);
  }

  /**
   * A judged (or gray-zone-exhausted) call that the service answered healthily:
   * resets the failure streak; a half-open probe closes the circuit.
   */
  recordSuccess(pointId: string): void {
    this.points.set(pointId, { state: 'closed', failures: 0 });
  }

  state(pointId: string): JudgeBreakerState {
    const entry = this.points.get(pointId);
    return {
      pointId,
      state: entry?.state ?? 'closed',
      consecutiveFailures: entry?.failures ?? 0,
      openedAt: entry?.openedAt,
    };
  }

  /** Snapshot for the status API. */
  states(): JudgeBreakerState[] {
    return [...this.points.keys()].map((pointId) => this.state(pointId));
  }
}
