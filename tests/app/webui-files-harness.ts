/**
 * Shared fastify.inject() harness for the WebUI file routes.
 *
 * The HTTP surface of this gateway had almost no test coverage, which is how
 * the /api/files/tree confinement gap and the self-serviceable file approval
 * survived review. This helper wires the REAL auth hook (webuiAuthHook) and the
 * REAL routes against a throwaway directory tree so regressions are asserted
 * end-to-end — status codes and response headers — instead of against
 * extracted helpers.
 *
 * Layout produced by createFilesHarness():
 *
 *   <tmp>/oma-files-harness-XXXX/
 *     config.yaml          webui.file_root → <root>
 *     root/                the browsable file_root
 *       notes.txt          "root file body"
 *       sub/inner.txt      "nested file body"
 *       page.html          "<h1>inline page</h1>"
 *       icon.svg           "<svg>...</svg>"
 *       pic.png            "\x89PNG..."
 *   <outside>/secret.txt   a file that is inside NONE of the served roots
 *
 * `outsideDir` is deliberately NOT under file_root, cwd, os.tmpdir() or homedir:
 * those three plus file_root make up the serve allowlist, so a temp dir under
 * os.tmpdir() would silently be an *allowed* root and the traversal assertions
 * would prove nothing.
 */

import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';

import {
  registerFilesRoutes,
  computeServeAllowedRoots,
  resetFileServeApprovals,
} from '../../src/app/webui/files-routes.js';
import { registerPublicDownloadRoutes } from '../../src/app/webui/public-download-routes.js';
import { registerChatRoutes } from '../../src/app/webui/chat-routes.js';
import { resetWebUIToken, webuiAuthHook } from '../../src/app/webui-auth.js';
import { isWithinRoot } from '../../src/shared/path-utils.js';
import type { AppConfig } from '../../src/app/types.js';

export const TEST_TOKEN = 'harness-webui-token-0123456789';
export const OUTSIDE_SECRET_BODY = 'TOP-SECRET-OUTSIDE-FILE';
export const HTML_BODY = '<h1>inline page</h1>';
export const SVG_BODY = '<svg xmlns="http://www.w3.org/2000/svg"><title>x</title></svg>';

export interface FilesHarness {
  app: FastifyInstance;
  /** webui.file_root — everything the browser routes may walk. */
  fileRoot: string;
  /** Directory outside file_root and outside every served root. */
  outsideDir: string;
  outsideSecretPath: string;
  servedRoots: string[];
  configPath: string;
  /** Issue an inject() with the valid bearer token by default. */
  call(
    method: string,
    url: string,
    opts?: { token?: string | null; payload?: unknown },
  ): Promise<Awaited<ReturnType<FastifyInstance['inject']>>>;
  cleanup(): Promise<void>;
}

function makeOutsideDir(servedRoots: string[]): string {
  // Candidates in preference order; the first writable one that is not inside
  // any served root wins. /var/tmp is the Linux case that survives a /tmp-based
  // tmpdir; the others keep this working on macOS/Windows runners.
  const candidates = ['/var/tmp', tmpdir(), '/tmp', '/dev/shm'];
  for (const base of candidates) {
    let dir: string | null = null;
    try {
      dir = mkdtempSync(join(base, 'oma-files-outside-'));
    } catch {
      continue;
    }
    if (!servedRoots.some((root) => isWithinRoot(dir as string, root))) return dir;
    rmSync(dir, { recursive: true, force: true });
  }
  throw new Error('harness: no writable directory outside the served roots');
}

export async function createFilesHarness(options?: {
  withChatRoutes?: boolean;
}): Promise<FilesHarness> {
  const base = mkdtempSync(join(tmpdir(), 'oma-files-harness-'));
  const fileRoot = join(base, 'root');
  mkdirSync(join(fileRoot, 'sub'), { recursive: true });
  writeFileSync(join(fileRoot, 'notes.txt'), 'root file body');
  writeFileSync(join(fileRoot, 'sub', 'inner.txt'), 'nested file body');
  writeFileSync(join(fileRoot, 'page.html'), HTML_BODY);
  writeFileSync(join(fileRoot, 'icon.svg'), SVG_BODY);
  writeFileSync(join(fileRoot, 'pic.png'), '\x89PNG\r\n\x1a\n fake png body');

  const configPath = join(base, 'config.yaml');
  writeFileSync(configPath, stringifyYaml({ webui: { file_root: fileRoot } }), 'utf-8');

  const servedRoots = computeServeAllowedRoots({} as AppConfig, resolve(fileRoot));
  const outsideDir = makeOutsideDir(servedRoots);
  writeFileSync(join(outsideDir, 'secret.txt'), OUTSIDE_SECRET_BODY);

  process.env.WEBUI_TOKEN = TEST_TOKEN;
  resetWebUIToken();
  resetFileServeApprovals();

  const app = Fastify({
    logger: false,
    // Mirrors createFeishuServer(): find-my-way's default maxParamLength (100)
    // is shorter than a /dl token, so without this the download route 404s here
    // while working in production.
    maxParamLength: 500,
    bodyLimit: 5 * 1024 * 1024,
  });
  // Registered FIRST: Fastify applies onRequest hooks to routes registered
  // after them, which is exactly how bootstrap.ts wires the gateway.
  app.addHook('onRequest', webuiAuthHook);
  registerFilesRoutes(app, {
    getConfig: () => ({}) as AppConfig,
    onConfigChanged: () => {},
    configPath,
  });
  registerPublicDownloadRoutes(app);
  if (options?.withChatRoutes) {
    // The chat routes carry /api/auth/login; stubs are enough because only the
    // auth endpoints are exercised.
    registerChatRoutes(app, {
      agentService: {} as never,
      projectStore: {} as never,
    } as never);
  }
  await app.ready();

  return {
    app,
    fileRoot,
    outsideDir,
    outsideSecretPath: join(outsideDir, 'secret.txt'),
    servedRoots,
    configPath,
    async call(method, url, opts) {
      const inject: InjectOptions = { method: method as InjectOptions['method'], url };
      if (opts?.payload !== undefined) inject.payload = opts.payload as never;
      const token = opts?.token === null ? undefined : (opts?.token ?? TEST_TOKEN);
      if (token) inject.headers = { authorization: `Bearer ${token}` };
      return app.inject(inject);
    },
    async cleanup() {
      await app.close();
      rmSync(base, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
      delete process.env.WEBUI_TOKEN;
      resetWebUIToken();
      resetFileServeApprovals();
    },
  };
}
