import type { InboxMessagesQuery, InboxPage, InboxQuery, InboxSessionDetail } from '../types/inbox';

const TOKEN_KEY = 'ohmyagent_token';

/** Default request timeout (10s) to prevent hanging when remote gateway is unreachable. */
const DEFAULT_TIMEOUT_MS = 10_000;

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export interface ApiError {
  status: number;
  message: string;
}

export async function apiRequest<T>(
  path: string,
  options: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  const token = getToken();
  const hasBody = !!options.body;
  const headers: Record<string, string> = {
    ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
    ...((options.headers as Record<string, string>) || {}),
  };

  if (token && !headers['Authorization']) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  // Apply timeout via AbortController (respects any caller-supplied signal)
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const originalSignal = options.signal;
  if (originalSignal) {
    originalSignal.addEventListener('abort', () => controller.abort());
  }

  try {
    const response = await fetch(path, {
      ...options,
      headers,
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({ message: response.statusText }));
      throw {
        status: response.status,
        message: body.message || body.error || response.statusText,
      } as ApiError;
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

export function createSWRFetcher<T>() {
  return async (url: string): Promise<T> => {
    return apiRequest<T>(url);
  };
}

/** Build a `?a=1&b=2` suffix, skipping params the caller left undefined or empty. */
function queryString(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : '';
}

/**
 * IM inbox listing. Errors surface as `ApiError` like every other endpoint, so
 * callers use the same try/catch-and-toast style as the rest of the app.
 */
export function fetchInbox(params: InboxQuery = {}): Promise<InboxPage> {
  return apiRequest<InboxPage>(
    `/api/inbox${queryString({ channel: params.channel, limit: params.limit, before: params.before })}`,
  );
}

/** One page of an IM session's transcript (404 when the id is not an IM session). */
export function fetchInboxSession(
  id: string,
  params: InboxMessagesQuery = {},
): Promise<InboxSessionDetail> {
  return apiRequest<InboxSessionDetail>(
    `/api/inbox/${encodeURIComponent(id)}/messages${queryString({ limit: params.limit, before: params.before })}`,
  );
}
