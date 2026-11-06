/**
 * One `GET /api/config` per page load.
 *
 * The settings panel fetched the whole document once per tab it mounted, the
 * notes layer fetched it on start, and the language sync fetched-and-wrote it on
 * every load. Through a Cloudflare Tunnel each of those is a round trip worth
 * about a second, so they now share one snapshot — and, just as important, a
 * write through `putConfig` must not leave that snapshot stale.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const token = 'test-token';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Fresh module state per test: the snapshot is page-scoped, not test-scoped. */
async function loadCache(): Promise<typeof import('../../ui/src/utils/config-cache')> {
  vi.resetModules();
  return import('../../ui/src/utils/config-cache');
}

describe('config cache', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => (key === 'ohmyagent_token' ? token : null),
      setItem: () => {},
      removeItem: () => {},
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shares one request between concurrent readers', async () => {
    const cache = await loadCache();
    fetchMock.mockResolvedValue(jsonResponse({ uiLanguage: 'zh-CN' }));

    const [a, b, c] = await Promise.all([
      cache.fetchConfig(),
      cache.fetchConfig(),
      cache.fetchConfig(),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a).toEqual({ uiLanguage: 'zh-CN' });
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it('serves the cached document inside its shelf life', async () => {
    const cache = await loadCache();
    fetchMock.mockResolvedValue(jsonResponse({ uiLanguage: 'zh-CN' }));

    await cache.fetchConfig();
    await cache.fetchConfig();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not remember a failed read', async () => {
    const cache = await loadCache();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ message: 'Unauthorized' }, 401))
      .mockResolvedValueOnce(jsonResponse({ uiLanguage: 'en' }));

    await expect(cache.fetchConfig()).rejects.toBeTruthy();
    await expect(cache.fetchConfig()).resolves.toEqual({ uiLanguage: 'en' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('drops the snapshot when a write goes through putConfig', async () => {
    const cache = await loadCache();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ uiLanguage: 'zh-CN' }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({ uiLanguage: 'en' }));

    expect(await cache.fetchConfig()).toEqual({ uiLanguage: 'zh-CN' });
    await cache.putConfig({ uiLanguage: 'en' });
    expect(await cache.fetchConfig()).toEqual({ uiLanguage: 'en' });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [, putInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(putInit.method).toBe('PUT');
    expect(putInit.body).toBe(JSON.stringify({ uiLanguage: 'en' }));
  });

  it('refetches on demand', async () => {
    const cache = await loadCache();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ uiLanguage: 'zh-CN' }))
      .mockResolvedValueOnce(jsonResponse({ uiLanguage: 'en' }));

    await cache.fetchConfig();
    await cache.fetchConfig(true);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
