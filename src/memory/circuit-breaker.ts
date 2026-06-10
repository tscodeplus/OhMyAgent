// src/memory/circuit-breaker.ts

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerConfig {
  /** Failure count to trip the breaker. Default 5. 0 means trip on first failure. */
  failureThreshold: number;
  /** Cooldown duration in ms before attempting recovery. Default 30_000 (30s). */
  cooldownMs: number;
  /** Current time function (injectable for testing). */
  nowFn?: () => number;
}

/**
 * Three-state circuit breaker:
 *   CLOSED -> (failures >= threshold) -> OPEN
 *   OPEN   -> (cooldown elapsed)       -> HALF_OPEN (allow one probe)
 *   HALF_OPEN -> (success)             -> CLOSED
 *   HALF_OPEN -> (failure)             -> OPEN
 */
export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private failureCount: number = 0;
  private openedAt: number = 0;
  private halfOpenProbeSent: boolean = false;
  private readonly config: Required<CircuitBreakerConfig>;

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    this.config = {
      failureThreshold: config.failureThreshold ?? 5,
      cooldownMs: config.cooldownMs ?? 30_000,
      nowFn: config.nowFn ?? (() => Date.now()),
    };
  }

  /**
   * Check whether a request is allowed through.
   * - CLOSED: always allow
   * - OPEN: allow only after cooldown expires (transitions to HALF_OPEN)
   * - HALF_OPEN: allow only one probe request
   */
  allow(): boolean {
    switch (this.state) {
      case 'CLOSED':
        return true;
      case 'OPEN': {
        const elapsed = this.config.nowFn() - this.openedAt;
        if (elapsed >= this.config.cooldownMs) {
          this.state = 'HALF_OPEN';
          this.halfOpenProbeSent = true;
          return true;  // first probe after cooldown
        }
        return false;
      }
      case 'HALF_OPEN':
        if (!this.halfOpenProbeSent) {
          this.halfOpenProbeSent = true;
          return true;
        }
        return false;  // probe already in flight
    }
  }

  /** Record a failure. Uses saturating addition to prevent overflow. */
  recordFailure(): void {
    this.failureCount = Math.min(this.failureCount + 1, Number.MAX_SAFE_INTEGER);

    if (this.state === 'HALF_OPEN') {
      this.state = 'OPEN';
      this.openedAt = this.config.nowFn();
    } else if (this.state === 'CLOSED' && this.failureCount >= this.config.failureThreshold) {
      this.state = 'OPEN';
      this.openedAt = this.config.nowFn();
    }
  }

  /** Record a success. Resets to CLOSED. */
  recordSuccess(): void {
    this.state = 'CLOSED';
    this.failureCount = 0;
    this.halfOpenProbeSent = false;
  }

  get currentState(): CircuitState { return this.state; }
  get failures(): number { return this.failureCount; }

  /** Force reset to initial state (for testing). */
  reset(): void {
    this.state = 'CLOSED';
    this.failureCount = 0;
    this.openedAt = 0;
    this.halfOpenProbeSent = false;
  }
}
