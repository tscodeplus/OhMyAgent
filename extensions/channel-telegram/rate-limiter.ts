/**
 * Sliding-window rate limiter.
 * Used by webhook handler to prevent abuse.
 */
export class SlidingWindowRateLimiter {
  private store = new Map<string, number[]>();
  private maxRequests: number;
  private windowMs: number;
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor(maxRequests: number, windowMs: number) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000);
    if ('unref' in this.cleanupTimer) {
      this.cleanupTimer.unref();
    }
  }

  check(key: string): boolean {
    const now = Date.now();
    const windowStart = now - this.windowMs;

    let timestamps = this.store.get(key);
    if (!timestamps) {
      timestamps = [];
      this.store.set(key, timestamps);
    }

    const valid = timestamps.filter(t => t > windowStart);
    if (valid.length >= this.maxRequests) {
      this.store.set(key, valid);
      return false;
    }

    valid.push(now);
    this.store.set(key, valid);
    return true;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, timestamps] of this.store.entries()) {
      const valid = timestamps.filter(t => t > now - this.windowMs);
      if (valid.length === 0) {
        this.store.delete(key);
      } else {
        this.store.set(key, valid);
      }
    }
  }

  destroy(): void {
    clearInterval(this.cleanupTimer);
    this.store.clear();
  }
}
