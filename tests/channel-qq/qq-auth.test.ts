import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QQAuth } from '../../extensions/channel-qq/qq-auth.js';

function fakeLogger(): any {
  const l: any = {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
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
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('requests a token on first call and caches it on the second', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ access_token: 'tok-1', expires_in: 7200 }));
    const auth = new QQAuth('app', 'secret', false, fakeLogger());

    expect(await auth.getAccessToken()).toBe('tok-1');
    expect(await auth.getAccessToken()).toBe('tok-1'); // cached
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('refreshes when the cached token is within 10 min of expiry', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
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
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ access_token: 'tok-1', expires_in: 7200 }));
    const auth = new QQAuth('app', 'secret', false, fakeLogger());
    await auth.getAccessToken();
    auth.clearCache();
    await auth.getAccessToken();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe('QQAuth — bot identity', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads the bot name from GET /users/@me', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ access_token: 'tok-1', expires_in: 7200 }))
      .mockResolvedValueOnce(jsonResponse({ id: '4266592316016549443', username: 'OMA' }));
    const auth = new QQAuth('app', 'secret', false, fakeLogger());

    expect((await auth.getBotIdentity()).username).toBe('OMA');

    const [url, init] = fetchSpy.mock.calls[1]!;
    expect(url).toBe('https://api.sgroup.qq.com/users/@me');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'QQBot tok-1' });
  });

  it('returns the raw profile when the platform omits the username', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ access_token: 'tok-1', expires_in: 7200 }))
      .mockResolvedValueOnce(jsonResponse({ id: '4266592316016549443' }));
    const auth = new QQAuth('app', 'secret', false, fakeLogger());

    // Empty username is a platform quirk, not an error — the caller decides what
    // to do, and the inbox falls back to a configured label or the bare channel.
    expect((await auth.getBotIdentity()).username).toBeUndefined();
  });

  it('surfaces a platform error instead of a fake name', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ access_token: 'tok-1', expires_in: 7200 }))
      .mockResolvedValueOnce(jsonResponse({ code: 11244, message: 'forbidden' }, false, 403));
    const auth = new QQAuth('app', 'secret', false, fakeLogger());

    await expect(auth.getBotIdentity()).rejects.toThrow(/403/);
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
