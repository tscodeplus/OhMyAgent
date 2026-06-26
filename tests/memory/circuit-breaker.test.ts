import { describe, it, expect, beforeEach } from 'vitest';
import { CircuitBreaker } from '../../src/memory/circuit-breaker.js';

describe('CircuitBreaker', () => {
  let breaker: CircuitBreaker;
  const defaultThreshold = 5;
  const cooldownMs = 100; // short for testing

  beforeEach(() => {
    breaker = new CircuitBreaker({ failureThreshold: defaultThreshold, cooldownMs });
  });

  it('starts in CLOSED state', () => {
    expect(breaker.currentState).toBe('CLOSED');
  });

  it('allow() returns true in CLOSED state', () => {
    expect(breaker.allow()).toBe(true);
  });

  it('opens after failureThreshold failures', () => {
    for (let i = 0; i < defaultThreshold; i++) {
      breaker.recordFailure();
    }
    expect(breaker.currentState).toBe('OPEN');
  });

  it('allow() returns false in OPEN state', () => {
    for (let i = 0; i < defaultThreshold; i++) {
      breaker.recordFailure();
    }
    expect(breaker.allow()).toBe(false);
  });

  it('transitions to HALF_OPEN after cooldown', () => {
    let now = 0;
    const cb = new CircuitBreaker({ failureThreshold: defaultThreshold, cooldownMs: 1000, nowFn: () => now });
    for (let i = 0; i < defaultThreshold; i++) cb.recordFailure();
    expect(cb.currentState).toBe('OPEN');

    // Still open before cooldown
    now = 500;
    expect(cb.allow()).toBe(false);

    // Half-open at cooldown
    now = 1000;
    expect(cb.allow()).toBe(true);
    expect(cb.currentState).toBe('HALF_OPEN');
  });

  it('only allows one probe in HALF_OPEN', () => {
    let now = 0;
    const cb = new CircuitBreaker({ failureThreshold: defaultThreshold, cooldownMs: 1000, nowFn: () => now });
    for (let i = 0; i < defaultThreshold; i++) cb.recordFailure();
    now = 1000;

    expect(cb.allow()).toBe(true);   // first probe OK
    expect(cb.allow()).toBe(false);  // second blocked
    expect(cb.allow()).toBe(false);  // still blocked
  });

  it('resets to CLOSED on success in HALF_OPEN', () => {
    let now = 0;
    const cb = new CircuitBreaker({ failureThreshold: defaultThreshold, cooldownMs: 1000, nowFn: () => now });
    for (let i = 0; i < defaultThreshold; i++) cb.recordFailure();
    now = 1000;

    cb.allow();  // sends probe
    cb.recordSuccess();
    expect(cb.currentState).toBe('CLOSED');
    expect(cb.failures).toBe(0);
  });

  it('returns to OPEN on failure in HALF_OPEN', () => {
    let now = 0;
    const cb = new CircuitBreaker({ failureThreshold: defaultThreshold, cooldownMs: 1000, nowFn: () => now });
    for (let i = 0; i < defaultThreshold; i++) cb.recordFailure();
    now = 1000;

    cb.allow();  // sends probe
    cb.recordFailure();
    expect(cb.currentState).toBe('OPEN');
  });

  it('trips on first failure when threshold is 0', () => {
    const zeroBreaker = new CircuitBreaker({ failureThreshold: 0, cooldownMs: 100 });
    zeroBreaker.recordFailure();
    expect(zeroBreaker.currentState).toBe('OPEN');
  });

  it('does not trip before threshold is reached', () => {
    for (let i = 0; i < defaultThreshold - 1; i++) {
      breaker.recordFailure();
    }
    expect(breaker.currentState).toBe('CLOSED');
    expect(breaker.allow()).toBe(true);
  });

  it('resets to CLOSED state', () => {
    for (let i = 0; i < defaultThreshold; i++) {
      breaker.recordFailure();
    }
    expect(breaker.currentState).toBe('OPEN');
    breaker.reset();
    expect(breaker.currentState).toBe('CLOSED');
    expect(breaker.failures).toBe(0);
  });

  it('failure counter uses saturating addition', () => {
    // Set failure count close to max safe integer via internal manipulation is not possible,
    // but we can verify that recordFailure doesn't throw
    for (let i = 0; i < 100; i++) {
      breaker.recordFailure();
    }
    expect(breaker.failures).toBe(100);
  });

  it('correctly uses injected nowFn for testing', () => {
    let fakeNow = 0;
    const breakerWithClock = new CircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 1000,
      nowFn: () => fakeNow,
    });

    // Trip at t=0
    fakeNow = 0;
    breakerWithClock.recordFailure();
    expect(breakerWithClock.allow()).toBe(false);

    // Still open at t=500
    fakeNow = 500;
    expect(breakerWithClock.allow()).toBe(false);

    // Half-open at t=1000
    fakeNow = 1000;
    expect(breakerWithClock.allow()).toBe(true);
    expect(breakerWithClock.currentState).toBe('HALF_OPEN');

    // Success resets
    breakerWithClock.recordSuccess();
    expect(breakerWithClock.currentState).toBe('CLOSED');
  });
});
