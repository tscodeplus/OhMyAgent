/**
 * WebUI Middleware Setup
 *
 * Extracted from bootstrap.ts (Phase 9c). Handles two serving modes:
 *   Dev  (ui/src exists) → Vite middleware with HMR
 *   Prod (ui/dist exists) → pre-built static files via @fastify/static
 *
 * Both modes share the same Fastify server on /webui/ prefix.
 */

import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import fastifyStatic from '@fastify/static';

export async function setupWebUIMiddleware(options: {
  server: FastifyInstance;
  logger: Logger;
  isTest: boolean;
  uiRoot: string;
}): Promise<{
  viteDevServer?: Awaited<ReturnType<typeof import('vite').createServer>>;
}> {
  const { server, logger, isTest, uiRoot } = options;

  if (isTest) {
    return {};
  }

  const uiDist = process.env.WEBUI_STATIC_ROOT || path.join(uiRoot, 'dist');
  const uiSrc = path.join(uiRoot, 'src');
  // Prefer pre-built static files when available (production mode).
  // Only use Vite dev middleware when there are NO pre-built files AND
  // source files exist (actual development with "pnpm dev").
  const hasPrebuilt = existsSync(path.join(uiDist, 'index.html'));
  const isDevMode = !hasPrebuilt && !process.env.WEBUI_STATIC_ROOT && existsSync(uiSrc);
  let viteDevServer: Awaited<ReturnType<typeof import('vite').createServer>> | undefined;

  if (isDevMode) {
    try {
      const { createServer: createViteServer } = await import('vite');
      const reactPlugin = (await import('@vitejs/plugin-react')).default;
      const tailwindPlugin = (await import('@tailwindcss/vite')).default;

      // configFile: false prevents Vite from auto-loading ui/vite.config.ts,
      // which would register duplicate plugins and inject the HMR runtime twice.
      viteDevServer = await createViteServer({
        configFile: false,
        server: {
          middlewareMode: true,
          hmr: {
            // Attach Vite's HMR WebSocket to the same HTTP server
            server: server.server,
          },
        },
        appType: 'custom',
        base: '/webui/',
        root: uiRoot,
        plugins: [reactPlugin(), tailwindPlugin()],
        resolve: {
          alias: {
            '@': path.resolve(uiRoot, 'src'),
          },
        },
      });

      // Root HTML page and SPA fallback: use Vite's transformIndexHtml so
      // the page gets HMR client injected and asset URLs are correct.
      const indexHtmlPath = path.join(uiRoot, 'index.html');

      const sendIndexHtml = async (reqUrl: string, reply: any) => {
        const raw = readFileSync(indexHtmlPath, 'utf-8');
        const transformed = await viteDevServer!.transformIndexHtml(reqUrl, raw);
        return reply.type('text/html').send(transformed);
      };

      server.get('/webui', (_, reply) => sendIndexHtml('/webui', reply));
      server.get('/webui/', (_, reply) => sendIndexHtml('/webui/', reply));

      // All other /webui/* and /@* paths: delegate to Vite's middlewares.
      // If Vite can't find a file, fall back to index.html (SPA routing).
      const delegateToVite = async (
        request: { raw: any; url: string },
        reply: { hijack: () => Promise<void>; raw: any },
      ) => {
        await reply.hijack();
        const url = request.url;
        viteDevServer!.middlewares(request.raw, reply.raw, () => {
          // Vite didn't handle this request — serve index.html for SPA routing
          if (!reply.raw.headersSent) {
            viteDevServer!.transformIndexHtml(url, readFileSync(indexHtmlPath, 'utf-8'))
              .then((html) => {
                if (!reply.raw.headersSent) {
                  reply.raw.statusCode = 200;
                  reply.raw.setHeader('Content-Type', 'text/html; charset=utf-8');
                  reply.raw.end(html);
                }
              })
              .catch(() => {
                if (!reply.raw.headersSent) {
                  reply.raw.statusCode = 500;
                  reply.raw.end('Internal Server Error');
                }
              });
          }
        });
      };

      server.route({
        method: ['GET'],
        url: '/webui/*',
        handler: delegateToVite as any,
      });

      server.route({
        method: ['GET'],
        url: '/@*',
        handler: delegateToVite as any,
      });

      logger.info({ base: '/webui/' }, 'WebUI dev middleware (Vite) registered on same port');
    } catch (err) {
      logger.warn({ err }, 'Vite dev middleware failed — falling back to static files');
      viteDevServer = undefined;
    }
  }

  // Production or fallback: serve pre-built static files from ui/dist
  if (!viteDevServer && existsSync(uiDist)) {
    await server.register(fastifyStatic, {
      root: uiDist,
      prefix: '/webui/',
      wildcard: false,
    });

    // SPA fallback: serve index.html for /webui/* routes not matching a static file
    server.setNotFoundHandler((request, reply) => {
      const url = request.url.split('?')[0];
      if (url.startsWith('/webui/') && !url.startsWith('/webui/assets/')) {
        return reply.sendFile('index.html');
      }
      if (url === '/webui' || url === '/webui/') {
        return reply.sendFile('index.html');
      }
      return reply.status(404).send({ error: 'Not Found' });
    });
    logger.info({ uiDist, prefix: '/webui/' }, 'WebUI static files registered');
  } else if (!viteDevServer) {
    logger.info('WebUI not available — run "cd ui && pnpm build" to build it');
  }

  // Redirect root to WebUI
  server.get('/', async (_request, reply) => {
    return reply.redirect('/webui/');
  });

  return { viteDevServer };
}
