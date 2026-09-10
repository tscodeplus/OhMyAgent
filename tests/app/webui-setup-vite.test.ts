/**
 * A packaged install whose WebUI build output is missing used to start
 * silently: one info log, then /webui 404s and the operator sees a blank page.
 */

import { describe, it, expect, afterEach } from 'vitest';
import Fastify from 'fastify';
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
      expect(res.body).toContain(`${UI_ROOT}/dist`);
    }
  });
});
