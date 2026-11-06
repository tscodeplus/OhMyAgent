import { apiRequest } from './api';

/**
 * One shared `GET /api/config` per page load.
 *
 * The settings panel fetches the whole config once per tab it mounts (and keeps
 * every visited tab mounted), the notes layer fetches it on start, and the
 * language sync used to fetch it implicitly. Through a Cloudflare Tunnel each of
 * those is a round trip worth about a second, for a 15 KB document that changes
 * only when this page writes it — so they share one answer instead.
 *
 * The snapshot is short-lived and dropped by `putConfig`: it only has to span the
 * burst of reads that belongs to one page load, never to outlive a write.
 */
const TTL_MS = 20_000;

let snapshot: Record<string, unknown> | null = null;
let snapshotAt = 0;
/** In-flight read, so concurrent callers share one request instead of racing. */
let inFlight: Promise<Record<string, unknown>> | null = null;

/**
 * The current config document. `force` ignores the cached copy (used after a
 * write that did not go through `putConfig`).
 */
export function fetchConfig(force = false): Promise<Record<string, unknown>> {
  if (!force && snapshot && Date.now() - snapshotAt < TTL_MS) return Promise.resolve(snapshot);
  if (inFlight) return inFlight;

  inFlight = apiRequest<Record<string, unknown>>('/api/config')
    .then((config) => {
      snapshot = config;
      snapshotAt = Date.now();
      return config;
    })
    .finally(() => {
      // Cleared either way: a failed read must be retried by the next caller,
      // not remembered as this page's answer.
      inFlight = null;
    });
  return inFlight;
}

/** Drop the cached document (after any write to `config.yaml`). */
export function invalidateConfigCache(): void {
  snapshot = null;
  snapshotAt = 0;
}

/**
 * `PUT /api/config` with the dot-notation body the settings page already uses,
 * invalidating the snapshot so the writer's own follow-up read sees the write.
 */
export async function putConfig(payload: Record<string, unknown>): Promise<void> {
  await apiRequest('/api/config', { method: 'PUT', body: JSON.stringify(payload) });
  invalidateConfigCache();
}
