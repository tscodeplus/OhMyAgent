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
import type { AppConfig } from '../../src/app/types.js';
import { normaliseMcpSection } from '../../src/mcp/config.js';
import { MASKED_SECRET } from '../../src/mcp/masking.js';
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
  };

  return { manager, reload, reconnect, login, logout, submitCallback, tools, states };
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
    stub.states.set('filesystem', makeState('filesystem', { state: 'connected', connectedAt: 42 }));
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
      oauth: false,
      authRequired: false,
      command: 'npx',
      args: ['-y', 'server-filesystem', '/tmp'],
      envKeys: ['GITHUB_TOKEN', 'LOG_LEVEL'],
    });
    expect(body[1]).toMatchObject({
      name: 'docs',
      transport: 'http',
      state: 'auth_required',
      authRequired: true,
      oauth: true,
      url: SERVER_URL,
      headerKeys: ['Authorization'],
    });
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
    });
    stub.tools.set('filesystem', [
      makeTool('read_file', { annotations: { readOnlyHint: true } }),
      makeTool('write_file', { title: 'Write', annotations: { destructiveHint: true } }),
    ]);

    const res = await inject({ method: 'GET', url: '/api/mcp/servers/filesystem/tools' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      {
        name: 'mcp__filesystem__read_file',
        rawName: 'read_file',
        title: undefined,
        description: 'read_file description',
        exposure: 'deferred',
        readOnly: true,
        destructive: false,
        idempotent: false,
        openWorld: false,
      },
      {
        name: 'mcp__filesystem__write_file',
        rawName: 'write_file',
        title: 'Write',
        description: 'write_file description',
        exposure: 'hidden',
        readOnly: false,
        destructive: true,
        idempotent: false,
        openWorld: false,
      },
    ]);
  });

  it('answers 404 for an unknown server on every :name route', async () => {
    const urls = [
      { method: 'GET' as const, url: '/api/mcp/servers/ghost/tools' },
      { method: 'GET' as const, url: '/api/mcp/servers/ghost/logs' },
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

  // ─── install / update ───

  it('POST /api/mcp/servers writes a snake_case entry, reconciles and hot-reloads', async () => {
    const res = await inject({
      method: 'POST',
      url: '/api/mcp/servers',
      payload: {
        name: 'filesystem',
        command: 'npx',
        args: ['-y', 'server-filesystem', '/tmp'],
        env: { GITHUB_TOKEN: 'ghp_real_token', LOG_LEVEL: 'debug' },
        cwd: '/tmp',
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
      cwd: '/tmp',
    });
    expect(stub.reload).toHaveBeenCalledTimes(1);
    expect(onConfigSaved).toHaveBeenCalledTimes(1);
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
      expect.objectContaining({ name: 'mcp__filesystem__read_file', rawName: 'read_file' }),
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
  });

  it('leaves non-MCP config untouched when no server is configured', async () => {
    writeConfig('log_level: debug\n');

    const res = await inject({ method: 'GET', url: '/api/mcp/servers' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
    expect(readRawConfig()).toEqual({ log_level: 'debug' });
  });
});
