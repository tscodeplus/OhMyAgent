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

// ---------------------------------------------------------------------------
// Object path helpers
// ---------------------------------------------------------------------------

/** Get a nested value from an object by dot-notation path. */
export function getByPath(obj: any, path: string): any {
  if (!obj || !path) return undefined;
  const parts = path.split('.');
  let current = obj;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = current[part];
  }
  return current;
}

/** Set a nested value on an object by dot-notation path, creating intermediate objects as needed. */
export function setByPath(obj: Record<string, any>, path: string, value: any): void {
  const parts = path.split('.');
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!(parts[i] in current) || typeof current[parts[i]] !== 'object') {
      current[parts[i]] = {};
    }
    current = current[parts[i]];
  }
  current[parts[parts.length - 1]] = value;
}
