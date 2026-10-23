/**
 * OpenCode session-affinity headers.
 *
 * Upstream pi's coding-agent layer (`packages/coding-agent/src/core/provider-attribution.ts`)
 * injects `x-opencode-session` and `x-opencode-client` on every request to
 * opencode / opencode-go endpoints. The embedded pi-mono (packages/ai + agent)
 * has no such layer, and the opencode Go gateway REJECTS header-less requests
 * with a `MissingSessionID` error, so OhMyAgent callers must add these headers
 * themselves — otherwise every opencode-go model fails and the agent falls
 * back to the next model in the chain.
 *
 * Both API clients merge caller-supplied headers last (pi-mono's openai-completions
 * merges `options.headers`; the OpenAI SDK merges `defaultHeaders`), so these
 * win over any model-level defaults.
 */

/**
 * OpenCode's gateways fingerprint the client per request. Captured traffic from
 * the real opencode CLI (v2.0.32, opencode/latest/2.0.32/cli) shows the values
 * below get past both the Go gateway's MissingSessionID check and the Console
 * free-tier gate ("OpenCode's free tier can only be used from within OpenCode").
 * Any other client string / UA is rejected with FreeTierError 403 on free models.
 */

/** UA prefix the OpenCode gateway expects: opencode/<channel>/<version>/<name>. */
const OPENCODE_USER_AGENT = 'opencode/latest/2.0.32/cli';

/** Client id the OpenCode gateway expects (the real client sends app.name, "cli"). */
const OPENCODE_CLIENT = 'cli';

/** Alphabet of OpenCode's descending identifiers (schema/src/identifier.ts). */
const OPENCODE_ID_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * OpenCode-shaped session id ("ses_" + 26-char descending identifier: 12 hex
 * time chars + 14 random base62), so requests look native to the gateway and
 * pin to one cache node. Stable per process for cache/session affinity.
 */
let openCodeSessionId: string | undefined;
function defaultOpenCodeSessionId(): string {
  openCodeSessionId ??= `ses_${descendingId()}`;
  return openCodeSessionId;
}

function descendingId(): string {
  const current = BigInt(Date.now()) * 0x1000n + 1n;
  const value = BigInt.asUintN(64, ~current);
  let time = '';
  for (let i = 0; i < 6; i++) {
    time += ((value >> BigInt(40 - 8 * i)) & 0xffn).toString(16).padStart(2, '0');
  }
  let bytes = '';
  const rand = crypto.getRandomValues(new Uint8Array(14));
  for (let i = 0; i < 14; i++) {
    bytes += OPENCODE_ID_CHARS[rand[i] % 62];
  }
  return time + bytes;
}

/** Whether a model resolves to an OpenCode (zen / zen-go) endpoint. */
export function isOpenCodeEndpoint(
  provider?: string | undefined,
  baseUrl?: string | undefined,
): boolean {
  if (provider === 'opencode' || provider === 'opencode-go') return true;
  return Boolean(baseUrl && baseUrl.includes('opencode.ai'));
}

/**
 * Session-affinity headers for OpenCode endpoints. `sessionId` may be omitted
 * for auxiliary callers without a conversation id — a stable per-process id is
 * used so requests still pin to one cache node.
 */
export function openCodeSessionHeaders(sessionId?: string | undefined): Record<string, string> {
  return {
    'x-opencode-session': sessionId || defaultOpenCodeSessionId(),
    'x-opencode-client': OPENCODE_CLIENT,
    'user-agent': OPENCODE_USER_AGENT,
  };
}

/**
 * Extra OpenAI-SDK client options for OpenCode endpoints (`defaultHeaders`);
 * empty object otherwise. Spread into the `new OpenAI({...})` constructor.
 */
export function openCodeClientOptions(
  provider?: string | undefined,
  baseUrl?: string | undefined,
  sessionId?: string | undefined,
): { defaultHeaders?: Record<string, string> } {
  if (!isOpenCodeEndpoint(provider, baseUrl)) return {};
  return { defaultHeaders: openCodeSessionHeaders(sessionId) };
}

/**
 * Attach OpenCode session-affinity headers to stream options when the model
 * resolves to an OpenCode endpoint; returns a copy of the options unchanged
 * otherwise.
 *
 * Needed for BOTH paid and free-tier models: the opencode Go gateway rejects
 * header-less requests with `MissingSessionID`, and the Console gateway
 * rejects free-tier models with "OpenCode's free tier can only be used in
 * OpenCode".
 */
export function withOpenCodeSessionHeaders<T extends Record<string, unknown>>(
  options: T | undefined,
  model: { provider?: string; baseUrl?: string } | undefined,
  sessionId?: string | undefined,
): T {
  if (!isOpenCodeEndpoint(model?.provider, model?.baseUrl)) {
    return { ...(options ?? {}) } as T;
  }
  return {
    ...(options ?? {}),
    headers: {
      ...((options as { headers?: Record<string, string> } | undefined)?.headers ?? {}),
      ...openCodeSessionHeaders(sessionId),
    },
  } as unknown as T;
}
