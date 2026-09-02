/**
 * Race a promise against a timeout, ALWAYS clearing the timer afterward.
 *
 * `Promise.race([work, setTimeout(...)])` leaks the pending timer when `work`
 * settles first: the timer stays armed until it fires, keeping the event loop
 * alive and, on hot paths, accumulating thousands of live timers. This helper
 * clears the timer in a finally block regardless of outcome.
 *
 * @param work       The promise to run.
 * @param timeoutMs  Milliseconds before rejecting with a timeout error.
 * @param message    Error message used when the timeout wins.
 */
export async function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  message = 'Operation timed out',
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Race an agent's waitForIdle() against a bounded grace period.
 *
 * Same timer-cleanup discipline as `withTimeout`, but designed for
 * cooperative aborts: after abort() the run loop unwinds only if the
 * in-flight tool responds to the AbortSignal. A tool stuck in a hung
 * operation never settles, so callers need a bounded wait — returning
 * true when the run converged in time, false when the wait was
 * abandoned (the caller then logs a warning and moves on).
 *
 * Rejections count as settled (true) — the caller handles the error.
 */
export async function waitForIdleWithTimeout(
  waitForIdle: () => Promise<void>,
  settleTimeoutMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      waitForIdle().then(
        () => true,
        () => true,
      ),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), settleTimeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
