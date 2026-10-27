/**
 * OhMyAgent WebUI — service worker.
 *
 * Scope is `/webui/` (this file's directory), so the API surface — `/api/*`,
 * `/ws`, `/dl/*`, `/webhook/*`, `/qr-exchange/*` — is *outside* the scope and
 * never reaches the `fetch` handler below. That is the primary guarantee that
 * streaming chat, approval cards and download tokens are never served from
 * cache. The explicit bypass list is defensive only.
 *
 * Strategy:
 *   navigations   network-first  → cached shell on failure (offline start)
 *   /webui/assets/ cache-first   → Vite emits hashed, immutable filenames
 *   everything else stale-while-revalidate
 *
 * Bump CACHE_VERSION on any change to this file's caching behaviour; `activate`
 * drops every cache whose name does not carry the current version.
 */

const CACHE_VERSION = 'v1';
const SHELL_CACHE = `oma-shell-${CACHE_VERSION}`;
const ASSET_CACHE = `oma-assets-${CACHE_VERSION}`;

/** Relative to this worker's URL, so the manifest's base path stays in one place. */
const SHELL_URL = './';
const PRECACHE_URLS = [
  './',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png',
];

/** Paths under the scope that must never be cached (defensive — see header). */
const BYPASS_PREFIXES = ['/api/', '/ws', '/dl/', '/webhook/', '/qr-exchange/'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // Individually settled: one missing icon must not fail the whole install.
      await Promise.allSettled(PRECACHE_URLS.map((url) => cache.add(url)));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL_CACHE, ASSET_CACHE]);
      const names = await caches.keys();
      await Promise.all(names.map((name) => (keep.has(name) ? undefined : caches.delete(name))));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (BYPASS_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  if (url.pathname.startsWith(new URL('./assets/', self.location.href).pathname)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  event.respondWith(staleWhileRevalidate(request));
});

async function networkFirstNavigation(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(SHELL_URL, response.clone());
    return response;
  } catch {
    const cached = await cache.match(SHELL_URL);
    if (cached) return cached;
    return new Response(
      '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<title>Offline</title><body style="font:16px system-ui;padding:2rem;text-align:center">' +
        '<p>当前离线，且本地还没有可用的页面缓存。</p><p>请恢复网络后重新打开。</p>',
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    );
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then(async (response) => {
      if (response.ok) await cache.put(request, response.clone());
      return response;
    })
    .catch(() => undefined);
  if (cached) return cached;
  const response = await network;
  if (response) return response;
  return new Response('', { status: 504, statusText: 'Offline' });
}
