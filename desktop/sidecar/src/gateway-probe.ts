/**
 * Gateway reachability probe — runs in the sidecar (Node), not in the page.
 *
 * Why it lives here instead of in the WebView's `fetch`: a cross-origin GET
 * carrying an `Authorization` header needs an OPTIONS preflight first, and a
 * gateway whose auth hook runs before its CORS plugin answers that preflight
 * with 401 (this repo did exactly that until webui-auth learned to let
 * preflights through — and every gateway deployed before that fix still does).
 * The page then sees a thrown fetch and reports "token invalid" for a token
 * that is perfectly good. Node's fetch sends no Origin header, so no preflight
 * happens and the verdict is about the token alone.
 *
 * The shell answers the same two questions before revealing the main window
 * (src-tauri/src/sidecar.rs `check_remote_health`); this copy exists for the
 * *interactive* test buttons, which are driven from the page.
 */

export type GatewayProbeResult =
  /** Reachable and the token was accepted. */
  | { code: 'ok'; version: string }
  /** Reachable, but the gateway rejected the token (or none was given). */
  | { code: 'invalidToken'; version: string }
  /** Never got a usable answer: DNS, timeout, refused, HTTP error. */
  | { code: 'unreachable'; detail?: string };

export interface ProbeOptions {
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Users paste what they see, so accept a bare host too (`192.168.1.100:9191`)
 * and assume http — a LAN gateway serves plain http; https works as typed.
 */
function normalizeBase(rawUrl: string): string | null {
  const trimmed = (rawUrl ?? '').trim().replace(/\/+$/, '');
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const parsed = new URL(withScheme);
    if (!parsed.hostname) return null;
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    // AbortSignal.timeout rejects with 'TimeoutError'; its message is noisy.
    if (err.name === 'TimeoutError') return 'timeout';
    return err.message;
  }
  return String(err);
}

export async function probeGateway(
  rawUrl: string,
  rawToken: string,
  opts: ProbeOptions = {},
): Promise<GatewayProbeResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const base = normalizeBase(rawUrl);
  if (!base) return { code: 'unreachable', detail: 'invalid url' };
  const token = (rawToken ?? '').trim();

  let version = '?';
  try {
    const res = await doFetch(`${base}/api/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { code: 'unreachable', detail: `HTTP ${res.status}` };
    try {
      const data = (await res.json()) as { version?: string } | null;
      if (data?.version) version = data.version;
    } catch {
      /* reachable even if health is not JSON */
    }
  } catch (err) {
    return { code: 'unreachable', detail: describe(err) };
  }

  // No token means nothing to verify — the gateway is online, the config is not
  // usable yet, which is what the caller reports as an invalid token.
  if (!token) return { code: 'invalidToken', version };

  try {
    const res = await doFetch(`${base}/api/auth/verify`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    // 401/403 is the auth hook rejecting the token before the route runs; the
    // route itself answers 200 { valid: false } when a token reaches it.
    if (res.status === 401 || res.status === 403) return { code: 'invalidToken', version };
    if (!res.ok) return { code: 'unreachable', detail: `HTTP ${res.status}` };
    try {
      const data = (await res.json()) as { valid?: boolean } | null;
      if (data && data.valid === false) return { code: 'invalidToken', version };
    } catch {
      /* a 2xx without a body is still an accepted token */
    }
    return { code: 'ok', version };
  } catch (err) {
    return { code: 'unreachable', detail: describe(err) };
  }
}
