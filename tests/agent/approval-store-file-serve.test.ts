import { describe, it, expect, vi } from 'vitest';
import { PendingApprovalStore } from '../../src/agent/approval-store';

/**
 * Report #6b option B: when a human approves a file-access approval that
 * carries a serve path, the store fires onFileServeApproved so the WebUI
 * file-serve allowlist learns the path. Rejects, timeouts and non-file
 * approvals must never fire it.
 */

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} } as never;

describe('PendingApprovalStore onFileServeApproved hook', () => {
  it('fires with the path when a file-access approval is approved', async () => {
    const onFileServeApproved = vi.fn();
    const store = new PendingApprovalStore({ onFileServeApproved, timeoutAction: 'deny' });

    const decision = store.create('req-1', 60_000, undefined, 'session-1', undefined, 'low', {
      targetKind: 'tool',
      fileServePath: '/tmp/screenshot.png',
    });
    store.resolve('req-1', 'approve_once');
    await decision;

    expect(onFileServeApproved).toHaveBeenCalledTimes(1);
    expect(onFileServeApproved).toHaveBeenCalledWith({
      path: '/tmp/screenshot.png',
      requestId: 'req-1',
    });
  });

  it('does not fire on reject', async () => {
    const onFileServeApproved = vi.fn();
    const store = new PendingApprovalStore({ onFileServeApproved, timeoutAction: 'deny' });

    const decision = store.create('req-2', 60_000, undefined, 'session-1', undefined, 'low', {
      targetKind: 'tool',
      fileServePath: '/tmp/screenshot.png',
    });
    store.resolve('req-2', 'reject_once');
    await decision;

    expect(onFileServeApproved).not.toHaveBeenCalled();
  });

  it('does not fire for approvals without a serve path', async () => {
    const onFileServeApproved = vi.fn();
    const store = new PendingApprovalStore({ onFileServeApproved, timeoutAction: 'deny' });

    const decision = store.create('req-3', 60_000, undefined, 'session-1', 'rm -rf /', 'high', {
      targetKind: 'shell',
    });
    store.resolve('req-3', 'approve_once');
    await decision;

    expect(onFileServeApproved).not.toHaveBeenCalled();
  });

  it('fires via resolveFirstForSession bulk path', async () => {
    const onFileServeApproved = vi.fn();
    const store = new PendingApprovalStore({ onFileServeApproved, timeoutAction: 'deny' });

    const decision = store.create('req-4', 60_000, undefined, 'session-9', undefined, 'low', {
      targetKind: 'tool',
      fileServePath: '/var/log/app.log',
    });
    expect(store.resolveFirstForSession('session-9', 'approve_session')).toBe(true);
    await decision;

    expect(onFileServeApproved).toHaveBeenCalledWith({
      path: '/var/log/app.log',
      requestId: 'req-4',
    });
  });

  it('never fires via the timeout auto-approve path', async () => {
    vi.useFakeTimers();
    try {
      const onFileServeApproved = vi.fn();
      const store = new PendingApprovalStore({ onFileServeApproved, timeoutAction: 'allow' });

      const decision = store.create('req-5', 1_000, undefined, 'session-1', undefined, 'low', {
        targetKind: 'tool',
        fileServePath: '/tmp/screenshot.png',
      });
      vi.advanceTimersByTime(1_100);
      await decision;

      // timeout_allow resolves approve_once, but an unattended expiry is not
      // a human decision — the file-serve grant must not fire.
      expect(onFileServeApproved).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('hook failures do not break the approval flow', async () => {
    const store = new PendingApprovalStore({
      onFileServeApproved: () => {
        throw new Error('grant failed');
      },
      timeoutAction: 'deny',
    });

    const decision = store.create('req-6', 60_000, undefined, 'session-1', undefined, 'low', {
      targetKind: 'tool',
      fileServePath: '/tmp/x.png',
    });
    expect(() => store.resolve('req-6', 'approve_once')).not.toThrow();
    await expect(decision).resolves.toBe('approve_once');
  });

  it('unknown logger argument shape is tolerated (smoke)', () => {
    // Guards against accidental strictness on the store constructor used by
    // older call sites that only pass timeoutAction.
    expect(() => new PendingApprovalStore({ timeoutAction: 'deny' })).not.toThrow();
    void noopLogger;
  });
});
