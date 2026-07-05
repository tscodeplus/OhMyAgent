// ---------------------------------------------------------------------------
// Tests for UserQuestionStore — event-driven user question resolution
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { UserQuestionStore } from '../../src/agent/user-question-store.js';

describe('UserQuestionStore', () => {
  let store: UserQuestionStore;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new UserQuestionStore({ defaultTimeoutMs: 5000 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('constructor', () => {
    it('uses provided defaultTimeoutMs', () => {
      const s = new UserQuestionStore({ defaultTimeoutMs: 10000 });
      expect(s.pendingCount).toBe(0);
    });

    it('defaults to 300000ms', () => {
      const s = new UserQuestionStore();
      expect(s.pendingCount).toBe(0);
    });
  });

  describe('create', () => {
    it('returns a Promise', () => {
      const promise = store.create('req-1');
      expect(promise).toBeInstanceOf(Promise);
    });

    it('increments pendingCount', () => {
      store.create('req-1');
      expect(store.pendingCount).toBe(1);
    });
  });

  describe('resolve', () => {
    it('resolves the waiting Promise with the answer', async () => {
      const promise = store.create('req-1');
      store.resolve('req-1', 'my answer');
      await expect(promise).resolves.toBe('my answer');
    });

    it('removes the entry from pending', async () => {
      const promise = store.create('req-1');
      expect(store.pendingCount).toBe(1);
      store.resolve('req-1', 'answer');
      await promise;
      expect(store.pendingCount).toBe(0);
    });

    it('returns false for unknown requestId', () => {
      expect(store.resolve('nonexistent', 'answer')).toBe(false);
    });

    it('returns true for valid requestId', () => {
      store.create('req-1');
      expect(store.resolve('req-1', 'answer')).toBe(true);
    });
  });

  describe('timeout', () => {
    it('auto-resolves with timeout message after defaultTimeoutMs', async () => {
      const promise = store.create('req-1');
      vi.advanceTimersByTime(5000);
      await expect(promise).resolves.toContain('[Timeout]');
    });

    it('uses custom timeoutMs when provided', async () => {
      const promise = store.create('req-1', 2000);
      // Should not resolve at 1000ms
      vi.advanceTimersByTime(1000);
      // promise is still pending
      vi.advanceTimersByTime(1000);
      await expect(promise).resolves.toContain('[Timeout]');
    });

    it('removes pending entry after timeout', async () => {
      const promise = store.create('req-1');
      vi.advanceTimersByTime(5000);
      await promise;
      expect(store.pendingCount).toBe(0);
    });
  });

  describe('hasPendingForSession', () => {
    it('returns true when session has pending question', () => {
      store.create('req-1', undefined, 'session-a');
      expect(store.hasPendingForSession('session-a')).toBe(true);
    });

    it('returns false when session has no pending question', () => {
      store.create('req-1', undefined, 'session-a');
      expect(store.hasPendingForSession('session-b')).toBe(false);
    });

    it('returns false when no pending questions exist', () => {
      expect(store.hasPendingForSession('any')).toBe(false);
    });
  });

  describe('findPendingForSession', () => {
    it('returns the requestId for the session', () => {
      store.create('req-abc', undefined, 'session-x');
      expect(store.findPendingForSession('session-x')).toBe('req-abc');
    });

    it('returns undefined for session with no pending', () => {
      store.create('req-1', undefined, 'session-a');
      expect(store.findPendingForSession('session-b')).toBeUndefined();
    });
  });

  describe('rejectAllForSession', () => {
    it('rejects all pending questions for the session', async () => {
      const p1 = store.create('req-1', undefined, 'session-a');
      const p2 = store.create('req-2', undefined, 'session-a');
      store.create('req-3', undefined, 'session-b');

      const count = store.rejectAllForSession('session-a', 'stopped');

      expect(count).toBe(2);
      await expect(p1).resolves.toContain('[Cancelled] stopped');
      await expect(p2).resolves.toContain('[Cancelled] stopped');
      // session-b should be unaffected
      expect(store.pendingCount).toBe(1);
    });

    it('returns 0 when session has no pending', () => {
      expect(store.rejectAllForSession('nonexistent')).toBe(0);
    });

    it('defaults reason to "cancelled"', async () => {
      const p = store.create('req-1', undefined, 'session-a');
      store.rejectAllForSession('session-a');
      await expect(p).resolves.toBe('[Cancelled] cancelled');
    });
  });

  describe('pendingCount', () => {
    it('tracks active pending count', () => {
      expect(store.pendingCount).toBe(0);
      store.create('a');
      store.create('b');
      expect(store.pendingCount).toBe(2);
    });
  });

  describe('multiple concurrent questions', () => {
    it('handles independent resolution', async () => {
      const p1 = store.create('req-1');
      const p2 = store.create('req-2');
      const p3 = store.create('req-3');

      store.resolve('req-2', 'second');
      store.resolve('req-1', 'first');
      store.resolve('req-3', 'third');

      await expect(p1).resolves.toBe('first');
      await expect(p2).resolves.toBe('second');
      await expect(p3).resolves.toBe('third');
    });

    it('double resolve is a no-op on the second call', async () => {
      const p = store.create('req-1');
      store.resolve('req-1', 'first');
      expect(store.resolve('req-1', 'second')).toBe(false);
      await expect(p).resolves.toBe('first');
    });
  });
});
