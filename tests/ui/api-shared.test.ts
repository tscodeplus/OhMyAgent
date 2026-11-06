/**
 * One request for the same GET, twice.
 *
 * The shell renders the navigation tray twice (sidebar + collapsed rail's
 * flyout), so first paint asked for each list twice over a link where a round
 * trip costs about a second. `apiRequestShared` shares an *in-flight* request
 * only: the twins collapse, and any later read still goes to the network, so a
 * caller can never be handed a stale page.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('apiRequestShared', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('collapses concurrent callers for the same path into one request', async () => {
    const { apiRequestShared } = await import('../../ui/src/utils/api');
    fetchMock.mockResolvedValue(jsonResponse({ items: [] }));

    const [a, b] = await Promise.all([
      apiRequestShared<{ items: unknown[] }>('/api/inbox'),
      apiRequestShared<{ items: unknown[] }>('/api/inbox'),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it('keeps different paths apart', async () => {
    const { apiRequestShared } = await import('../../ui/src/utils/api');
    // A fresh Response per call: a mock that hands back one object cannot be read twice.
    fetchMock.mockImplementation(async () => jsonResponse({ ok: true }));

    await Promise.all([apiRequestShared('/api/inbox'), apiRequestShared('/api/archive')]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not serve a finished answer to a later reader', async () => {
    const { apiRequestShared } = await import('../../ui/src/utils/api');
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ items: [1] }))
      .mockResolvedValueOnce(jsonResponse({ items: [2] }));

    const first = await apiRequestShared<{ items: number[] }>('/api/inbox');
    const second = await apiRequestShared<{ items: number[] }>('/api/inbox');

    expect(first).toEqual({ items: [1] });
    expect(second).toEqual({ items: [2] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries after a failure instead of pinning the rejection', async () => {
    const { apiRequestShared } = await import('../../ui/src/utils/api');
    fetchMock
      .mockResolvedValueOnce(new Response('{}', { status: 500 }))
      .mockResolvedValueOnce(jsonResponse({ items: [] }));

    await expect(apiRequestShared('/api/inbox')).rejects.toBeTruthy();
    await expect(apiRequestShared('/api/inbox')).resolves.toEqual({ items: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
