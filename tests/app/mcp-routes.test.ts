/**
 * Tests for the MCP API routes (`src/app/webui/mcp-routes.ts`, design §13.7).
 *
 * A real Fastify app (as in `config-routes.test.ts`) with the config file
 * redirected through `CONFIG_FILE`, a real in-memory SQLite database for the
 * OAuth credential table, and a stub `McpManager`. `POST /api/mcp/test` gets a
 * stub probe: §16 forbids spawning a real MCP server from `pnpm test`.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import {
  registerMcpRoutes,
  type McpProbe,
  type McpProbeResult,
} from '../../src/app/webui/mcp-routes.js';
import { registerConfigRoutes } from '../../src/app/webui/config-routes.js';
import type { AppConfig } from '../../src/app/types.js';
import { DEFAULT_MCP_SECTION, normaliseMcpSection } from '../../src/mcp/config.js';
import { MASKED_SECRET } from '../../src/mcp/masking.js';
import { resetAgentHomeCache } from '../../src/shared/agent-home.js';
import {
  registerToolCapability,
  unregisterToolCapability,
} from '../../src/policy/tool-capability-registry.js';
import type { McpManager, McpServerState, Tool } from '../../src/mcp/types.js';
import { migrateV8 } from '../../src/memory/migration-v8.js';

const SERVER_URL = 'https://mcp.example/api';

function makeTool(name: string, overrides: Partial<Tool> = {}): Tool {
  return {
    name,
    description: `${name} description`,
    inputSchema: { type: 'object', properties: {} },
    ...overrides,
  };
}

function makeState(name: string, overrides: Partial<McpServerState> = {}): McpServerState {
  return {
    name,
    state: 'connected',
    tools: [],
    errorCount: 0,
    updatedAt: 1_700_000_000_000,
    authRequired: false,
    supportsResources: false,
    supportsPrompts: false,
    ...overrides,
  };
}

interface StubManager {
  manager: McpManager;
  reload: Mock;
  reconnect: Mock;
  login: Mock;
  logout: Mock;
  submitCallback: Mock;
  tools: Map<string, Tool[]>;
  states: Map<string, McpServerState>;
  listResources: Mock;
  listResourceTemplates: Mock;
}

function createStubManager(): StubManager {
  const tools = new Map<string, Tool[]>();
  const states = new Map<string, McpServerState>();
  const reload = vi.fn(async () => {});
  const reconnect = vi.fn(async (name: string) => makeState(name));
  const login = vi.fn(async () => ({
    authorizationUrl: 'https://auth.example/authorize',
    manual: true,
  }));
  const logout = vi.fn(async () => {});
  const submitCallback = vi.fn(async () => {});
  const listResources = vi.fn(async () => ({ resources: [] }));
  const listResourceTemplates = vi.fn(async () => ({ resourceTemplates: [] }));

  const manager: McpManager = {
    ready: async () => {},
    stop: async () => {},
    reload,
    listServers: () => [...states.values()],
    getServerState: (name) => states.get(name),
    listTools: (name) => [...(tools.get(name) ?? [])],
    callTool: async () => ({ content: [] }),
    reconnect,
    alwaysVisibleTools: () => [],
    login,
    logout,
    submitCallback,
    onToolsChanged: () => () => {},
    resources: {
      listResources,
      listResourceTemplates,
      readResource: async () => ({ contents: [] }),
      serversWithResources: () => [],
    },
  };

  return {
    manager,
    reload,
    reconnect,
    login,
    logout,
    submitCallback,
    tools,
    states,
    listResources,
    listResourceTemplates,
  };
}

describe('MCP API routes', () => {
  let scratch: string;
  let configPath: string;
  let logDir: string;
  let db: Database.Database;
  let app: ReturnType<typeof Fastify>;
  let stub: StubManager;
  let probe: Mock;
  let onConfigSaved: Mock;
  let previousConfigFile: string | undefined;
  let previousLogDir: string | undefined;

  const writeConfig = (text: string): void => writeFileSync(configPath, text, 'utf-8');

  const writeServerEntry = (name: string, entry: Record<string, unknown>): void => {
    writeConfig(stringifyYaml({ mcp: { servers: { [name]: entry } } }, { indent: 2 }));
  };

  const writeServerEntries = (servers: Record<string, Record<string, unknown>>): void => {
    writeConfig(stringifyYaml({ mcp: { servers } }, { indent: 2 }));
  };

  const readRawConfig = (): Record<string, unknown> =>
    parseYaml(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;

  const rawServer = (name: string): Record<string, unknown> | undefined => {
    const mcp = readRawConfig().mcp as { servers?: Record<string, Record<string, unknown>> };
    return mcp?.servers?.[name];
  };

  /** Read path mirror of `loadConfig()`: raw YAML → the normalised `mcp:` section. */
  const getConfig = (): AppConfig =>
    ({ mcp: normaliseMcpSection(readRawConfig().mcp) }) as unknown as AppConfig;

  const inject = (options: Parameters<typeof app.inject>[0]) => app.inject(options);

  beforeEach(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'mcp-routes-'));
    configPath = join(scratch, 'config.yaml');
    logDir = join(scratch, 'logs');
    mkdirSync(logDir);
    previousConfigFile = process.env.CONFIG_FILE;
    previousLogDir = process.env.OHMYAGENT_LOG_DIR;
    process.env.CONFIG_FILE = configPath;
    process.env.OHMYAGENT_LOG_DIR = logDir;
    writeConfig('log_level: info\n');

    db = new Database(':memory:');
    migrateV8(db);

    stub = createStubManager();
    probe = vi.fn(async (): Promise<McpProbeResult> => ({
      ok: true,
      serverInfo: { name: 'probe' },
      tools: [],
    }));
    onConfigSaved = vi.fn();

    app = Fastify({ logger: false });
    registerMcpRoutes(app, {
      db,
      getConfig,
      getManager: () => stub.manager,
      onConfigSaved,
      probe: probe as unknown as McpProbe,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
    rmSync(scratch, { recursive: true, force: true });
    if (previousConfigFile === undefined) delete process.env.CONFIG_FILE;
    else process.env.CONFIG_FILE = previousConfigFile;
    if (previousLogDir === undefined) delete process.env.OHMYAGENT_LOG_DIR;
    else process.env.OHMYAGENT_LOG_DIR = previousLogDir;
    vi.clearAllMocks();
  });

  // ─── reads ───

  it('GET /api/mcp/servers merges config with live manager state', async () => {
    writeConfig(
      stringifyYaml({
        mcp: {
          servers: {
            filesystem: {
              command: 'npx',
              args: ['-y', 'server-filesystem', '/tmp'],
              env: { GITHUB_TOKEN: 'ghp_real_token', LOG_LEVEL: 'debug' },
              exposure: 'direct',
              description: 'local files',
            },
            docs: { url: SERVER_URL, headers: { Authorization: 'Bearer real-token' } },
            paused: { command: 'uvx', enabled: false },
          },
        },
      }),
    );
    db.prepare('INSERT INTO mcp_oauth_credentials (server_name, server_url) VALUES (?, ?)').run(
      'docs',
      SERVER_URL,
    );
    stub.tools.set('filesystem', [makeTool('read_file'), makeTool('write_file')]);
    stub.states.set(
      'filesystem',
      makeState('filesystem', {
        state: 'connected',
        connectedAt: 42,
        protocolVersion: '2025-06-18',
        serverName: 'filesystem-server',
        serverVersion: '1.2.3',
        instructionsSummary: 'Read and write files.',
        lastError: { message: 'earlier spawn ENOENT', at: 1_700_000_000_001 },
      }),
    );
    stub.states.set('docs', makeState('docs', { state: 'auth_required', authRequired: true }));

    const res = await inject({ method: 'GET', url: '/api/mcp/servers' });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<Record<string, unknown>>;
    expect(body.map((s) => s.name)).toEqual(['filesystem', 'docs', 'paused']);

    expect(body[0]).toMatchObject({
      name: 'filesystem',
      transport: 'stdio',
      enabled: true,
      exposure: 'direct',
      description: 'local files',
      state: 'connected',
      connectedAt: 42,
      toolCount: 2,
      hasCredentials: false,
      authRequired: false,
      installed: true,
      source: 'config.yaml',
      serverInfo: {
        protocolVersion: '2025-06-18',
        name: 'filesystem-server',
        version: '1.2.3',
      },
      instructionsSummary: 'Read and write files.',
      lastError: { message: 'earlier spawn ENOENT', at: 1_700_000_000_001 },
      command: 'npx',
      args: ['-y', 'server-filesystem', '/tmp'],
      envKeys: ['GITHUB_TOKEN', 'LOG_LEVEL'],
    });
    expect(body[1]).toMatchObject({
      name: 'docs',
      transport: 'http',
      state: 'auth_required',
      authRequired: true,
      hasCredentials: true,
      url: SERVER_URL,
      headerKeys: ['Authorization'],
    });
    // Absent live identity is absent from the view, not an empty object.
    expect(body[1]).not.toHaveProperty('serverInfo');
    expect(body[1]).not.toHaveProperty('lastError');
    // A disabled server is never reported as connected, whatever the manager says.
    expect(body[2]).toMatchObject({ name: 'paused', enabled: false, state: 'disabled' });
    expect(body[2].command).toBe('uvx');

    // Masking: only key names travel, never the values (§13.7).
    expect(res.body).not.toContain('ghp_real_token');
    expect(res.body).not.toContain('real-token');
  });

  it('GET /api/mcp/status counts installed / enabled / connected / authRequired / error', async () => {
    writeConfig(
      stringifyYaml({
        mcp: {
          servers: {
            a: { command: 'a' },
            b: { command: 'b' },
            c: { command: 'c', enabled: false },
            d: { command: 'd' },
          },
        },
      }),
    );
    stub.states.set('a', makeState('a', { state: 'connected' }));
    stub.states.set('b', makeState('b', { state: 'auth_required', authRequired: true }));
    stub.states.set('d', makeState('d', { state: 'error', error: 'boom', errorCount: 3 }));

    const res = await inject({ method: 'GET', url: '/api/mcp/status' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      installed: 4,
      enabled: 3,
      connected: 1,
      authRequired: 1,
      errorCount: 1,
    });
  });

  it('GET /api/mcp/servers/:name/tools reads the manager cache, so hidden tools stay visible', async () => {
    writeServerEntry('filesystem', {
      command: 'npx',
      exposure: 'deferred',
      tool_exposure: { 'write_*': 'hidden' },
      tool_enabled: { audit_log: false },
    });
    stub.tools.set('filesystem', [
      makeTool('read_file', { annotations: { readOnlyHint: true } }),
      makeTool('write_file', { title: 'Write', annotations: { destructiveHint: true } }),
      makeTool('audit_log'),
    ]);

    const res = await inject({ method: 'GET', url: '/api/mcp/servers/filesystem/tools' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      {
        name: 'mcp__filesystem__read_file',
        serverToolName: 'read_file',
        title: undefined,
        description: 'read_file description',
        exposure: 'deferred',
        enabled: true,
        approvalRisk: 'medium',
        annotations: { readOnlyHint: true },
        readOnly: true,
        destructive: false,
        idempotent: false,
        openWorld: false,
      },
      {
        name: 'mcp__filesystem__write_file',
        serverToolName: 'write_file',
        title: 'Write',
        description: 'write_file description',
        exposure: 'hidden',
        enabled: true,
        approvalRisk: 'medium',
        annotations: { destructiveHint: true },
        readOnly: false,
        destructive: true,
        idempotent: false,
        openWorld: false,
      },
      // Switched off in `tool_enabled` — still listed, so the UI can switch it
      // back on, but `enabled: false`.
      {
        name: 'mcp__filesystem__audit_log',
        serverToolName: 'audit_log',
        title: undefined,
        description: 'audit_log description',
        exposure: 'deferred',
        enabled: false,
        approvalRisk: 'medium',
        readOnly: false,
        destructive: false,
        idempotent: false,
        openWorld: false,
      },
    ]);
  });

  it('derives a tool approvalRisk from its registered capability', async () => {
    writeServerEntry('filesystem', { command: 'npx' });
    stub.tools.set('filesystem', [makeTool('read_file'), makeTool('rm_rf')]);
    // The manager registers this descriptor on connect (`capabilityFromAnnotations`,
    // §8.2). `approvalRiskForTool()` reads it back by the registered name.
    registerToolCapability('mcp__filesystem__read_file', {
      category: 'mcp',
      readOnly: true,
      readsFiles: false,
      writesFiles: false,
      usesShell: false,
      usesNetwork: false,
      usesComputerUse: false,
      pathAccess: 'none',
      approvalDefault: 'none',
    });
    registerToolCapability('mcp__filesystem__rm_rf', {
      category: 'mcp',
      readOnly: false,
      readsFiles: false,
      writesFiles: false,
      usesShell: false,
      usesNetwork: false,
      usesComputerUse: false,
      pathAccess: 'none',
      approvalDefault: 'high_risk',
    });

    try {
      const res = await inject({ method: 'GET', url: '/api/mcp/servers/filesystem/tools' });
      expect(res.statusCode).toBe(200);
      const tools = res.json() as Array<{ serverToolName: string; approvalRisk: string }>;
      expect(tools.map((tool) => [tool.serverToolName, tool.approvalRisk])).toEqual([
        ['read_file', 'low'],
        ['rm_rf', 'high'],
      ]);
    } finally {
      unregisterToolCapability('mcp__filesystem__read_file');
      unregisterToolCapability('mcp__filesystem__rm_rf');
    }
  });

  it('answers 404 for an unknown server on every :name route', async () => {
    const urls = [
      { method: 'GET' as const, url: '/api/mcp/servers/ghost/tools' },
      { method: 'GET' as const, url: '/api/mcp/servers/ghost/logs' },
      { method: 'GET' as const, url: '/api/mcp/servers/ghost/resources' },
      { method: 'GET' as const, url: '/api/mcp/servers/ghost/raw' },
      { method: 'POST' as const, url: '/api/mcp/servers/ghost/reconnect' },
      { method: 'POST' as const, url: '/api/mcp/servers/ghost/login' },
      { method: 'POST' as const, url: '/api/mcp/servers/ghost/logout' },
      { method: 'DELETE' as const, url: '/api/mcp/servers/ghost' },
      { method: 'PATCH' as const, url: '/api/mcp/servers/ghost', payload: { enabled: false } },
      {
        method: 'PUT' as const,
        url: '/api/mcp/servers/ghost',
        payload: { name: 'ghost', command: 'x' },
      },
    ];

    for (const url of urls) {
      const res = await inject(url);
      expect(res.statusCode, `${url.method} ${url.url}`).toBe(404);
      expect(res.json()).toMatchObject({ error: 'mcp.error.serverNotFound' });
    }
  });

  it('does not treat prototype names as existing servers', async () => {
    writeServerEntry('filesystem', { command: 'npx' });

    // `servers['__proto__']` resolves through the prototype chain, so plain
    // property access used to answer 200 for these on DELETE/PATCH.
    for (const name of ['__proto__', 'toString', 'constructor']) {
      const del = await inject({ method: 'DELETE', url: `/api/mcp/servers/${name}` });
      expect(del.statusCode, `DELETE ${name}`).toBe(404);

      const patch = await inject({
        method: 'PATCH',
        url: `/api/mcp/servers/${name}`,
        payload: { enabled: false },
      });
      expect(patch.statusCode, `PATCH ${name}`).toBe(404);
    }

    // …and the real entry is untouched.
    expect(rawServer('filesystem')).toMatchObject({ command: 'npx' });
  });

  it('GET /api/mcp/logs falls back to the manager stderr tail without a log file', async () => {
    writeServerEntry('filesystem', { command: 'npx' });

    const res = await inject({ method: 'GET', url: '/api/mcp/servers/filesystem/logs?lines=2' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ lines: [] });

    stub.states.set('filesystem', makeState('filesystem', { stderrTail: 'line 1\nline 2\n' }));
    const withTail = await inject({ method: 'GET', url: '/api/mcp/servers/filesystem/logs' });
    expect(withTail.json()).toEqual({ lines: ['line 1', 'line 2'] });
  });

  it('GET /api/mcp/servers/:name/logs tails the server log file', async () => {
    writeServerEntry('filesystem', { command: 'npx' });
    writeFileSync(join(logDir, 'mcp-filesystem.log'), 'a\nb\nc\nd\n', 'utf-8');

    const res = await inject({ method: 'GET', url: '/api/mcp/servers/filesystem/logs?lines=2' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ lines: ['c', 'd'] });
  });

  it('GET /api/mcp/servers/:name/logs honours ?lines on the in-memory fallback', async () => {
    writeServerEntry('filesystem', { command: 'npx' });
    stub.states.set('filesystem', makeState('filesystem', { stderrTail: 'one\ntwo\nthree\n' }));

    const res = await inject({ method: 'GET', url: '/api/mcp/servers/filesystem/logs?lines=1' });

    expect(res.statusCode).toBe(200);
    // Before the fix the fallback returned every line and ignored `lines`.
    expect(res.json()).toEqual({ lines: ['three'] });
  });

  it('GET /api/mcp/servers/:name/logs ignores a non-numeric or negative ?lines', async () => {
    writeServerEntry('filesystem', { command: 'npx' });
    stub.states.set('filesystem', makeState('filesystem', { stderrTail: 'one\ntwo\nthree\n' }));

    for (const query of ['lines=-1', 'lines=0', 'lines=1.5', 'lines=abc']) {
      const res = await inject({
        method: 'GET',
        url: `/api/mcp/servers/filesystem/logs?${query}`,
      });
      expect(res.statusCode).toBe(200);
      // A bad value falls back to the default, never to a negative slice.
      expect(res.json()).toEqual({ lines: ['one', 'two', 'three'] });
    }
  });

  it('GET /api/mcp/presets returns the static catalogue', async () => {
    const res = await inject({ method: 'GET', url: '/api/mcp/presets' });

    expect(res.statusCode).toBe(200);
    const presets = res.json() as Array<Record<string, unknown>>;
    expect(presets.length).toBeGreaterThan(0);
    for (const preset of presets) {
      expect(typeof preset.id).toBe('string');
      expect(['stdio', 'http']).toContain(preset.transport);
      expect(Array.isArray(preset.env)).toBe(true);
    }
  });

  // ─── section settings (§13.3 connect timeout) ───

  it('GET /api/mcp/settings answers the effective connect timeout', async () => {
    const absent = await inject({ method: 'GET', url: '/api/mcp/settings' });
    expect(absent.statusCode).toBe(200);
    expect(absent.json()).toEqual({ connectTimeoutSec: DEFAULT_MCP_SECTION.connectTimeoutSec });

    writeConfig(stringifyYaml({ mcp: { connect_timeout_sec: 90 } }, { indent: 2 }));
    const configured = await inject({ method: 'GET', url: '/api/mcp/settings' });
    expect(configured.json()).toEqual({ connectTimeoutSec: 90 });
  });

  it('PATCH /api/mcp/settings writes connect_timeout_sec and hot-reloads', async () => {
    const res = await inject({
      method: 'PATCH',
      url: '/api/mcp/settings',
      payload: { connectTimeoutSec: 90 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, connectTimeoutSec: 90 });
    expect(readRawConfig().mcp).toMatchObject({ connect_timeout_sec: 90 });
    expect(stub.reload).toHaveBeenCalledTimes(1);
    expect(onConfigSaved).toHaveBeenCalled();
  });

  it('PATCH /api/mcp/settings rejects invalid values with 400', async () => {
    for (const connectTimeoutSec of [0, -1, 1.5, '60']) {
      const res = await inject({
        method: 'PATCH',
        url: '/api/mcp/settings',
        payload: { connectTimeoutSec },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'mcp.error.invalidBody' });
    }
  });

  it('PATCH /api/mcp/settings with an empty body clears the key back to the default', async () => {
    // The WebUI sends `{}` when the field is cleared — the loader then fills
    // the default and the WebUI shows it again on the next refresh.
    writeConfig(stringifyYaml({ mcp: { connect_timeout_sec: 90 } }, { indent: 2 }));

    const res = await inject({ method: 'PATCH', url: '/api/mcp/settings', payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      connectTimeoutSec: DEFAULT_MCP_SECTION.connectTimeoutSec,
    });
    expect(readRawConfig().mcp).not.toHaveProperty('connect_timeout_sec');
    expect(stub.reload).toHaveBeenCalledTimes(1);
    expect(onConfigSaved).toHaveBeenCalled();

    const absent = await inject({ method: 'GET', url: '/api/mcp/settings' });
    expect(absent.json()).toEqual({ connectTimeoutSec: DEFAULT_MCP_SECTION.connectTimeoutSec });
  });

  // ─── resources (§13.6) ───

  it('GET /api/mcp/servers/:name/resources distinguishes unsupported, offline and live', async () => {
    writeServerEntry('docs', { url: SERVER_URL });

    // Does not declare the capability — a normal state, not an error.
    stub.states.set('docs', makeState('docs', { supportsResources: false }));
    const unsupported = await inject({ method: 'GET', url: '/api/mcp/servers/docs/resources' });
    expect(unsupported.statusCode).toBe(200);
    expect(unsupported.json()).toEqual({ supported: false, connected: true, resources: [] });
    expect(stub.listResources).not.toHaveBeenCalled();

    // Declares it, nothing is up to answer right now.
    stub.states.set('docs', makeState('docs', { state: 'disconnected', supportsResources: true }));
    const offline = await inject({ method: 'GET', url: '/api/mcp/servers/docs/resources' });
    expect(offline.statusCode).toBe(200);
    expect(offline.json()).toEqual({ supported: true, connected: false, resources: [] });

    // Connected: concrete resources and templates share one array.
    stub.states.set('docs', makeState('docs', { supportsResources: true }));
    stub.listResources.mockResolvedValue({
      resources: [
        { uri: 'file:///readme.md', name: 'readme', mimeType: 'text/markdown' },
        { uri: 'file:///empty.txt', name: 'empty' },
      ],
    });
    stub.listResourceTemplates.mockResolvedValue({
      resourceTemplates: [{ uriTemplate: 'file:///{path}', name: 'any-file' }],
    });

    const live = await inject({ method: 'GET', url: '/api/mcp/servers/docs/resources' });
    expect(live.statusCode).toBe(200);
    expect(live.json()).toEqual({
      supported: true,
      connected: true,
      resources: [
        {
          server: 'docs',
          template: false,
          uri: 'file:///readme.md',
          name: 'readme',
          mimeType: 'text/markdown',
        },
        { server: 'docs', template: false, uri: 'file:///empty.txt', name: 'empty' },
        { server: 'docs', template: true, uriTemplate: 'file:///{path}', name: 'any-file' },
      ],
    });
  });

  it('GET /api/mcp/servers/:name/resources reports a failed listing as 502', async () => {
    writeServerEntry('docs', { url: SERVER_URL });
    stub.states.set('docs', makeState('docs', { supportsResources: true }));
    stub.listResources.mockRejectedValue(new Error('transport closed'));

    const res = await inject({ method: 'GET', url: '/api/mcp/servers/docs/resources' });

    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: 'mcp.error.resourceListFailed' });
    expect(res.json().message).toContain('transport closed');
  });

  // ─── raw config fragment (§13.6) ───

  it('GET /api/mcp/servers/:name/raw returns the masked config.yaml fragment', async () => {
    process.env.TEAM_ID = 'acme';
    try {
      writeServerEntry('docs', {
        url: SERVER_URL,
        headers: {
          Authorization: 'Bearer real-token',
          'X-Team': '${TEAM_ID}',
          'X-Env': 'prod',
        },
        oauth: { client_id: 'cid', client_secret: '${OAUTH_SECRET}' },
      });

      const res = await inject({ method: 'GET', url: '/api/mcp/servers/docs/raw' });

      expect(res.statusCode).toBe(200);
      const yaml = (res.json() as { yaml: string }).yaml;
      expect(yaml).toContain('docs:');
      // i18n/ENV: the raw file, not the loaded config — no expansion, no defaults.
      expect(yaml).toContain('X-Team: ${TEAM_ID}');
      expect(yaml).not.toContain('acme');
      expect(yaml).not.toContain('enabled:');
      expect(yaml).not.toContain('exposure:');
      // Named secrets are masked…
      expect(yaml).toContain(`Authorization: ${MASKED_SECRET}`);
      expect(res.body).not.toContain('real-token');
      // …but a pure placeholder is a reference, not a secret, and survives.
      expect(yaml).toContain('client_secret: ${OAUTH_SECRET}');
      expect(yaml).toContain('X-Env: prod');
    } finally {
      delete process.env.TEAM_ID;
    }
  });

  it('GET /api/mcp/servers/:name/raw reports a name with no raw mapping as a state', async () => {
    // An own key whose value is not a mapping: the name exists, the fragment does not.
    writeConfig('mcp:\n  servers:\n    docs:\n');

    const res = await inject({ method: 'GET', url: '/api/mcp/servers/docs/raw' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ yaml: null, reason: 'notPresentInRawConfig' });
  });

  // ─── GET /api/config (E3: the source the edit form loads) ───

  it('GET /api/config serves the masked RAW mcp entry so a save cannot bake in ${ENV}', async () => {
    process.env.TEAM_ID = 'acme';
    const configApp = Fastify({ logger: false });
    registerConfigRoutes(configApp, { getConfig, configPath });
    await configApp.ready();
    try {
      writeServerEntries({
        docs: {
          url: SERVER_URL,
          headers: { Authorization: '${DOCS_TOKEN}', 'X-Team': '${TEAM_ID}' },
          oauth: { client_id: 'cid', client_secret: 'shh' },
        },
        filesystem: { command: 'npx', env: { GITHUB_TOKEN: 'ghp_real_token' } },
      });

      const res = await configApp.inject({ method: 'GET', url: '/api/config' });
      expect(res.statusCode).toBe(200);

      const servers = (res.json() as { mcp: { servers: Record<string, Record<string, unknown>> } })
        .mcp.servers;

      // Raw shape: snake_case, no normalisation, no defaults. The `${DOCS_TOKEN}`
      // placeholder is a reference, not a secret, so it survives verbatim.
      expect(servers.docs).toEqual({
        url: SERVER_URL,
        headers: { Authorization: '${DOCS_TOKEN}', 'X-Team': '${TEAM_ID}' },
        oauth: { client_id: 'cid', client_secret: MASKED_SECRET },
      });
      expect(servers.filesystem).toEqual({
        command: 'npx',
        env: { GITHUB_TOKEN: MASKED_SECRET },
      });

      // The bug this replaces: the normalised view expanded `${TEAM_ID}` to
      // `acme` and filled in `enabled: true` / `exposure: deferred`, so the next
      // save rewrote config.yaml with the expansion and the placeholder was gone.
      expect(res.body).not.toContain('acme');
      expect(res.body).not.toContain('ghp_real_token');
      expect(res.body).not.toContain('Bearer');
    } finally {
      await configApp.close();
      delete process.env.TEAM_ID;
    }
  });

  it('serves the raw entry to the edit form even when that entry is skipped by the loader', async () => {
    const configApp = Fastify({ logger: false });
    registerConfigRoutes(configApp, { getConfig, configPath });
    await configApp.ready();
    try {
      // `command` together with `url` — `normaliseMcpSection()` skips it.
      writeServerEntries({ broken: { command: 'npx', url: SERVER_URL } });

      const res = await configApp.inject({ method: 'GET', url: '/api/config' });
      const servers = (res.json() as { mcp: { servers: Record<string, unknown> } }).mcp.servers;
      expect(servers.broken).toEqual({ command: 'npx', url: SERVER_URL });
    } finally {
      await configApp.close();
    }
  });

  // ─── install / update ───

  it('POST /api/mcp/servers writes a snake_case entry, reconciles and hot-reloads', async () => {
    const cwdDir = join(scratch, 'server-cwd');
    mkdirSync(cwdDir);
    const res = await inject({
      method: 'POST',
      url: '/api/mcp/servers',
      payload: {
        name: 'filesystem',
        command: 'npx',
        args: ['-y', 'server-filesystem', '/tmp'],
        env: { GITHUB_TOKEN: 'ghp_real_token', LOG_LEVEL: 'debug' },
        cwd: cwdDir,
        description: 'local files',
        exposure: 'direct',
        timeoutSec: 30,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: true,
      server: {
        name: 'filesystem',
        transport: 'stdio',
        enabled: true,
        exposure: 'direct',
        state: 'disconnected',
        timeoutSec: 30,
      },
    });
    expect(res.body).not.toContain('ghp_real_token');

    expect(rawServer('filesystem')).toEqual({
      enabled: true,
      exposure: 'direct',
      description: 'local files',
      timeout_sec: 30,
      command: 'npx',
      args: ['-y', 'server-filesystem', '/tmp'],
      env: { GITHUB_TOKEN: 'ghp_real_token', LOG_LEVEL: 'debug' },
      cwd: cwdDir,
    });
    expect(stub.reload).toHaveBeenCalledTimes(1);
    expect(onConfigSaved).toHaveBeenCalledTimes(1);
  });

  it('POST /api/mcp/servers rejects a cwd that does not exist', async () => {
    const missing = join(scratch, 'nowhere');
    const res = await inject({
      method: 'POST',
      url: '/api/mcp/servers',
      payload: { name: 'filesystem', command: 'npx', cwd: missing },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'mcp.error.cwdNotFound' });
    expect(res.json().message).toContain(missing);
    // The broken entry is never written and nothing is hot-reloaded.
    expect(readRawConfig().mcp).toBeUndefined();
    expect(stub.reload).not.toHaveBeenCalled();
    expect(onConfigSaved).not.toHaveBeenCalled();
  });

  it('POST /api/mcp/servers rejects a cwd that points at a file', async () => {
    const filePath = join(scratch, 'not-a-dir.yaml');
    writeFileSync(filePath, 'x: 1\n', 'utf-8');
    const res = await inject({
      method: 'POST',
      url: '/api/mcp/servers',
      payload: { name: 'filesystem', command: 'npx', cwd: filePath },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'mcp.error.cwdNotFound' });
    expect(readRawConfig().mcp).toBeUndefined();
  });

  it('PUT /api/mcp/servers/:name rejects a cwd that does not exist', async () => {
    writeServerEntry('filesystem', { command: 'npx' });
    const missing = join(scratch, 'nowhere');
    const res = await inject({
      method: 'PUT',
      url: '/api/mcp/servers/filesystem',
      payload: { name: 'filesystem', command: 'npx', cwd: missing },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'mcp.error.cwdNotFound' });
    // The stored entry is untouched.
    expect(rawServer('filesystem')).toEqual({ command: 'npx' });
  });

  it('anchors a relative cwd to the agent home instead of the launch cwd', async () => {
    const previousHome = process.env.OHMYAGENT_HOME;
    process.env.OHMYAGENT_HOME = scratch;
    resetAgentHomeCache();
    try {
      mkdirSync(join(scratch, 'data', 'excel-mcp'), { recursive: true });
      const res = await inject({
        method: 'POST',
        url: '/api/mcp/servers',
        payload: { name: 'excel', command: 'npx', cwd: './data/excel-mcp' },
      });

      expect(res.statusCode).toBe(200);
      // Stored raw and relative; the transport resolves it at spawn time.
      expect(rawServer('excel')).toMatchObject({ cwd: './data/excel-mcp' });
    } finally {
      if (previousHome === undefined) delete process.env.OHMYAGENT_HOME;
      else process.env.OHMYAGENT_HOME = previousHome;
      resetAgentHomeCache();
    }
  });

  it('POST /api/mcp/servers writes an HTTP entry with masked-only headers on the way out', async () => {
    const res = await inject({
      method: 'POST',
      url: '/api/mcp/servers',
      payload: {
        name: 'docs',
        url: SERVER_URL,
        headers: { Authorization: 'Bearer real-token', 'X-Api-Key': 'key-1' },
        oauth: { clientId: 'cid', clientSecret: 'shhh', scope: 'read' },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().server).toMatchObject({
      name: 'docs',
      transport: 'http',
      url: SERVER_URL,
      headerKeys: ['Authorization', 'X-Api-Key'],
    });
    expect(res.body).not.toContain('real-token');
    expect(res.body).not.toContain('shhh');

    expect(rawServer('docs')).toEqual({
      enabled: true,
      exposure: 'deferred',
      url: SERVER_URL,
      headers: { Authorization: 'Bearer real-token', 'X-Api-Key': 'key-1' },
      oauth: { client_id: 'cid', client_secret: 'shhh', scope: 'read' },
    });
  });

  it('PUT /api/mcp/servers/:name keeps stored secrets when the client echoes a masked value', async () => {
    writeServerEntry('filesystem', {
      command: 'npx',
      env: { GITHUB_TOKEN: 'ghp_real_token' },
      exposure: 'deferred',
    });

    const res = await inject({
      method: 'PUT',
      url: '/api/mcp/servers/filesystem',
      payload: {
        name: 'filesystem',
        command: 'uvx',
        env: { GITHUB_TOKEN: MASKED_SECRET, NEW_TOKEN: MASKED_SECRET, LOG_LEVEL: 'warn' },
        exposure: 'hidden',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, server: { command: 'uvx', exposure: 'hidden' } });

    // The stored secret survives; the mask is never written as a literal secret,
    // and a mask with nothing behind it is dropped rather than stored.
    expect(rawServer('filesystem')).toEqual({
      enabled: true,
      exposure: 'hidden',
      command: 'uvx',
      env: { GITHUB_TOKEN: 'ghp_real_token', LOG_LEVEL: 'warn' },
    });
  });

  it('PUT keeps the stored OAuth secret when the raw view echoed the mask back', async () => {
    // The round trip the edit form performs: load the raw entry (masked), save it.
    writeServerEntry('docs', {
      url: SERVER_URL,
      headers: { Authorization: 'Bearer real-token' },
      oauth: { client_id: 'cid', client_secret: 'shh', scope: 'read' },
    });

    const res = await inject({
      method: 'PUT',
      url: '/api/mcp/servers/docs',
      payload: {
        name: 'docs',
        url: SERVER_URL,
        headers: { Authorization: MASKED_SECRET },
        oauth: { clientId: 'cid', clientSecret: MASKED_SECRET, scope: 'read' },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(rawServer('docs')).toEqual({
      enabled: true,
      exposure: 'deferred',
      url: SERVER_URL,
      headers: { Authorization: 'Bearer real-token' },
      oauth: { client_id: 'cid', client_secret: 'shh', scope: 'read' },
    });
  });

  it('POST /api/mcp/servers rejects a duplicate name after -/_ normalisation', async () => {
    writeServerEntry('my-server', { command: 'x' });

    const res = await inject({
      method: 'POST',
      url: '/api/mcp/servers',
      payload: { name: 'my_server', command: 'y' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'mcp.error.nameTaken' });
    expect(res.json().message).toContain('my-server');
    expect(rawServer('my_server')).toBeUndefined();
  });

  it('blocks a duplicate of an entry the loader skipped instead of creating a config that will not boot', async () => {
    // `command` + `url` fails the raw schema, so the loader drops this entry:
    // only the raw map knows it exists.
    writeServerEntries({
      'my-server': { command: 'npx', url: SERVER_URL },
      keep: { command: 'npx' },
    });
    expect(getConfig().mcp?.servers['my-server']).toBeUndefined();

    const res = await inject({
      method: 'POST',
      url: '/api/mcp/servers',
      payload: { name: 'my_server', command: 'npx' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'mcp.error.nameTaken' });
    expect(res.json().message).toContain('my-server');
    // Nothing was written: the canonical duplicate check on the next load would
    // have thrown, and the gateway would not have started.
    expect(readRawConfig()).toMatchObject({
      mcp: { servers: { 'my-server': { command: 'npx' } } },
    });
  });

  it('makes an entry the loader skipped visible, editable and deletable', async () => {
    writeServerEntries({ broken: { command: 'npx', url: SERVER_URL } });

    // Visible: the raw fragment is served…
    const raw = await inject({ method: 'GET', url: '/api/mcp/servers/broken/raw' });
    expect(raw.statusCode).toBe(200);
    expect(raw.json().yaml).toContain('broken:');

    // …and the tool list is an honest empty one rather than a 404.
    const tools = await inject({ method: 'GET', url: '/api/mcp/servers/broken/tools' });
    expect(tools.statusCode).toBe(200);
    expect(tools.json()).toEqual([]);

    // Editable: a patch edits the raw entry in place.
    const patched = await inject({
      method: 'PATCH',
      url: '/api/mcp/servers/broken',
      payload: { description: 'still broken' },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toEqual({ ok: true });
    expect(rawServer('broken')).toEqual({
      command: 'npx',
      url: SERVER_URL,
      description: 'still broken',
    });

    // Deletable: the whole point — a skipped entry used to 404 forever.
    const removed = await inject({ method: 'DELETE', url: '/api/mcp/servers/broken' });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toEqual({ ok: true, removedTools: 0 });
    expect(rawServer('broken')).toBeUndefined();
  });

  it('PUT /api/mcp/servers/:name rejects a rename', async () => {
    writeServerEntry('filesystem', { command: 'x' });

    const res = await inject({
      method: 'PUT',
      url: '/api/mcp/servers/filesystem',
      payload: { name: 'renamed', command: 'x' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'mcp.error.renameUnsupported' });
  });

  it('rejects invalid bodies with 400 and a useful message', async () => {
    const cases: Array<{ payload: unknown; expect: string }> = [
      { payload: { name: 'ok' }, expect: 'mcp.error.endpointRequired' },
      { payload: { name: 'ok', command: 'x', url: 'https://x' }, expect: 'mcp.error.endpointBoth' },
      {
        payload: { name: 'ok', url: 'https://example.com/sse' },
        expect: 'mcp.error.sseUnsupported',
      },
      { payload: { name: 'bad name', command: 'x' }, expect: 'mcp.error.invalidBody' },
      {
        payload: { name: 'ok', command: 'x', exposure: 'codemode' },
        expect: 'mcp.error.invalidBody',
      },
      {
        payload: { name: 'ok', command: 'x', unknownField: true },
        expect: 'mcp.error.invalidBody',
      },
      { payload: { command: 'x' }, expect: 'mcp.error.invalidBody' },
    ];

    for (const testCase of cases) {
      const res = await inject({
        method: 'POST',
        url: '/api/mcp/servers',
        payload: testCase.payload,
      });
      expect(res.statusCode, JSON.stringify(testCase.payload)).toBe(400);
      expect(res.json()).toMatchObject({ error: testCase.expect });
      expect(res.json().message).toBeTruthy();
      expect(res.body).not.toContain('mcp-routes.ts');
    }
  });

  it('POST /api/mcp/servers treats an empty command as "not provided"', async () => {
    // The install form clears the unused transport's field to '' rather than
    // dropping it; writing that alongside `url` would produce an entry the
    // config loader rejects on the next start.
    const res = await inject({
      method: 'POST',
      url: '/api/mcp/servers',
      payload: { name: 'docs', command: '', url: SERVER_URL },
    });

    expect(res.statusCode).toBe(200);
    expect(rawServer('docs')).toEqual({
      enabled: true,
      exposure: 'deferred',
      url: SERVER_URL,
    });
  });

  it('serialises concurrent config writes so neither install is lost', async () => {
    const [first, second] = await Promise.all([
      inject({ method: 'POST', url: '/api/mcp/servers', payload: { name: 'alpha', command: 'a' } }),
      inject({ method: 'POST', url: '/api/mcp/servers', payload: { name: 'beta', command: 'b' } }),
    ]);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(rawServer('alpha')).toMatchObject({ command: 'a' });
    expect(rawServer('beta')).toMatchObject({ command: 'b' });
    // `log_level` was already in the file — the read-modify-write must keep it.
    expect(readRawConfig().log_level).toBe('info');
  });

  // ─── patch / delete ───

  it('PATCH /api/mcp/servers/:name toggles enablement and tool exposure without dropping the entry', async () => {
    writeServerEntry('filesystem', {
      command: 'npx',
      args: ['-y', 'x'],
      env: { GITHUB_TOKEN: 'ghp_real_token' },
    });

    const disabled = await inject({
      method: 'PATCH',
      url: '/api/mcp/servers/filesystem',
      payload: { enabled: false },
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json().server).toMatchObject({ enabled: false, state: 'disabled' });
    expect(rawServer('filesystem')?.enabled).toBe(false);

    const exposure = await inject({
      method: 'PATCH',
      url: '/api/mcp/servers/filesystem',
      payload: { tool_exposure: { write_file: 'hidden' }, description: 'local files' },
    });
    expect(exposure.statusCode).toBe(200);
    expect(exposure.json().server).toMatchObject({
      toolExposure: { write_file: 'hidden' },
      description: 'local files',
    });

    expect(rawServer('filesystem')).toEqual({
      enabled: false,
      command: 'npx',
      args: ['-y', 'x'],
      env: { GITHUB_TOKEN: 'ghp_real_token' },
      tool_exposure: { write_file: 'hidden' },
      description: 'local files',
    });
    expect(stub.reload).toHaveBeenCalledTimes(2);
  });

  it('PATCH merges tool_enabled per key and persists it under the server', async () => {
    writeServerEntry('filesystem', {
      command: 'npx',
      tool_enabled: { audit_log: false, write_file: true },
    });

    const disabled = await inject({
      method: 'PATCH',
      url: '/api/mcp/servers/filesystem',
      payload: { tool_enabled: { read_file: false } },
    });
    expect(disabled.statusCode).toBe(200);
    // Merge, not replace: the other overrides survive.
    expect(rawServer('filesystem')?.tool_enabled).toEqual({
      audit_log: false,
      write_file: true,
      read_file: false,
    });

    const cleared = await inject({
      method: 'PATCH',
      url: '/api/mcp/servers/filesystem',
      payload: { tool_enabled: { audit_log: null, write_file: null, read_file: null } },
    });
    expect(cleared.statusCode).toBe(200);
    // Every override cleared — the key goes away rather than holding nulls.
    expect(rawServer('filesystem')).not.toHaveProperty('tool_enabled');
    expect(stub.reload).toHaveBeenCalledTimes(2);
  });

  it('carries toolEnabled through POST and PUT as well', async () => {
    const installed = await inject({
      method: 'POST',
      url: '/api/mcp/servers',
      payload: { name: 'filesystem', command: 'npx', toolEnabled: { audit_log: false } },
    });
    expect(installed.statusCode).toBe(200);
    expect(rawServer('filesystem')?.tool_enabled).toEqual({ audit_log: false });

    const updated = await inject({
      method: 'PUT',
      url: '/api/mcp/servers/filesystem',
      payload: { name: 'filesystem', command: 'npx', toolEnabled: { audit_log: true } },
    });
    expect(updated.statusCode).toBe(200);
    expect(rawServer('filesystem')?.tool_enabled).toEqual({ audit_log: true });
  });

  it('reports a just-enabled server as connecting until the manager catches up', async () => {
    writeServerEntry('filesystem', { command: 'npx', enabled: false });
    stub.states.set('filesystem', makeState('filesystem', { state: 'disabled' }));

    const res = await inject({
      method: 'PATCH',
      url: '/api/mcp/servers/filesystem',
      payload: { enabled: true },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().server).toMatchObject({ enabled: true, state: 'connecting' });
  });

  it('PATCH rejects an unknown field and an unknown exposure value', async () => {
    writeServerEntry('filesystem', { command: 'npx' });

    for (const payload of [{ exposure: 'codemode' }, { toolExposure: { a: 'hidden' } }]) {
      const res = await inject({
        method: 'PATCH',
        url: '/api/mcp/servers/filesystem',
        payload,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'mcp.error.invalidBody' });
    }
  });

  it('DELETE removes the entry and reports the removed tool count', async () => {
    writeServerEntry('filesystem', { command: 'npx' });
    stub.tools.set('filesystem', [makeTool('read_file'), makeTool('write_file')]);

    const res = await inject({ method: 'DELETE', url: '/api/mcp/servers/filesystem' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, removedTools: 2 });
    expect(rawServer('filesystem')).toBeUndefined();
    expect(stub.reload).toHaveBeenCalledTimes(1);
  });

  it('DELETE keeps OAuth credentials unless purge_credentials=true', async () => {
    writeServerEntries({ filesystem: { command: 'npx' }, docs: { url: SERVER_URL } });
    const insert = db.prepare(
      'INSERT INTO mcp_oauth_credentials (server_name, server_url) VALUES (?, ?)',
    );
    insert.run('filesystem', SERVER_URL);
    insert.run('docs', SERVER_URL);

    const kept = await inject({
      method: 'DELETE',
      url: '/api/mcp/servers/filesystem?purge_credentials=false',
    });
    expect(kept.statusCode).toBe(200);
    expect(
      db.prepare('SELECT 1 FROM mcp_oauth_credentials WHERE server_name = ?').get('filesystem'),
    ).toBeDefined();

    const purged = await inject({
      method: 'DELETE',
      url: '/api/mcp/servers/docs?purge_credentials=true',
    });
    expect(purged.statusCode).toBe(200);
    expect(
      db.prepare('SELECT 1 FROM mcp_oauth_credentials WHERE server_name = ?').get('docs'),
    ).toBeUndefined();
    // The purge only touches the named server.
    expect(
      db.prepare('SELECT 1 FROM mcp_oauth_credentials WHERE server_name = ?').get('filesystem'),
    ).toBeDefined();
  });

  it('DELETE rejects a malformed purge_credentials query', async () => {
    writeServerEntry('filesystem', { command: 'npx' });

    const res = await inject({
      method: 'DELETE',
      url: '/api/mcp/servers/filesystem?purge_credentials=maybe',
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'mcp.error.invalidBody' });
    expect(rawServer('filesystem')).toBeDefined();
  });

  // ─── lifecycle ───

  it('POST reconnect reports a connected state and the tool list', async () => {
    writeServerEntry('filesystem', { command: 'npx' });
    stub.tools.set('filesystem', [makeTool('read_file')]);

    const res = await inject({ method: 'POST', url: '/api/mcp/servers/filesystem/reconnect' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, state: 'connected' });
    expect(res.json().tools).toEqual([
      expect.objectContaining({
        name: 'mcp__filesystem__read_file',
        serverToolName: 'read_file',
      }),
    ]);
    expect(stub.reconnect).toHaveBeenCalledWith('filesystem');
  });

  it('POST reconnect surfaces a failed reconnect as an error, without internals', async () => {
    writeServerEntry('filesystem', { command: 'npx' });
    stub.reconnect.mockResolvedValue(
      makeState('filesystem', { state: 'error', error: 'spawn npx ENOENT' }),
    );

    const res = await inject({ method: 'POST', url: '/api/mcp/servers/filesystem/reconnect' });

    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: 'mcp.error.connectFailed' });
    expect(res.json().message).toContain('spawn npx ENOENT');
    expect(res.json().message).not.toContain('at ');
  });

  it('POST login returns the authorization URL and login/callback submits the pasted URL', async () => {
    writeServerEntry('docs', { url: SERVER_URL });

    const login = await inject({ method: 'POST', url: '/api/mcp/servers/docs/login' });
    expect(login.statusCode).toBe(200);
    expect(login.json()).toEqual({
      ok: true,
      authorizationUrl: 'https://auth.example/authorize',
      manual: true,
    });

    const callback = await inject({
      method: 'POST',
      url: '/api/mcp/servers/docs/login/callback',
      payload: { callbackUrl: 'http://127.0.0.1:8765/callback?code=abc' },
    });
    expect(callback.statusCode).toBe(200);
    expect(callback.json()).toEqual({ ok: true });
    expect(stub.submitCallback).toHaveBeenCalledWith(
      'docs',
      'http://127.0.0.1:8765/callback?code=abc',
    );
  });

  it('POST login/callback rejects a missing callbackUrl', async () => {
    writeServerEntry('docs', { url: SERVER_URL });

    const res = await inject({
      method: 'POST',
      url: '/api/mcp/servers/docs/login/callback',
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'mcp.error.invalidBody' });
    expect(stub.submitCallback).not.toHaveBeenCalled();
  });

  it('POST login reports an unsupported OAuth build as a handler error', async () => {
    writeServerEntry('docs', { url: SERVER_URL });
    stub.login.mockRejectedValue(new Error('MCP OAuth is not available in this build'));

    const res = await inject({ method: 'POST', url: '/api/mcp/servers/docs/login' });

    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: 'mcp.error.loginFailed' });
    expect(res.json().message).toContain('not available in this build');
  });

  it('POST logout drops credentials through the manager', async () => {
    writeServerEntry('docs', { url: SERVER_URL });

    const res = await inject({ method: 'POST', url: '/api/mcp/servers/docs/logout' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(stub.logout).toHaveBeenCalledWith('docs');
  });

  // ─── dry connect ───

  it('POST /api/mcp/test rejects a missing cwd before probing', async () => {
    const missing = join(scratch, 'nowhere');
    const res = await inject({
      method: 'POST',
      url: '/api/mcp/test',
      payload: { name: 'filesystem', command: 'npx', cwd: missing },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: false });
    expect(res.json().error).toContain(missing);
    // The stub probe never runs — the request fails validation first.
    expect(probe).not.toHaveBeenCalled();
  });

  it('POST /api/mcp/test probes without persisting, and normalises the input', async () => {
    const res = await inject({
      method: 'POST',
      url: '/api/mcp/test',
      payload: { name: 'filesystem', command: 'npx', args: ['-y', 'x'], env: { A: '1' } },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, serverInfo: { name: 'probe' }, tools: [] });
    expect(probe).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'filesystem',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'x'],
        env: { A: '1' },
        cwd: '',
      }),
    );
    expect(readRawConfig().mcp).toBeUndefined();
  });

  it('POST /api/mcp/test reports a failed dry connect as ok:false', async () => {
    probe.mockResolvedValue({ ok: false, error: 'spawn npx ENOENT', stderrTail: 'boom' });

    const res = await inject({
      method: 'POST',
      url: '/api/mcp/test',
      payload: { name: 'filesystem', command: 'npx' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: false, error: 'spawn npx ENOENT', stderrTail: 'boom' });
  });

  it('POST /api/mcp/test resolves masked values against the stored entry before probing', async () => {
    writeServerEntry('docs', {
      url: SERVER_URL,
      headers: { Authorization: 'Bearer real-token', 'X-Team': '${TEAM_ID}' },
      oauth: { client_id: 'cid', client_secret: 'shh' },
    });
    process.env.TEAM_ID = 'acme';
    try {
      const res = await inject({
        method: 'POST',
        url: '/api/mcp/test',
        payload: {
          name: 'docs',
          url: SERVER_URL,
          // Exactly what the edit form submits after loading `GET /api/config`: a
          // mark for the secret it did not touch, and the raw placeholder.
          headers: { Authorization: MASKED_SECRET, 'X-Team': '${TEAM_ID}' },
          oauth: { clientId: 'cid', clientSecret: MASKED_SECRET },
        },
      });

      expect(res.statusCode).toBe(200);
      expect(probe).toHaveBeenCalledWith(
        expect.objectContaining({
          transport: 'http',
          // The mask never reaches the probe, and the `${ENV}` placeholder is
          // resolved the way the loader would — a working config must not be
          // reported as broken.
          headers: { Authorization: 'Bearer real-token', 'X-Team': 'acme' },
        }),
      );
    } finally {
      delete process.env.TEAM_ID;
    }
  });

  it('POST /api/mcp/test drops a mask that has nothing behind it', async () => {
    const res = await inject({
      method: 'POST',
      url: '/api/mcp/test',
      payload: { name: 'docs', command: 'npx', env: { GITHUB_TOKEN: MASKED_SECRET, A: '1' } },
    });

    expect(res.statusCode).toBe(200);
    expect(probe).toHaveBeenCalledWith(expect.objectContaining({ env: { A: '1' } }));
  });

  it('POST /api/mcp/test validates the body before connecting', async () => {
    const res = await inject({ method: 'POST', url: '/api/mcp/test', payload: { name: 'x' } });

    expect(res.statusCode).toBe(400);
    expect(probe).not.toHaveBeenCalled();
  });

  // ─── no manager (config.yaml without an enabled mcp: section) ───

  it('still edits config when no manager is running, and answers 503 for runtime actions', async () => {
    app = Fastify({ logger: false });
    registerMcpRoutes(app, {
      db,
      getConfig,
      getManager: () => undefined,
      probe: probe as unknown as McpProbe,
    });
    await app.ready();

    const install = await inject({
      method: 'POST',
      url: '/api/mcp/servers',
      payload: { name: 'filesystem', command: 'npx' },
    });
    expect(install.statusCode).toBe(200);
    expect(install.json().server).toMatchObject({ name: 'filesystem', state: 'disconnected' });
    expect(rawServer('filesystem')).toMatchObject({ command: 'npx' });

    const reconnect = await inject({
      method: 'POST',
      url: '/api/mcp/servers/filesystem/reconnect',
    });
    expect(reconnect.statusCode).toBe(503);
    expect(reconnect.json()).toMatchObject({ error: 'mcp.error.managerUnavailable' });

    // Nothing is up to answer, so resources report their zero state instead of a 5xx.
    const resources = await inject({ method: 'GET', url: '/api/mcp/servers/filesystem/resources' });
    expect(resources.statusCode).toBe(200);
    expect(resources.json()).toEqual({ supported: false, connected: false, resources: [] });
  });

  it('does not leak config.yaml source lines when the file is not valid YAML', async () => {
    // The `yaml` package appends the offending line and a caret to the error
    // message; returning it verbatim echoed the secret to the client.
    writeConfig('mcp:\n  client_secret: hunter2: x\n');

    // `deps.getConfig()` is the cached config in production; a stub keeps this
    // test about the write path rather than about the harness re-parsing YAML.
    const brokenApp = Fastify({ logger: false });
    registerMcpRoutes(brokenApp, {
      db,
      getConfig: () => ({}) as AppConfig,
      getManager: () => undefined,
      probe: probe as unknown as McpProbe,
    });
    registerConfigRoutes(brokenApp, { getConfig: () => ({}) as AppConfig, configPath });
    await brokenApp.ready();
    try {
      const install = await brokenApp.inject({
        method: 'POST',
        url: '/api/mcp/servers',
        payload: { name: 'filesystem', command: 'npx' },
      });
      expect(install.statusCode).toBe(500);
      expect(install.json()).toMatchObject({ error: 'mcp.error.configWriteFailed' });
      expect(install.body).not.toContain('hunter2');
      expect(install.json().message).toContain('not valid YAML');

      // Same scrubbed reason through the generic settings save (PUT /api/config).
      const save = await brokenApp.inject({
        method: 'PUT',
        url: '/api/config',
        payload: { log_level: 'debug' },
      });
      expect(save.statusCode).toBe(500);
      expect(save.body).not.toContain('hunter2');
      expect(save.json().message).toContain('not valid YAML');
    } finally {
      await brokenApp.close();
    }
  });

  it('leaves non-MCP config untouched when no server is configured', async () => {
    writeConfig('log_level: debug\n');

    const res = await inject({ method: 'GET', url: '/api/mcp/servers' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
    expect(readRawConfig()).toEqual({ log_level: 'debug' });
  });

  // ─── URL credentials never travel back (maskUrl on every surface) ───

  const CREDENTIALED_URL = 'https://svc:omh-real-secret@host/mcp';

  it('GET /api/mcp/servers masks a credentialed URL in the server view and error fields', async () => {
    writeServerEntry('docs', { url: CREDENTIALED_URL });
    const error = `connect failed for ${CREDENTIALED_URL}: fetch failed`;
    stub.states.set(
      'docs',
      makeState('docs', { state: 'error', error, lastError: { message: error, at: 1 } }),
    );

    const res = await inject({ method: 'GET', url: '/api/mcp/servers' });

    expect(res.statusCode).toBe(200);
    const views = res.json() as unknown as Array<{ url: string; error: string }>;
    // view.url (R1) as well as view.error and view.lastError.message (r6) are
    // all masked before they reach the client.
    expect(views[0].url).toBe(`https://${MASKED_SECRET}@host/mcp`);
    expect(res.body).toContain(`https://${MASKED_SECRET}@host/mcp: fetch failed`);
    expect(res.body).not.toContain('omh-real-secret');
  });

  it('GET /api/mcp/servers/:name/raw masks credentials embedded in the raw url', async () => {
    writeServerEntry('docs', { url: CREDENTIALED_URL });

    const res = await inject({ method: 'GET', url: '/api/mcp/servers/docs/raw' });

    expect(res.statusCode).toBe(200);
    const yaml = (res.json() as { yaml: string }).yaml;
    expect(yaml).toContain(`url: https://${MASKED_SECRET}@host/mcp`);
    expect(yaml).not.toContain('omh-real-secret');
  });

  it('GET /api/config masks credentials embedded in the raw served url too', async () => {
    const configApp = Fastify({ logger: false });
    registerConfigRoutes(configApp, { getConfig, configPath });
    await configApp.ready();
    try {
      writeServerEntry('docs', { url: CREDENTIALED_URL });

      const res = await configApp.inject({ method: 'GET', url: '/api/config' });

      expect(res.statusCode).toBe(200);
      const servers = (res.json() as { mcp: { servers: Record<string, { url: string }> } }).mcp
        .servers;
      expect(servers.docs.url).toBe(`https://${MASKED_SECRET}@host/mcp`);
      expect(res.body).not.toContain('omh-real-secret');
    } finally {
      await configApp.close();
    }
  });

  it('PUT keeps the stored URL when the raw view echoed the masked URL back', async () => {
    writeServerEntry('docs', { url: CREDENTIALED_URL, exposure: 'deferred' });

    const res = await inject({
      method: 'PUT',
      url: '/api/mcp/servers/docs',
      payload: {
        name: 'docs',
        // The fragment the edit form submits: the credentials are masked, and
        // the bullet may arrive in either spelling a URL round trip produces.
        url: `https://${MASKED_SECRET}@host/mcp`,
        headers: { Accept: 'application/json' },
      },
    });

    expect(res.statusCode).toBe(200);
    // config.yaml keeps the original URL verbatim, not the literal mask.
    expect(rawServer('docs')?.url).toBe(CREDENTIALED_URL);
    expect(readFileSync(configPath, 'utf-8')).not.toContain(MASKED_SECRET);
  });

  it('PUT resolves a percent-encoding-echoed masked URL to the stored value too', async () => {
    writeServerEntry('docs', {
      url: 'https://host/mcp?access_token=real-query-secret',
      exposure: 'deferred',
    });

    // The masked query value travels percent-encoded inside the URL string in
    // some round trips — echo that exact form.
    const maskedEcho = `https://host/mcp?access_token=${encodeURIComponent(MASKED_SECRET)}`;
    const res = await inject({
      method: 'PUT',
      url: '/api/mcp/servers/docs',
      payload: { name: 'docs', url: maskedEcho },
    });

    expect(res.statusCode).toBe(200);
    expect(rawServer('docs')?.url).toBe('https://host/mcp?access_token=real-query-secret');
  });

  it('rejects a masked URL with no stored value behind it with 400', async () => {
    // POST: nothing is stored under the name at all.
    const post = await inject({
      method: 'POST',
      url: '/api/mcp/servers',
      payload: { name: 'new-docs', url: `https://${MASKED_SECRET}@host/mcp` },
    });
    expect(post.statusCode).toBe(400);
    expect(post.json().message).toContain('masked URL');
    expect(rawServer('new-docs')).toBeUndefined();

    // PUT: the entry exists but stores no url (stdio), so the mask is empty.
    writeServerEntry('filesystem', { command: 'npx' });
    const put = await inject({
      method: 'PUT',
      url: '/api/mcp/servers/filesystem',
      payload: { name: 'filesystem', url: `https://${MASKED_SECRET}@host/mcp` },
    });
    expect(put.statusCode).toBe(400);
    expect(put.json().message).toContain('masked URL');
    expect(rawServer('filesystem')?.command).toBe('npx');
    expect(readFileSync(configPath, 'utf-8')).not.toContain(MASKED_SECRET);
  });

  it('POST probes resolve a masked URL against the stored entry before connecting', async () => {
    writeServerEntry('docs', { url: CREDENTIALED_URL });

    const res = await inject({
      method: 'POST',
      url: '/api/mcp/test',
      payload: { name: 'docs', url: `https://${MASKED_SECRET}@host/mcp` },
    });

    expect(res.statusCode).toBe(200);
    expect(probe).toHaveBeenCalledWith(expect.objectContaining({ url: CREDENTIALED_URL }));
    expect(JSON.stringify(probe.mock.calls)).not.toContain(MASKED_SECRET);
  });

  // ─── node-level write: sibling entries keep their comment/formatting ───

  it('PATCH edits one entry and leaves sibling comments and quoting intact', async () => {
    // The comment sits directly above the *sibling* entry, and the sibling
    // holds a scalar whose plain form needs quoting — exactly what a whole-
    // subtree rebuild used to destroy.
    writeConfig(
      [
        'log_level: info',
        'mcp:',
        '  servers:',
        '    filesystem:',
        '      command: npx',
        '    # my server comment',
        '    other:',
        '      command: "yes"',
        '',
      ].join('\n'),
    );

    const res = await inject({
      method: 'PATCH',
      url: '/api/mcp/servers/filesystem',
      payload: { description: 'local files' },
    });

    expect(res.statusCode).toBe(200);
    const text = readFileSync(configPath, 'utf-8');
    // The sibling entry's comment and quoted scalar survive the write…
    expect(text).toContain('# my server comment');
    expect(text).toContain('"yes"');
    expect(text).toContain('log_level: info');
    // …and the target entry gained the description in place.
    expect(readRawConfig()).toMatchObject({
      mcp: { servers: { filesystem: { description: 'local files' } } },
    });
  });

  it('install and uninstall create and remove mcp/servers parents on demand', async () => {
    const install = await inject({
      method: 'POST',
      url: '/api/mcp/servers',
      payload: { name: 'filesystem', command: 'npx' },
    });
    expect(install.statusCode).toBe(200);
    expect(readRawConfig()).toMatchObject({ mcp: { servers: { filesystem: { command: 'npx' } } } });

    const remove = await inject({ method: 'DELETE', url: '/api/mcp/servers/filesystem' });
    expect(remove.statusCode).toBe(200);
    expect(readRawConfig().mcp).toBeDefined();
  });

  // ─── the canonical-duplicate check runs inside the write queue ───

  it('concurrent installs of a-b and a_b write exactly one server, one 400 nameTaken', async () => {
    writeConfig('log_level: info\n');

    const [first, second] = await Promise.all([
      inject({ method: 'POST', url: '/api/mcp/servers', payload: { name: 'a-b', command: 'a' } }),
      inject({ method: 'POST', url: '/api/mcp/servers', payload: { name: 'a_b', command: 'b' } }),
    ]);

    const statuses = [first.statusCode, second.statusCode].sort((a, b) => a - b);
    expect(statuses[0]).toBe(200); // exactly one 200
    expect(statuses[1]).toBe(400); // exactly one 400 nameTaken
    const taker = [first, second].find((r) => r.statusCode === 400);
    expect(taker && (taker.json() as { error: string }).error).toBe('mcp.error.nameTaken');

    const servers = (readRawConfig().mcp as { servers: Record<string, unknown> }).servers;
    expect(Object.keys(servers).length).toBe(1); // the file stays bootable
    expect(Object.keys(servers)[0]).toMatch(/^(a-b|a_b)$/);
  });

  // ─── error strings reaching a response body are URL-masked (r6) ───

  it('POST reconnect 502 masks a credentialed URL embedded in the error', async () => {
    writeServerEntry('docs', { url: CREDENTIALED_URL });
    stub.states.set('docs', makeState('docs', { state: 'error' }));
    stub.reconnect.mockResolvedValue(
      makeState('docs', { state: 'error', error: `fetch failed: ${CREDENTIALED_URL}` }),
    );

    const res = await inject({ method: 'POST', url: '/api/mcp/servers/docs/reconnect' });

    expect(res.statusCode).toBe(502);
    expect(res.json().message).toContain(`https://${MASKED_SECRET}@host/mcp`);
    expect(res.body).not.toContain('omh-real-secret');
  });

  it('POST login 502 masks a credentialed URL embedded in the thrown error', async () => {
    writeServerEntry('docs', { url: CREDENTIALED_URL });
    stub.login.mockRejectedValue(new Error(`authorization request failed: ${CREDENTIALED_URL}`));

    const res = await inject({ method: 'POST', url: '/api/mcp/servers/docs/login' });

    expect(res.statusCode).toBe(502);
    expect(res.json().message).toContain(`https://${MASKED_SECRET}@host/mcp`);
    expect(res.body).not.toContain('omh-real-secret');
  });
});
