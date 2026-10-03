/**
 * MCP runtime engine tests (MyDocs/MCP_INTEGRATION_DESIGN.md §6, §7, §9).
 *
 * The manager is driven end-to-end over `createInMemoryTransportPair()` — real
 * protocol traffic (initialize / tools/list / tools/call / notifications), no
 * child process and no network.
 */

import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryTransport } from '@earendil-works/pi-mcp/testing';
import type { McpTransport } from '@earendil-works/pi-mcp';
import { DEFAULT_MCP_SECTION } from '../../src/mcp/config.js';
import {
  createMcpManager,
  type McpManagerLogger,
  type McpToolRegistryLike,
} from '../../src/mcp/mcp-manager.js';
import type {
  McpManager,
  McpSectionConfig,
  McpServerConfig,
  McpStdioServerConfig,
} from '../../src/mcp/types.js';
import { OffloadStore } from '../../src/runtime-artifacts/offload-store.js';
import { createToolContext } from '../../src/tools/platform/tool-context.js';
import type { ToolDefinition } from '../../src/tools/platform/tool-definition.js';
import type { AppServices } from '../../src/app/types.js';
import { createTestMcpServer, makeTool } from './helpers.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

interface FakeRegistry extends McpToolRegistryLike {
  names(): string[];
  get(name: string): ToolDefinition | undefined;
}

function createFakeRegistry(seed: string[] = []): FakeRegistry {
  const definitions = new Map<string, ToolDefinition>();
  for (const name of seed) definitions.set(name, stubDefinition(name));

  return {
    registerDefinition(def) {
      definitions.set(def.name, def);
    },
    unregister(name) {
      definitions.delete(name);
    },
    has(name) {
      return definitions.has(name);
    },
    names() {
      return [...definitions.keys()];
    },
    get(name) {
      return definitions.get(name);
    },
  };
}

/** A stand-in for a built-in tool: the manager only needs name + identity. */
function stubDefinition(name: string): ToolDefinition {
  return {
    name,
    label: name,
    description: `built-in ${name}`,
    category: 'file',
    parametersSchema: { type: 'object', properties: {} },
    capability: {
      category: 'file',
      readOnly: true,
      readsFiles: true,
      writesFiles: false,
      usesShell: false,
      usesNetwork: false,
      usesComputerUse: false,
      pathAccess: 'read',
      approvalDefault: 'none',
    },
    execute: async () => ({ content: [{ type: 'text', text: `built-in ${name}` }] }),
  };
}

function stdioServer(overrides: Partial<McpStdioServerConfig> = {}): McpStdioServerConfig {
  return {
    name: 'filesystem',
    enabled: true,
    exposure: 'deferred',
    toolExposure: {},
    description: 'local files',
    transport: 'stdio',
    command: 'npx',
    args: [],
    env: {},
    cwd: '',
    ...overrides,
  };
}

function sectionWith(
  servers: McpServerConfig[],
  overrides: Partial<McpSectionConfig> = {},
): McpSectionConfig {
  return {
    ...DEFAULT_MCP_SECTION,
    servers: Object.fromEntries(servers.map((server) => [server.name, server])),
    ...overrides,
  };
}

const silentLogger: McpManagerLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

interface Harness {
  manager: McpManager;
  registry: FakeRegistry;
  warnings: Array<Record<string, unknown>>;
  offloadBaseDir: string;
  def(name: string): ToolDefinition;
}

const tempDirs: string[] = [];

function createHarness(options: {
  config: McpSectionConfig;
  transports: Record<string, McpTransport>;
  registry?: FakeRegistry;
  /** Feeds `manager.reload()`; defaults to the injected config. */
  resolveConfig?: () => McpSectionConfig | undefined;
}): Harness {
  const registry = options.registry ?? createFakeRegistry();
  const warnings: Array<Record<string, unknown>> = [];
  const offloadBaseDir = mkdtempSync(path.join(tmpdir(), 'mcp-manager-test-'));
  tempDirs.push(offloadBaseDir);

  const manager = createMcpManager({
    config: options.config,
    logger: {
      ...silentLogger,
      warn(obj) {
        warnings.push(obj);
      },
    },
    toolRegistry: registry,
    offloadStore: new OffloadStore(offloadBaseDir),
    createTransport: (server) => {
      const transport = options.transports[server.name];
      if (!transport) throw new Error(`no test transport for "${server.name}"`);
      return transport;
    },
    resolveConfig: options.resolveConfig,
  });

  return {
    manager,
    registry,
    warnings,
    offloadBaseDir,
    def(name) {
      const def = registry.get(name);
      if (!def) throw new Error(`tool "${name}" is not registered`);
      return def;
    },
  };
}

/** A transport that is already closed, so `start()` fails like a dead server. */
async function deadTransport(): Promise<InMemoryTransport> {
  const transport = new InMemoryTransport();
  await transport.close();
  return transport;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe('McpManager', () => {
  it('connects, lists tools and forwards calls', async () => {
    const server = await createTestMcpServer();
    server.setTools([
      makeTool('read_file', { annotations: { readOnlyHint: true } }),
      makeTool('write_file'),
    ]);
    const harness = createHarness({
      config: sectionWith([stdioServer()]),
      transports: { filesystem: server.clientTransport },
    });

    await harness.manager.ready();

    const state = harness.manager.getServerState('filesystem');
    expect(state?.state).toBe('connected');
    expect(state?.serverName).toBe('test-mcp');
    expect(state?.protocolVersion).toBe('2025-06-18');
    expect(state?.tools.map((tool) => tool.name).sort()).toEqual(['read_file', 'write_file']);
    expect(harness.registry.names().sort()).toEqual([
      'mcp__filesystem__read_file',
      'mcp__filesystem__write_file',
    ]);

    const result = await harness.manager.callTool('filesystem', 'read_file', { value: 'a' });
    expect(result.content).toEqual([{ type: 'text', text: 'read_file({"value":"a"})' }]);
    expect(result.structuredContent).toEqual({ tool: 'read_file', args: { value: 'a' } });

    await server.close();
    await harness.manager.stop();
  });

  it('derives capability from annotations and keeps unknown tools fail-closed', async () => {
    const server = await createTestMcpServer();
    server.setTools([
      makeTool('read_file', { annotations: { readOnlyHint: true } }),
      makeTool('delete_file', { annotations: { destructiveHint: true } }),
      makeTool('opaque'),
    ]);
    const harness = createHarness({
      config: sectionWith([stdioServer()]),
      transports: { filesystem: server.clientTransport },
    });

    await harness.manager.ready();

    expect(harness.def('mcp__filesystem__read_file').capability).toMatchObject({
      category: 'mcp',
      readOnly: true,
      approvalDefault: 'none',
    });
    expect(harness.def('mcp__filesystem__delete_file').capability.approvalDefault).toBe(
      'high_risk',
    );
    expect(harness.def('mcp__filesystem__opaque').capability).toMatchObject({
      readOnly: false,
      approvalDefault: 'mutating',
    });
    // Deferred tools stay deferrable; only `direct` opts out (design §7.2).
    expect(harness.def('mcp__filesystem__read_file').deferrable).toBe(true);

    await server.close();
    await harness.manager.stop();
  });

  it('never registers a hidden tool but still lists it from the cache', async () => {
    const server = await createTestMcpServer();
    server.setTools([makeTool('read_file'), makeTool('secret_dump')]);
    const harness = createHarness({
      config: sectionWith([stdioServer({ toolExposure: { secret_dump: 'hidden' } })]),
      transports: { filesystem: server.clientTransport },
    });

    await harness.manager.ready();

    expect(harness.registry.names()).toEqual(['mcp__filesystem__read_file']);
    // The API surface (`GET /api/mcp/servers/:name/tools`) reads this cache —
    // reading the registry would make hidden tools unrecoverable (§13.7).
    expect(harness.manager.listTools('filesystem').map((tool) => tool.name)).toEqual([
      'read_file',
      'secret_dump',
    ]);

    await server.close();
    await harness.manager.stop();
  });

  it('exposes direct tools through alwaysVisibleTools()', async () => {
    const server = await createTestMcpServer();
    server.setTools([makeTool('read_file'), makeTool('list_dir')]);
    const harness = createHarness({
      config: sectionWith([
        stdioServer({ exposure: 'deferred', toolExposure: { read_file: 'direct' } }),
      ]),
      transports: { filesystem: server.clientTransport },
    });

    await harness.manager.ready();

    expect(harness.manager.alwaysVisibleTools()).toEqual(['mcp__filesystem__read_file']);
    expect(harness.def('mcp__filesystem__read_file').deferrable).toBe(false);
    expect(harness.def('mcp__filesystem__list_dir').deferrable).toBe(true);

    await server.close();
    await harness.manager.stop();
  });

  it('refuses a name that collides with an existing non-MCP tool', async () => {
    const server = await createTestMcpServer();
    server.setTools([makeTool('read_file'), makeTool('list_dir')]);
    const harness = createHarness({
      config: sectionWith([stdioServer()]),
      transports: { filesystem: server.clientTransport },
      registry: createFakeRegistry(['mcp__filesystem__read_file']),
    });

    await harness.manager.ready();

    // The built-in keeps its definition (no silent shadowing) ...
    expect(harness.registry.get('mcp__filesystem__read_file')?.description).toBe(
      'built-in mcp__filesystem__read_file',
    );
    expect(harness.warnings).toContainEqual(
      expect.objectContaining({
        server: 'filesystem',
        tool: 'read_file',
        name: 'mcp__filesystem__read_file',
      }),
    );
    // ... while the server's other tools register normally.
    expect(harness.registry.names()).toContain('mcp__filesystem__list_dir');

    await server.close();
    await harness.manager.stop();
  });

  it('keeps registrations across a disconnect and reports a clear error', async () => {
    const server = await createTestMcpServer();
    server.setTools([makeTool('read_file')]);
    const harness = createHarness({
      config: sectionWith([stdioServer()]),
      transports: { filesystem: server.clientTransport },
    });

    await harness.manager.ready();
    await server.close();

    await vi.waitFor(() => {
      expect(harness.manager.getServerState('filesystem')?.state).toBe('disconnected');
    });
    expect(harness.registry.names()).toEqual(['mcp__filesystem__read_file']);

    // The reconnect attempt (the transport is dead) surfaces as error text the
    // model can act on, not as a thrown exception out of the tool.
    const result = await harness
      .def('mcp__filesystem__read_file')
      .execute({ value: 'a' }, createToolContext({} as AppServices, { sessionId: 'sess-1' }));
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: 'text' });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('mcp__filesystem__read_file');
    expect(text).toContain('failed');

    await harness.manager.stop();
  });

  it('adds and removes registrations on tools/list_changed', async () => {
    const server = await createTestMcpServer();
    server.setTools([makeTool('read_file'), makeTool('list_dir')]);
    const harness = createHarness({
      config: sectionWith([stdioServer()]),
      transports: { filesystem: server.clientTransport },
    });
    await harness.manager.ready();

    server.setTools([makeTool('list_dir'), makeTool('stat')]);
    await server.notify('notifications/tools/list_changed');

    await vi.waitFor(() => {
      expect(harness.registry.names().sort()).toEqual([
        'mcp__filesystem__list_dir',
        'mcp__filesystem__stat',
      ]);
    });

    await server.close();
    await harness.manager.stop();
  });

  it('spills oversized output into the offload directory and keeps the head/tail', async () => {
    const server = await createTestMcpServer();
    server.setTools([makeTool('read_file')]);
    const bigText = `${'head '.repeat(50)}${'tail '.repeat(50)}`;
    server.setHandler('tools/call', () => ({ content: [{ type: 'text', text: bigText }] }));

    const harness = createHarness({
      config: sectionWith([stdioServer()], { maxOutputBytes: 128 }),
      transports: { filesystem: server.clientTransport },
    });
    await harness.manager.ready();

    const result = await harness
      .def('mcp__filesystem__read_file')
      .execute({}, createToolContext({} as AppServices, { sessionId: 'sess-9' }));

    expect(result.isError).toBeFalsy();
    const fullOutputPath = result.metadata?.fullOutputPath as string;
    expect(fullOutputPath).toBeTruthy();
    expect(path.resolve(fullOutputPath)).toContain(
      path.join(harness.offloadBaseDir, 'offload', 'sess-9', 'spill'),
    );
    expect(existsSync(fullOutputPath)).toBe(true);
    expect(readFileSync(fullOutputPath, 'utf-8')).toBe(bigText);

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('Output truncated');
    expect(text).toContain('use file_read to read it');
    // The verbatim spill never enters `offload.jsonl` (separate ledger, §6.6).
    expect(new OffloadStore(harness.offloadBaseDir).getSessionRecords('sess-9')).toEqual([]);

    await server.close();
    await harness.manager.stop();
  });

  it('does not spill output under the limit', async () => {
    const server = await createTestMcpServer();
    server.setTools([makeTool('read_file')]);
    const harness = createHarness({
      config: sectionWith([stdioServer()], { maxOutputBytes: 10_000 }),
      transports: { filesystem: server.clientTransport },
    });
    await harness.manager.ready();

    const result = await harness
      .def('mcp__filesystem__read_file')
      .execute({}, createToolContext({} as AppServices, { sessionId: 'sess-1' }));

    expect(result.metadata?.fullOutputPath).toBeUndefined();
    expect((result.content[0] as { text: string }).text).not.toContain('Output truncated');

    await server.close();
    await harness.manager.stop();
  });

  it('maps an MCP-level failure onto isError', async () => {
    const server = await createTestMcpServer();
    server.setTools([makeTool('read_file')]);
    server.setCallError('file not found');
    const harness = createHarness({
      config: sectionWith([stdioServer()]),
      transports: { filesystem: server.clientTransport },
    });
    await harness.manager.ready();

    const result = await harness
      .def('mcp__filesystem__read_file')
      .execute({}, createToolContext({} as AppServices));

    // MCP reports failure inside the result; the agent loop's failure-streak
    // guard only sees it through ToolExecutionResult.isError (§6.4).
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('file not found');

    await server.close();
    await harness.manager.stop();
  });

  it('degrades a failing server to error state without rejecting ready()', async () => {
    const harness = createHarness({
      config: sectionWith([stdioServer()]),
      transports: { filesystem: await deadTransport() },
    });

    await expect(harness.manager.ready()).resolves.toBeUndefined();

    const state = harness.manager.getServerState('filesystem');
    expect(state?.state).toBe('error');
    expect(state?.errorCount).toBe(1);
    expect(state?.error).toBeTruthy();
    expect(harness.registry.names()).toEqual([]);

    await harness.manager.stop();
  });

  it('leaves a disabled server disconnected, unregistered and reported as disabled', async () => {
    const server = await createTestMcpServer();
    const harness = createHarness({
      config: sectionWith([stdioServer({ enabled: false })]),
      transports: { filesystem: server.clientTransport },
    });

    await harness.manager.ready();

    expect(harness.manager.getServerState('filesystem')?.state).toBe('disabled');
    expect(harness.manager.listTools('filesystem')).toEqual([]);
    await expect(harness.manager.callTool('filesystem', 'read_file', {})).rejects.toThrow(
      /disabled/,
    );

    await harness.manager.stop();
  });

  it('closes connections and clears registrations on stop()', async () => {
    const server = await createTestMcpServer();
    const harness = createHarness({
      config: sectionWith([stdioServer()]),
      transports: { filesystem: server.clientTransport },
    });
    await harness.manager.ready();
    expect(harness.registry.names()).toHaveLength(0); // no tools served by the fixture

    await harness.manager.stop();
    await harness.manager.stop(); // idempotent

    expect(harness.manager.getServerState('filesystem')?.state).toBe('disabled');
    await expect(harness.manager.callTool('filesystem', 'read_file', {})).rejects.toThrow(
      /stopped/,
    );
  });

  it('rejects calls to an unknown server', async () => {
    const harness = createHarness({
      config: sectionWith([]),
      transports: {},
    });

    await expect(harness.manager.callTool('nope', 'read_file', {})).rejects.toThrow(
      /Unknown MCP server/,
    );
    expect(harness.manager.listTools('nope')).toEqual([]);

    await harness.manager.stop();
  });

  it('notifies onToolsChanged listeners when the tool set moves', async () => {
    const server = await createTestMcpServer();
    server.setTools([makeTool('read_file')]);
    const harness = createHarness({
      config: sectionWith([stdioServer()]),
      transports: { filesystem: server.clientTransport },
    });

    const listener = vi.fn();
    const unsubscribe = harness.manager.onToolsChanged(listener);

    await harness.manager.ready();
    expect(listener).toHaveBeenCalled();

    unsubscribe();
    listener.mockClear();
    await server.close();
    await vi.waitFor(() => {
      expect(harness.manager.getServerState('filesystem')?.state).toBe('disconnected');
    });
    expect(listener).not.toHaveBeenCalled();

    await harness.manager.stop();
  });

  it('sanitises and hash-suffixes names that collide inside MCP', async () => {
    // Two tools of one server whose names sanitise to the same string: the
    // second gets the 8-char hash suffix instead of silently replacing the
    // first (design §6.1 layer 1).
    const server = await createTestMcpServer();
    server.setTools([makeTool('read.file'), makeTool('read/file')]);

    const harness = createHarness({
      config: sectionWith([stdioServer({ name: 'fs' })]),
      transports: { fs: server.clientTransport },
    });

    await harness.manager.ready();

    const names = harness.registry.names();
    expect(names).toContain('mcp__fs__read_file');
    expect(names.some((name) => /^mcp__fs__read_file_[0-9a-f]{8}$/.test(name))).toBe(true);
    expect(names).toHaveLength(2);

    await server.close();
    await harness.manager.stop();
  });

  it('serves the resource access surface for resource-capable servers', async () => {
    const server = await createTestMcpServer({ capabilities: { tools: {}, resources: {} } });
    server.setTools([makeTool('read_file')]);
    server.setHandler('resources/list', () => ({
      resources: [{ uri: 'file:///a.txt', name: 'a.txt' }],
    }));
    server.setHandler('resources/templates/list', () => ({
      resourceTemplates: [{ uriTemplate: 'file:///{name}', name: 'template' }],
    }));
    server.setHandler('resources/read', (request) => ({
      contents: [{ uri: (request.params as { uri: string }).uri, text: 'hello' }],
    }));

    const harness = createHarness({
      config: sectionWith([stdioServer()]),
      transports: { filesystem: server.clientTransport },
    });
    await harness.manager.ready();

    const resources = harness.manager.resources;
    expect(resources).toBeDefined();
    expect(harness.manager.getServerState('filesystem')?.supportsResources).toBe(true);
    expect(resources?.serversWithResources()).toEqual(['filesystem']);

    const listed = await resources!.listResources('filesystem');
    expect(listed.resources.map((resource) => resource.uri)).toEqual(['file:///a.txt']);

    const templates = await resources!.listResourceTemplates('filesystem');
    expect(templates.resourceTemplates).toHaveLength(1);

    const read = await resources!.readResource('filesystem', 'file:///a.txt');
    expect(read.contents[0]).toMatchObject({ uri: 'file:///a.txt', text: 'hello' });

    await server.close();
    await harness.manager.stop();
  });

  it('keeps the tool list at the section order and reports every configured server', async () => {
    const server = await createTestMcpServer();
    const harness = createHarness({
      config: sectionWith([
        stdioServer({ name: 'filesystem' }),
        stdioServer({ name: 'docs', enabled: false }),
      ]),
      transports: { filesystem: server.clientTransport },
    });

    await harness.manager.ready();

    expect(harness.manager.listServers().map((state) => state.name)).toEqual([
      'filesystem',
      'docs',
    ]);

    await server.close();
    await harness.manager.stop();
  });
});

describe('McpManager tool exposure resolution', () => {
  it('prefers the exact override over a wildcard and the server default', async () => {
    const server = await createTestMcpServer();
    server.setTools([makeTool('write_file'), makeTool('write_log'), makeTool('read_file')]);

    const harness = createHarness({
      config: sectionWith([
        stdioServer({
          exposure: 'deferred',
          toolExposure: { 'write_*': 'hidden', write_file: 'direct' },
        }),
      ]),
      transports: { filesystem: server.clientTransport },
    });

    await harness.manager.ready();

    // `write_file` → exact override (direct); `write_log` → wildcard (hidden);
    // `read_file` → server default (deferred).
    expect(harness.registry.names().sort()).toEqual([
      'mcp__filesystem__read_file',
      'mcp__filesystem__write_file',
    ]);
    expect(harness.manager.alwaysVisibleTools()).toEqual(['mcp__filesystem__write_file']);
    expect(harness.manager.listTools('filesystem').map((tool) => tool.name)).toEqual([
      'write_file',
      'write_log',
      'read_file',
    ]);

    await server.close();
    await harness.manager.stop();
  });
});

// ── reload() reconciliation ─────────────────────────────────────────────────

describe('McpManager.reload', () => {
  it('connects a server that reload ADDS, so install takes effect without a restart', async () => {
    const server = await createTestMcpServer();
    server.setTools([makeTool('read_file', { annotations: { readOnlyHint: true } })]);

    let current = sectionWith([]);
    const harness = createHarness({
      config: current,
      transports: { filesystem: server.clientTransport },
      resolveConfig: () => current,
    });

    await harness.manager.ready();
    expect(harness.manager.listServers()).toHaveLength(0);

    current = sectionWith([stdioServer()]);
    await harness.manager.reload();

    // Regression: a freshly created runtime seeds `enabled: true` and already
    // holds the new config, so both the enabled and configChanged guards look
    // like steady state. Without an explicit "is new" check the server was left
    // disconnected and the install only appeared to work after a restart.
    expect(harness.manager.getServerState('filesystem')?.state).toBe('connected');
    expect(harness.registry.names()).toContain('mcp__filesystem__read_file');
  });

  it('connects a server that reload newly ENABLES', async () => {
    const server = await createTestMcpServer();
    server.setTools([makeTool('read_file')]);

    let current = sectionWith([stdioServer({ enabled: false })]);
    const harness = createHarness({
      config: current,
      transports: { filesystem: server.clientTransport },
      resolveConfig: () => current,
    });

    await harness.manager.ready();
    expect(harness.manager.getServerState('filesystem')?.state).toBe('disabled');
    expect(harness.registry.names()).not.toContain('mcp__filesystem__read_file');

    current = sectionWith([stdioServer({ enabled: true })]);
    await harness.manager.reload();

    expect(harness.manager.getServerState('filesystem')?.state).toBe('connected');
    expect(harness.registry.names()).toContain('mcp__filesystem__read_file');
  });

  it('leaves an unchanged, already-connected server serving', async () => {
    const server = await createTestMcpServer();
    server.setTools([makeTool('read_file')]);

    const current = sectionWith([stdioServer()]);
    const harness = createHarness({
      config: current,
      transports: { filesystem: server.clientTransport },
      resolveConfig: () => current,
    });

    await harness.manager.ready();
    expect(harness.manager.getServerState('filesystem')?.state).toBe('connected');

    await harness.manager.reload();

    // A no-op reload must not tear down a healthy server.
    expect(harness.manager.getServerState('filesystem')?.state).toBe('connected');
    expect(harness.registry.names()).toContain('mcp__filesystem__read_file');
  });

  it('removes a server that reload DROPS, unregistering its tools', async () => {
    const server = await createTestMcpServer();
    server.setTools([makeTool('read_file')]);

    let current = sectionWith([stdioServer()]);
    const harness = createHarness({
      config: current,
      transports: { filesystem: server.clientTransport },
      resolveConfig: () => current,
    });

    await harness.manager.ready();
    expect(harness.registry.names()).toContain('mcp__filesystem__read_file');

    current = sectionWith([]);
    await harness.manager.reload();

    expect(harness.manager.getServerState('filesystem')).toBeUndefined();
    expect(harness.registry.names()).not.toContain('mcp__filesystem__read_file');
  });
});
