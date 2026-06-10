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
