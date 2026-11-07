import { describe, expect, it } from 'vitest';
import { probeGateway } from '../../desktop/sidecar/src/gateway-probe.js';

/** Minimal fetch stand-in: one handler per URL path, records the calls. */
function fakeFetch(handlers: Record<string, () => Promise<Response> | Response>) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const handler = handlers[path];
    if (!handler) throw new TypeError('fetch failed');
    return handler();
  }) as typeof fetch;
  return { impl, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('probeGateway', () => {
  it('reports ok and the version when health and verify both succeed', async () => {
    const { impl, calls } = fakeFetch({
      '/api/health': () => json({ ok: true, version: '5.0.0' }),
      '/api/auth/verify': () => json({ valid: true }),
    });
    await expect(
      probeGateway('http://192.168.1.201:9191/', 'tok', { fetchImpl: impl }),
    ).resolves.toEqual({ code: 'ok', version: '5.0.0' });
    // Trailing slash collapsed, and the token travels in the header — no Origin,
    // so the remote gateway never sees a CORS preflight.
    expect(calls.map((c) => c.url)).toEqual([
      'http://192.168.1.201:9191/api/health',
      'http://192.168.1.201:9191/api/auth/verify',
    ]);
    expect(calls[1].headers.Authorization).toBe('Bearer tok');
  });

  it('treats a 403 from the auth hook as an invalid token', async () => {
    const { impl } = fakeFetch({
      '/api/health': () => json({ ok: true, version: '5.0.0' }),
      '/api/auth/verify': () => json({ error: 'Forbidden' }, 403),
    });
    await expect(probeGateway('http://gw:9191', 'bad', { fetchImpl: impl })).resolves.toEqual({
      code: 'invalidToken',
      version: '5.0.0',
    });
  });

  it('treats a 200 {valid:false} as an invalid token too', async () => {
    // The route answers 200 with a boolean; a proxy or an older gateway may let
    // the request through without the hook's 403.
    const { impl } = fakeFetch({
      '/api/health': () => json({ version: '4.9.0' }),
      '/api/auth/verify': () => json({ valid: false }),
    });
    await expect(probeGateway('http://gw:9191', 'bad', { fetchImpl: impl })).resolves.toEqual({
      code: 'invalidToken',
      version: '4.9.0',
    });
  });

  it('reports invalidToken when no token is configured', async () => {
    const { impl, calls } = fakeFetch({ '/api/health': () => json({ version: '5.0.0' }) });
    await expect(probeGateway('http://gw:9191', '  ', { fetchImpl: impl })).resolves.toEqual({
      code: 'invalidToken',
      version: '5.0.0',
    });
    expect(calls).toHaveLength(1);
  });

  it('reports unreachable with the detail when the gateway is not listening', async () => {
    const { impl } = fakeFetch({});
    const result = await probeGateway('http://gw:9191', 'tok', { fetchImpl: impl });
    expect(result.code).toBe('unreachable');
    expect(result).toMatchObject({ detail: 'fetch failed' });
  });

  it('reports unreachable on a health HTTP error, without blaming the token', async () => {
    const { impl } = fakeFetch({ '/api/health': () => json({}, 502) });
    await expect(probeGateway('http://gw:9191', 'tok', { fetchImpl: impl })).resolves.toEqual({
      code: 'unreachable',
      detail: 'HTTP 502',
    });
  });

  it('keeps the token verdict out of a failing verify transport', async () => {
    const { impl } = fakeFetch({ '/api/health': () => json({ version: '5.0.0' }) });
    const result = await probeGateway('http://gw:9191', 'tok', { fetchImpl: impl });
    expect(result.code).toBe('unreachable');
  });

  it('assumes http for a scheme-less host and rejects garbage', async () => {
    const { impl, calls } = fakeFetch({
      '/api/health': () => json({ version: '5.0.0' }),
      '/api/auth/verify': () => json({ valid: true }),
    });
    await probeGateway('192.168.1.201:9191', 'tok', { fetchImpl: impl });
    expect(calls[0].url).toBe('http://192.168.1.201:9191/api/health');
    await expect(probeGateway('   ', 'tok', { fetchImpl: impl })).resolves.toEqual({
      code: 'unreachable',
      detail: 'invalid url',
    });
  });
});
