import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QQAuth } from '../../extensions/channel-qq/qq-auth.js';

function fakeLogger(): any {
  const l: any = {
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
    child: () => l,
  };
  return l;
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('QQAuth — access token caching & refresh', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('requests a token on first call and caches it on the second', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ access_token: 'tok-1', expires_in: 7200 }),
    );
    const auth = new QQAuth('app', 'secret', false, fakeLogger());

    expect(await auth.getAccessToken()).toBe('tok-1');
    expect(await auth.getAccessToken()).toBe('tok-1'); // cached
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('refreshes when the cached token is within 10 min of expiry', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ access_token: 'tok-1', expires_in: 300 })) // 5 min
      .mockResolvedValueOnce(jsonResponse({ access_token: 'tok-2', expires_in: 7200 }));
    const auth = new QQAuth('app', 'secret', false, fakeLogger());

    expect(await auth.getAccessToken()).toBe('tok-1');
    // Within the 10-min refresh threshold → must re-request, not serve stale.
    expect(await auth.getAccessToken()).toBe('tok-2');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('throws with status + body when the auth endpoint fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ message: 'bad creds' }, false, 401),
    );
    const auth = new QQAuth('app', 'secret', false, fakeLogger());
    await expect(auth.getAccessToken()).rejects.toThrow(/401/);
  });

  it('clearCache forces a fresh token request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ access_token: 'tok-1', expires_in: 7200 }),
    );
    const auth = new QQAuth('app', 'secret', false, fakeLogger());
    await auth.getAccessToken();
    auth.clearCache();
    await auth.getAccessToken();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe('QQAuth — environment routing', () => {
  it('uses the sandbox API base when sandbox=true', () => {
    const auth = new QQAuth('app', 'secret', true, fakeLogger());
    expect(auth.getApiBase()).toContain('sandbox');
  });

  it('uses the production API base when sandbox=false', () => {
    const auth = new QQAuth('app', 'secret', false, fakeLogger());
    expect(auth.getApiBase()).toBe('https://api.sgroup.qq.com');
  });
});
