/**
 * A packaged install whose WebUI build output is missing used to start
 * silently: one info log, then /webui 404s and the operator sees a blank page.
 */

import { describe, it, expect, afterEach } from 'vitest';
import Fastify from 'fastify';
import type { Logger } from 'pino';
import { setupWebUIMiddleware } from '../../src/app/webui/setup-vite.js';

const UI_ROOT = '/nonexistent-ui-root';

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
