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
 *
 * Secret masking for installed servers is deliberately NOT asserted here: this
 * spec runs against an arbitrary live installation, often with zero servers, so
 * any per-server leak assertion would be vacuous. That guarantee is owned by
 * `tests/app/mcp-routes.test.ts`, which installs a server carrying a secret in
 * env/headers and asserts the masked view.
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

  it('GET /api/mcp/servers returns McpServerView[] for the installed servers', async () => {
    const { status, body } = await getJson(baseUrl, token, '/api/mcp/servers');
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);

    // Field shapes are asserted against whatever this installation has. A fresh
    // install has no servers, so the leak guarantee for installed servers is NOT
    // asserted here — it is owned by `tests/app/mcp-routes.test.ts` (a unit test
    // that installs a server carrying a secret env/header and asserts masking).
    // Asserting it here would be vacuous on an empty list.
    for (const server of body as McpServerView[]) {
      expect(typeof server.name).toBe('string');
      expect(['stdio', 'http']).toContain(server.transport);
      expect(typeof server.enabled).toBe('boolean');
      // `disabled` is what resolveConnectionState() returns for every
      // `enabled: false` server — omitting it made this spec fail on any
      // installation with a paused server (E11).
      expect([
        'connected',
        'connecting',
        'disconnected',
        'auth_required',
        'error',
        'disabled',
      ]).toContain(server.state);
      expect(['direct', 'deferred', 'hidden']).toContain(server.exposure);
      expect(typeof server.toolCount).toBe('number');
      expect(typeof server.hasCredentials).toBe('boolean');
      expect(server).not.toHaveProperty('oauth');
      expect(server.installed).toBe(true);
      expect(server.source).toBe('config.yaml');
      expect(server.toolExposure).toBeTypeOf('object');

      // Secrets are returned as key names only, never as values (§13.7 masking):
      // the view carries `envKeys` / `headerKeys` and never the value maps.
      for (const key of server.envKeys ?? []) expect(typeof key).toBe('string');
      for (const key of server.headerKeys ?? []) expect(typeof key).toBe('string');
      expect(server).not.toHaveProperty('headers');
      expect(server).not.toHaveProperty('env');
      expect(server).not.toHaveProperty('clientSecret');
      expect(server).not.toHaveProperty('accessToken');
      expect(server).not.toHaveProperty('refreshToken');
    }
  });

  it('GET /api/mcp/servers/:name/resources handles the contract states', async () => {
    // An unknown server must hit the route's own 404 (`mcp.error.serverNotFound`),
    // not Fastify's default `Not Found`. That distinction is what proves the
    // `/resources` route is actually mounted — a bare 404 from a missing route
    // would otherwise be indistinguishable.
    const missing = await fetch(`${baseUrl}/api/mcp/servers/__smoke_missing__/resources`, {
      headers: authHeaders(token),
    });
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toBe('mcp.error.serverNotFound');
  });

  it('GET /api/mcp/servers/:name/raw handles the contract states', async () => {
    // Same mounted-route proof as /resources: a real server name resolves to a
    // 200 `{ yaml }` (see tests/app/mcp-routes.test.ts); an unknown one is the
    // route's own 404.
    const missing = await fetch(`${baseUrl}/api/mcp/servers/__smoke_missing__/raw`, {
      headers: authHeaders(token),
    });
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toBe('mcp.error.serverNotFound');
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

/**
 * Source-level assertions for the §13.6 detail drawer and the §13.7 view
 * fields. There is no DOM harness in this repo (see the file header), so the
 * drawer's contract is read out of the authoritative component source — the
 * same approach the tab-position test above uses. Each of these facts was a
 * gap before the six-lane review fix, so the test would have failed then.
 */
describe('WebUI MCP detail contract (§13.6 / §13.7)', () => {
  const mcpDir = join(REPO_ROOT, 'ui/src/components/settings/mcp');
  const detail = readFileSync(join(mcpDir, 'McpServerDetail.tsx'), 'utf-8');
  const card = readFileSync(join(mcpDir, 'McpServerCard.tsx'), 'utf-8');
  const form = readFileSync(join(mcpDir, 'McpServerForm.tsx'), 'utf-8');
  const settings = readFileSync(
    join(REPO_ROOT, 'ui/src/components/settings/tabs/McpSettings.tsx'),
    'utf-8',
  );

  it('renders the serverInfo identity fields in the connection block', () => {
    // Before the fix these came from `serverInfo` which the view never carried,
    // so the block always rendered "—".
    for (const field of ['protocolVersion', 'name', 'version']) {
      expect(detail).toMatch(new RegExp(`serverInfo\\?\\.${field}\\b`));
    }
  });

  it('renders instructionsSummary and lastError when present', () => {
    expect(detail).toMatch(/server\.instructionsSummary/);
    expect(detail).toMatch(/server\.lastError/);
    // The error is shown with a readable timestamp derived from `at`.
    expect(detail).toMatch(/lastError\.at/);
  });

  it('reads hasCredentials, not the removed oauth flag', () => {
    expect(detail).toMatch(/server\.hasCredentials/);
    expect(card).toMatch(/server\.hasCredentials/);
    expect(settings).toMatch(/server\.hasCredentials/);
    expect(detail).not.toMatch(/server\.oauth\b/);
    expect(card).not.toMatch(/server\.oauth\b/);
  });

  it('keys tool actions on serverToolName', () => {
    expect(card).toMatch(/serverToolName/);
    expect(settings).toMatch(/serverToolName/);
    expect(card).not.toMatch(/rawName/);
    expect(settings).not.toMatch(/rawName/);
  });

  it('renders an approval-risk badge for each tool', () => {
    expect(card).toMatch(/approvalRisk/);
    expect(card).toMatch(/settings\.mcp\.approvalRisk\.\$\{risk\}/);
  });

  it('writes per-tool enable via tool_enabled and keeps disabled tools listed', () => {
    // The PATCH body is snake_case like `tool_exposure`; the map key is the raw
    // server tool name. Before the fix there was no per-tool control at all.
    expect(card).toMatch(/onSetToolEnabled/);
    expect(settings).toMatch(/tool_enabled/);
    expect(settings).toMatch(/tool\.serverToolName/);
    // A disabled tool still renders, dimmed (`tool.enabled` gates the row class).
    expect(card).toMatch(/tool\.enabled/);
  });

  it('fetches the resources list and the raw config fragment', () => {
    expect(detail).toContain('/resources`');
    expect(detail).toContain('/raw`');
    expect(detail).toMatch(/detail\.resourcesNotSupported/);
    expect(detail).toMatch(/detail\.resourcesNotConnected/);
    expect(detail).toMatch(/detail\.resourcesEmpty/);
    expect(detail).toMatch(/detail\.resourcesError/);
    expect(detail).toMatch(/detail\.rawConfigUnavailable/);
    // The raw pane must not fall back to the normalised, expanded /api/config
    // view it used before the fix.
    expect(detail).not.toContain("apiRequest('/api/config')");
    expect(detail).not.toMatch(/readRawServerConfig/);
  });

  it('renders preset env hints and masks secret env rows', () => {
    // Before the fix the rows went through a plain-text KeyValueEditor: no hint,
    // and secrets were typed in cleartext.
    expect(form).toMatch(/row\.hint/);
    expect(form).toMatch(/row\.secret \? 'password' : 'text'/);
    expect(form).toMatch(/hint: e\.hint/);
    expect(form).toMatch(/secret: e\.secret/);
  });

  it('declares the new MCP i18n keys in both locales', () => {
    const load = (
      lang: string,
    ): { approvalRisk: Record<string, string>; detail: Record<string, string> } =>
      (
        JSON.parse(
          readFileSync(join(REPO_ROOT, `ui/src/i18n/locales/${lang}/common.json`), 'utf-8'),
        ) as {
          settings: {
            mcp: { approvalRisk: Record<string, string>; detail: Record<string, string> };
          };
        }
      ).settings.mcp;
    for (const lang of ['en', 'zh-CN']) {
      const mcp = load(lang);
      expect(mcp.approvalRisk.low).toBeTruthy();
      expect(mcp.approvalRisk.medium).toBeTruthy();
      expect(mcp.approvalRisk.high).toBeTruthy();
      expect(mcp.detail.resources).toBeTruthy();
    }
  });
});
