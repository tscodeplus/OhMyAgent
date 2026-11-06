/**
 * A packaged install whose WebUI build output is missing used to start
 * silently: one info log, then /webui 404s and the operator sees a blank page.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import Fastify from 'fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Logger } from 'pino';
import { setupWebUIMiddleware, resolveWebUIMode } from '../../src/app/webui/setup-vite.js';

const UI_ROOT = '/nonexistent-ui-root';

describe('resolveWebUIMode', () => {
  it('prefers Vite HMR when sources exist, even if a pre-built dist is present', () => {
    expect(resolveWebUIMode({ uiSrcExists: true, staticRoot: undefined, nodeEnv: undefined })).toBe(
      'vite',
    );
  });

  it('serves static build output in production even when sources exist', () => {
    expect(
      resolveWebUIMode({ uiSrcExists: true, staticRoot: undefined, nodeEnv: 'production' }),
    ).toBe('static');
  });

  it('WEBUI_STATIC_ROOT explicitly forces static mode', () => {
    expect(
      resolveWebUIMode({ uiSrcExists: true, staticRoot: '/somewhere/dist', nodeEnv: undefined }),
    ).toBe('static');
  });

  it('falls back to static when there are no sources', () => {
    expect(
      resolveWebUIMode({ uiSrcExists: false, staticRoot: undefined, nodeEnv: undefined }),
    ).toBe('static');
  });
});

describe('static file caching', () => {
  let server: ReturnType<typeof Fastify> | undefined;
  let root: string | undefined;

  const logger = {
    info: () => {},
    warn: () => {},
    debug: () => {},
    error: () => {},
  } as unknown as Logger;

  beforeEach(() => {
    // A packaged build: index.html plus one content-hashed asset.
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-webui-'));
    fs.mkdirSync(path.join(root, 'assets'));
    fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>t</title>');
    fs.writeFileSync(path.join(root, 'assets', 'index-abc123.js'), 'console.log(1)');
    fs.writeFileSync(path.join(root, 'favicon.svg'), '<svg/>');
    process.env.WEBUI_STATIC_ROOT = root;
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
    delete process.env.WEBUI_STATIC_ROOT;
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  async function headersFor(url: string): Promise<string> {
    server = Fastify();
    await setupWebUIMiddleware({ server, logger, isTest: false, uiRoot: UI_ROOT });
    const res = await server.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(200);
    return String(res.headers['cache-control'] ?? '');
  }

  // `@fastify/send` writes its own `Cache-Control: public, max-age=0` *after*
  // `setHeaders` runs, so without `cacheControl: false` the per-file headers were
  // silently dropped: every bundle shipped as `max-age=0`, browsers revalidated
  // the 1.3 MB WebUI on each visit, and Cloudflare capped it at its 4 h default.
  it('serves a content-hashed asset as immutable for a year', async () => {
    const cacheControl = await headersFor('/webui/assets/index-abc123.js');
    expect(cacheControl).toContain('max-age=31536000');
    expect(cacheControl).toContain('immutable');
  });

  it('keeps the entry HTML revalidating (Safari caches it aggressively)', async () => {
    expect(await headersFor('/webui/')).toBe('no-cache');
  });

  it('gives stable-named files a short TTL instead of immutable', async () => {
    expect(await headersFor('/webui/favicon.svg')).toBe('public, max-age=3600');
  });
});

describe('setupWebUIMiddleware with no build output', () => {
  let server: ReturnType<typeof Fastify> | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('reports the missing path in the log and on the URL', async () => {
    const errors: string[] = [];
    const logger = {
      info: () => {},
      warn: () => {},
      debug: () => {},
      // pino signatures are (msg) or (obj, msg) — collect the strings.
      error: (...args: unknown[]) => {
        for (const a of args) if (typeof a === 'string') errors.push(a);
      },
    } as unknown as Logger;

    server = Fastify();
    await setupWebUIMiddleware({ server, logger, isTest: false, uiRoot: UI_ROOT });

    expect(errors.join('\n')).toContain('WebUI unavailable');

    for (const url of ['/webui', '/webui/', '/webui/sessions']) {
      const res = await server.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(503);
      expect(res.body).toContain(path.join(UI_ROOT, 'dist'));
    }
  });
});
