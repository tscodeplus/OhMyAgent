// net.ts — system-proxy-aware HTTP for the sidecar.
//
// Why: the Electron shell used Chromium's net.fetch which honors the OS
// system proxy automatically. Node's undici fetch does NOT — it connects
// directly, which breaks GitHub access for users whose only route is a
// local proxy (the common case in CN networks). Electron's behavior was
// "系统代理开着就能访问 GitHub", so we replicate it: resolve the proxy
// (env vars first, then the Windows registry) and route through undici's
// ProxyAgent.

import { execFileSync } from 'node:child_process';
import { ProxyAgent, type Dispatcher } from 'undici';

const proxyAgent: Dispatcher | null = buildProxyAgent();

function buildProxyAgent(): Dispatcher | null {
  const proxy = resolveSystemProxy();
  if (!proxy) return null;
  try {
    const agent = new ProxyAgent(proxy);
    console.log(`[net] using system proxy: ${proxy}`);
    return agent;
  } catch (e) {
    console.error(`[net] ProxyAgent init failed for ${proxy}: ${e}`);
    return null;
  }
}

/** Resolve the system proxy: env vars (curl semantics), then Windows registry. */
export function resolveSystemProxy(): string | null {
  // 1. Env vars — uppercase first, like curl. Ignore empty/bool values.
  for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) {
    const v = process.env[key];
    if (!v) continue;
    const s = v.trim();
    if (!s || /^(true|false|0|1)$/i.test(s)) continue;
    if (/^https?:\/\//i.test(s) || /^socks/i.test(s)) return s;
    return `http://${s}`; // bare host:port
  }

  // 2. macOS system proxy (SystemConfiguration) — ClashX / Clash Verge in
  //    "system proxy" mode set no env vars, and Electron's Chromium read the
  //    OS proxy automatically; replicate that via `scutil --proxy`.
  if (process.platform === 'darwin') {
    try {
      const out = execFileSync('scutil', ['--proxy'], { encoding: 'utf8' });
      const kv: Record<string, string> = {};
      for (const line of out.split('\n')) {
        const m = line.match(/^\s*(\w+)\s*:\s*(.+)$/);
        if (m) kv[m[1]] = m[2].trim();
      }
      if (kv.HTTPSEnable === '1' && kv.HTTPSProxy && kv.HTTPSPort) {
        return `http://${kv.HTTPSProxy}:${kv.HTTPSPort}`;
      }
      if (kv.HTTPEnable === '1' && kv.HTTPProxy && kv.HTTPPort) {
        return `http://${kv.HTTPProxy}:${kv.HTTPPort}`;
      }
      if (kv.SOCKSEnable === '1' && kv.SOCKSProxy && kv.SOCKSPort) {
        return `socks://${kv.SOCKSProxy}:${kv.SOCKSPort}`;
      }
    } catch {
      // scutil unavailable — fall through
    }
  }

  // 3. Windows system proxy (Internet Settings registry).
  if (process.platform === 'win32') {
    try {
      const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
      const enable = execFileSync('reg', ['query', KEY, '/v', 'ProxyEnable'], { encoding: 'utf8' });
      if (!/0x1/i.test(enable)) return null;
      const server = execFileSync('reg', ['query', KEY, '/v', 'ProxyServer'], { encoding: 'utf8' });
      const raw = server
        .split('\n')
        .map((l) => l.trim())
        .find((l) => /^\s*ProxyServer\s+REG_SZ\s/i.test(l));
      if (!raw) return null;
      const value = raw.replace(/^.*REG_SZ\s+/i, '').trim();
      // "http=127.0.0.1:7890;https=127.0.0.1:7890" → prefer the https entry.
      const perProto = Object.fromEntries(
        value.split(';').map((p) => {
          const eq = p.indexOf('=');
          return eq === -1 ? ['', p.trim()] : [p.slice(0, eq).trim(), p.slice(eq + 1).trim()];
        }),
      );
      const host = perProto['https'] || perProto['http'] || perProto['socks'] || value;
      if (!host) return null;
      if (/^https?:\/\//i.test(host) || /^socks/i.test(host)) return host;
      return `http://${host}`;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * fetch that honors the system proxy. Loopback calls never need one, and
 * sending them through a proxy agent can break local control API traffic.
 *
 * Node's global fetch is undici under the hood and accepts `dispatcher` in
 * the init object; the type assertion keeps everything on the global types.
 */
export async function fetchWithProxy(
  url: string | URL,
  init?: RequestInit,
): Promise<Response> {
  const u = typeof url === 'string' ? url : url.href;
  const isLoopback = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/i.test(u);
  // GitHub's REST API rejects requests without a User-Agent (403); undici
  // sends none by default (Chromium's net.fetch in Electron did). Attach one
  // to every external request unless the caller already set its own.
  let headers = init?.headers ?? {};
  if (!isLoopback) {
    headers = new Headers(headers);
    if (!headers.has('user-agent')) {
      headers.set('user-agent', 'OhMyAgent-Desktop');
    }
  }
  if (isLoopback || !proxyAgent) {
    return fetch(url, { ...(init ?? {}), headers });
  }
  return fetch(url, {
    ...(init ?? {}),
    headers,
    dispatcher: proxyAgent,
  } as RequestInit & { dispatcher?: Dispatcher });
}
