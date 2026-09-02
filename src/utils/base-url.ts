/**
 * Helpers for normalizing OpenAI-compatible base URLs.
 *
 * Some providers (e.g. opencode) expose a built-in provider base URL without
 * the `/v1` path segment (e.g. `https://opencode.ai/zen`), while individual
 * models and the OpenAI SDK expect the endpoint under `.../v1`. Appending `/v1`
 * only when it is missing keeps already-correct URLs intact and leaves
 * non-OpenAI providers (Anthropic, Gemini, Bedrock, …) untouched.
 */

/** API types whose endpoints live under a `/v1` path (OpenAI-compatible). */
const OPENAI_COMPAT_APIS = new Set<string>([
  'openai-chat',
  'openai-completions',
  'openai-responses',
  'openai-codex-responses',
  'openai-embeddings',
  'openai-images',
  'openai-audio',
  'openai-realtime',
  'azure-openai-responses',
  'mistral-conversations',
]);

/**
 * Intelligently ensure an OpenAI-compatible base URL ends with `/v1`.
 * - Already ends with `/v1` → unchanged.
 * - `api` provided and not OpenAI-compatible → unchanged (protects native
 *   Anthropic/Gemini which append their own version segment).
 * - Already points at a concrete endpoint (`/chat/completions`, `/models`, …)
 *   → unchanged.
 */
export function ensureV1BaseUrl(baseUrl?: string, api?: string): string | undefined {
  if (!baseUrl) return baseUrl;
  if (api && !OPENAI_COMPAT_APIS.has(api)) return baseUrl;
  const trimmed = baseUrl.replace(/\/+$/, '');
  if (/\/v1$/i.test(trimmed)) return baseUrl;
  if (
    /(chat\/completions|embeddings|completions|images|audio|responses|messages|models)$/i.test(
      trimmed,
    )
  ) {
    return baseUrl;
  }
  return `${trimmed}/v1`;
}
