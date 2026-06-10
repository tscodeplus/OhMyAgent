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
  options: RequestInit = {}
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
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
      throw { status: response.status, message: body.message || 'Request failed' } as ApiError;
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
