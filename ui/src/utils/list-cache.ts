/**
 * The last pages the sidebar rendered, remembered by key.
 *
 * On a phone the whole left tray is mounted fresh every time the drawer opens
 * (`{mobileSidebar && <drawer>}`), so each list started at `loading = true` and
 * spun while it re-read a page it had just shown — a round trip that costs about
 * a second behind a tunnel. Seeding the first render from here keeps that paint
 * instant; the fetch that follows refreshes silently.
 *
 * The shelf life only bounds how stale the seeded paint may be, and a reader
 * with a short window must never take an entry away from one with a longer
 * window: that eviction is what made every second drawer open a cold start.
 */
export const LIST_CACHE_TTL_MS = 10 * 60_000;

const store = new Map<string, { data: unknown; at: number }>();

/** Remember a page, or forget it when passed `undefined`. */
export function rememberList<T>(key: string, data: T | undefined): void {
  if (data === undefined) {
    store.delete(key);
    return;
  }
  store.set(key, { data, at: Date.now() });
}

/** The remembered page plus its age, or `undefined` past `maxAgeMs`. */
export function readList<T>(
  key: string,
  maxAgeMs = LIST_CACHE_TTL_MS,
): { data: T; ageMs: number } | undefined {
  const entry = store.get(key);
  if (!entry) return undefined;
  const ageMs = Date.now() - entry.at;
  if (ageMs > maxAgeMs) {
    // Drop it only once nobody may use it any more.
    if (ageMs > LIST_CACHE_TTL_MS) store.delete(key);
    return undefined;
  }
  return { data: entry.data as T, ageMs };
}

/** Forget one key. */
export function forgetList(key: string): void {
  store.delete(key);
}
