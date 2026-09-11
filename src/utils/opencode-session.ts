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

/** Stable per-process session id for OpenCode cache/session affinity. */
const OPENCODE_SESSION_ID = `oma-${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;

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
    'x-opencode-session': sessionId || OPENCODE_SESSION_ID,
    'x-opencode-client': 'ohmyagent',
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
