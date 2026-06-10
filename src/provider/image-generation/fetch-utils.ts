// ---------------------------------------------------------------------------
// Fetch utilities with proper timeout handling for Node.js undici
//
// IMPORTANT: We use the global fetch() (without a custom dispatcher) because:
// 1. Node.js v24+ global fetch correctly handles gzip/brotli decompression.
// 2. Passing a custom undici Agent as `dispatcher` silently disables
//    automatic Content-Encoding decompression on Node.js v26+, causing
//    responses to be returned as raw compressed bytes that fail JSON parse.
// 3. AbortSignal.timeout() provides adequate overall request timeout.
// ---------------------------------------------------------------------------

/**
 * fetch() wrapper with AbortSignal.timeout support.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit & { timeoutMs?: number },
): Promise<Response> {
  const { timeoutMs, ...fetchInit } = init;

  if (timeoutMs) {
    return fetch(url, { ...fetchInit, signal: AbortSignal.timeout(timeoutMs) });
  }
  return fetch(url, fetchInit);
}
