/**
 * Smoke spec: the MCP settings tab and its API surface.
 *
 * Excluded from `pnpm test` — `vitest.config.ts` collects `tests/**\/*.test.ts`,
 * and this file is a `*.spec.ts`. Run it against a **live** server:
 *
 *   pnpm dev &
 *   OHMYAGENT_PORT=9191 WEBUI_TOKEN=… pnpm test:smoke:webui
 *
 * Two halves, for two different reasons:
 *
 *   - **API assertions** drive the real HTTP surface with `fetch`, like
 *     `auth.spec.ts` / `chat.spec.ts` / `project.spec.ts` do. They need no MCP
 *     server: an empty installation is the interesting state, and the shapes
 *     asserted here come from `src/mcp/types.ts` and `src/mcp/presets.ts`, which
 *     are the frozen contract the routes implement.
 *   - **Source assertions** cover what HTTP cannot: the sidebar position of the
 *     MCP tab (decision 19-12 — last entry of the `integration` group, i.e.
 *     directly below *Computer Use*). There is no browser automation in this
 *     repo, so the tab's position is read out of the authoritative declaration
 *     instead of a DOM. This is deliberate, not a shortcut: an HTTP-level test
 *     of the same fact is impossible, and asserting only "the tab exists" would
 *     pass even if it were inserted first in the group.
 *
 * A missing `/api/mcp/*` route fails **loudly** rather than skipping: a smoke
 * suite that silently skips absent endpoints proves nothing.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { MCP_PRESETS } from '../../../src/mcp/presets.js';
import type { McpServerView } from '../../../src/mcp/types.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** Owner of the routes this spec talks to; named in every 404 failure. */
const ROUTES_SOURCE = 'src/app/webui/mcp-routes.ts (P3a)';

function authHeaders(token: string): Record<string, string> {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

/**
 * Fail with a message that says *which* thing is wrong: an unfinished route
 * (404 — the P3a deliverable is not wired up yet) or a real regression (200
 * expected but something else came back).
 */
async function getJson(
  baseUrl: string,
  token: string,
  route: string,
): Promise<{ status: number; body: unknown; text: string }> {
  const response = await fetch(`${baseUrl}${route}`, { headers: authHeaders(token) });
  const text = await response.text();
  if (response.status === 404) {
    throw new Error(
      `GET ${route} returned 404. The MCP API is not mounted — expected from ${ROUTES_SOURCE}. ` +
        'If that file exists, this is a regression: the route was dropped from the WebUI registration.',
    );
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(
      `GET ${route} returned ${response.status} with a non-JSON body: ${text.slice(0, 200)}`,
    );
  }
  return { status: response.status, body, text };
}

describe('WebUI MCP API', () => {
  let baseUrl: string;
  let token: string;

  beforeAll(() => {
    baseUrl = `http://localhost:${process.env.OHMYAGENT_PORT || '9191'}`;
    token = process.env.WEBUI_TOKEN || 'test-token';
  });

  it('GET /api/mcp/status reports the counter shape', async () => {
    const { status, body } = await getJson(baseUrl, token, '/api/mcp/status');
    expect(status).toBe(200);

    for (const key of ['installed', 'enabled', 'connected', 'authRequired', 'errorCount']) {
      expect(typeof (body as Record<string, unknown>)[key]).toBe('number');
    }
  });

  it('GET /api/mcp/servers returns McpServerView[] and leaks no credential', async () => {
    const { status, body, text } = await getJson(baseUrl, token, '/api/mcp/servers');
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);

    for (const server of body as McpServerView[]) {
      expect(typeof server.name).toBe('string');
      expect(['stdio', 'http']).toContain(server.transport);
      expect(typeof server.enabled).toBe('boolean');
      expect(['connected', 'connecting', 'disconnected', 'auth_required', 'error']).toContain(
        server.state,
      );
      expect(['direct', 'deferred', 'hidden']).toContain(server.exposure);
      expect(typeof server.toolCount).toBe('number');
      expect(typeof server.oauth).toBe('boolean');
      expect(server.toolExposure).toBeTypeOf('object');

      // Secrets are returned as key names only, never as values (§13.7 masking).
      for (const key of server.envKeys ?? []) expect(typeof key).toBe('string');
      for (const key of server.headerKeys ?? []) expect(typeof key).toBe('string');
      expect(server).not.toHaveProperty('headers');
      expect(server).not.toHaveProperty('env');
      expect(server).not.toHaveProperty('clientSecret');
      expect(server).not.toHaveProperty('accessToken');
      expect(server).not.toHaveProperty('refreshToken');
    }

    // The raw payload must not carry a bearer token or an OAuth secret, whatever
    // the installation looks like (acceptance: "no token leaks from the list API").
    expect(text).not.toMatch(/Bearer [A-Za-z0-9._-]{8,}/);
    expect(text).not.toMatch(/"access_token"|"refresh_token"|"client_secret"/);
  });

  it('GET /api/mcp/presets serves the built-in catalogue unchanged', async () => {
    const { status, body } = await getJson(baseUrl, token, '/api/mcp/presets');
    expect(status).toBe(200);

    const presets = body as Array<Record<string, unknown>>;
    expect(Array.isArray(presets)).toBe(true);
    expect(presets.map((p) => p.id)).toEqual(MCP_PRESETS.map((p) => p.id));

    for (const preset of presets) {
      expect(typeof preset.name).toBe('string');
      expect(typeof preset.description).toBe('string');
      expect(['stdio', 'http']).toContain(preset.transport);
      expect(['direct', 'deferred', 'hidden']).toContain(preset.exposure);
      expect(Array.isArray(preset.env)).toBe(true);
      expect(typeof preset.docsUrl).toBe('string');
    }
  });

  it('POST /api/mcp/test rejects an entry with neither command nor url', async () => {
    const response = await fetch(`${baseUrl}/api/mcp/test`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ name: 'smoke-invalid' }),
    });
    if (response.status === 404) {
      throw new Error(
        `POST /api/mcp/test returned 404. Expected from ${ROUTES_SOURCE}; if that file exists, ` +
          'the route is missing from the WebUI registration.',
      );
    }
    expect([400, 422]).toContain(response.status);
  });
});

describe('WebUI MCP settings tab', () => {
  const settingsModalPath = join(REPO_ROOT, 'ui/src/components/settings/SettingsModal.tsx');
  const mcpSettingsPath = join(REPO_ROOT, 'ui/src/components/settings/tabs/McpSettings.tsx');

  /** `SETTINGS_GROUPS` entries in declaration order, read from the source. */
  function parseSettingsGroups(source: string): Array<{ id: string; group: string }> {
    const start = source.indexOf('export const SETTINGS_GROUPS');
    const end = source.indexOf('] as const;', start);
    if (start < 0 || end < 0) {
      throw new Error(
        'SETTINGS_GROUPS declaration not found in SettingsModal.tsx — the tab registry was moved ' +
          'or renamed and this spec needs updating.',
      );
    }
    return [...source.slice(start, end).matchAll(/id:\s*'([^']+)'[\s\S]*?group:\s*'([^']+)'/g)].map(
      (match) => ({ id: match[1], group: match[2] }),
    );
  }

  it('places the MCP tab last in the integration group, right below computer', () => {
    const source = readFileSync(settingsModalPath, 'utf-8');
    const integration = parseSettingsGroups(source).filter(
      (entry) => entry.group === 'integration',
    );

    expect(integration.map((entry) => entry.id)).toContain('mcp');
    // Decision 19-12: last entry of the group, immediately after "Computer Use".
    expect(integration.at(-1)?.id).toBe('mcp');
    expect(integration.at(-2)?.id).toBe('computer');
  });

  it('registers a real component for the tab', () => {
    const source = readFileSync(settingsModalPath, 'utf-8');
    expect(source).toMatch(/import McpSettings from '\.\/tabs\/McpSettings';/);
    expect(source).toMatch(/^\s*mcp: McpSettings,$/m);
    expect(existsSync(mcpSettingsPath)).toBe(true);
  });

  it('keeps the install form and the preset list reachable from the tab', () => {
    // The tab is the only place that can open the install form, so a tab that
    // stopped rendering it would silently remove the documented install path.
    const source = readFileSync(mcpSettingsPath, 'utf-8');
    expect(source).toMatch(/<McpServerForm/);
    expect(source).toMatch(/<McpPresetList/);
    expect(source).toMatch(/export default function McpSettings/);
  });
});
