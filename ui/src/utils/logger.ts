/**
 * Dev-only logger. No-ops in production builds so per-delta console logging
 * doesn't slow down streaming rendering or leak conversation content to the
 * console. console.warn / console.error should still be used directly for
 * genuine problems.
 */
const enabled = import.meta.env.DEV;

export function devLog(...args: unknown[]): void {
  if (enabled) {
    console.log(...args);
  }
}
