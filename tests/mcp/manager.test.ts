/**
 * MCP runtime engine tests (MyDocs/MCP_INTEGRATION_DESIGN.md §6, §7, §9).
 *
 * The manager is driven end-to-end over `createInMemoryTransportPair()` — real
 * protocol traffic (initialize / tools/list / tools/call / notifications), no
 * child process and no network.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryTransport } from '@earendil-works/pi-mcp/testing';
import type {
  JsonRpcMessage,
  McpTransport,
  McpTransportCloseListener,
  McpTransportErrorListener,
  McpTransportMessageListener,
} from '@earendil-works/pi-mcp';
import { DEFAULT_MCP_SECTION } from '../../src/mcp/config.js';
import {
  createMcpManager,
  MCP_INSTRUCTIONS_SUMMARY_MAX_CHARS,
  MCP_LOG_MAX_BYTES,
  MCP_STDERR_TAIL_BYTES,
  mcpLogFilePath,
  mcpTransportMaxMessageBytes,
  type McpManagerDeps,
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
    toolEnabled: {},
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

interface Harness {
  manager: McpManager;
  registry: FakeRegistry;
  warnings: Array<Record<string, unknown>>;
  /** Every logger call the manager made, in order. */
  logs: Array<{ level: string; obj: Record<string, unknown>; msg: string | undefined }>;
  offloadBaseDir: string;
  /** Temp dir `OHMYAGENT_LOG_DIR` points at for this harness (§13.12). */
  logDir: string;
  /** Server configs the transport factory was handed, in call order. */
  transportRequests: McpServerConfig[];
  /** Hooks of the most recent transport factory call. */
  lastHooks: TransportHooks | undefined;
  def(name: string): ToolDefinition;
}

type TransportHooks = Parameters<NonNullable<McpManagerDeps['createTransport']>>[1];

const tempDirs: string[] = [];

/** The ambient log dir, restored after every test so the harness cannot leak it. */
const originalLogDir = process.env.OHMYAGENT_LOG_DIR;

/**
 * A transport the tests can drive: it delegates the real protocol traffic to an
 * in-memory transport, but records `close()` and can hold every outgoing message
 * (or the close itself) back until the test releases it.
 *
 * That is the only way to observe a connect that is *still in flight* without
 * spawning a child process: `send()` is not awaited by `McpClient`, so gating it
 * leaves the handshake parked with the transport open (A1/R1).
 */
class InstrumentedTransport implements McpTransport {
  /** True once anything called `close()` on this transport. */
  closed = false;
  /** Number of `close()` calls, including ones parked on a close gate. */
  closeCalls = 0;
  private readonly errorListeners = new Set<McpTransportErrorListener>();

  constructor(
    private readonly inner: McpTransport,
    private readonly gates: { send?: Promise<void>; close?: Promise<void> } = {},
  ) {}

  start(): Promise<void> {
    return this.inner.start();
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (this.gates.send) await this.gates.send;
    if (this.closed) return;
    await this.inner.send(message);
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    this.closed = true;
    if (this.gates.close) await this.gates.close;
    await this.inner.close();
  }

  onMessage(listener: McpTransportMessageListener): () => void {
    return this.inner.onMessage(listener);
  }

  onError(listener: McpTransportErrorListener): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  onClose(listener: McpTransportCloseListener): () => void {
    return this.inner.onClose(listener);
  }

  setProtocolVersion(version: string): void {
    this.inner.setProtocolVersion?.(version);
  }

  /** Simulate a transport-level failure, e.g. an over-limit frame (A4). */
  reportError(error: Error): void {
    for (const listener of [...this.errorListeners]) listener(error);
  }
}

/** A promise plus its resolver, for parking a connect mid-handshake. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function createHarness(options: {
  config: McpSectionConfig;
  transports: Record<string, McpTransport>;
  registry?: FakeRegistry;
  /** Feeds `manager.reload()`; defaults to the injected config. */
  resolveConfig?: () => McpSectionConfig | undefined;
  /** Overrides the per-name lookup, e.g. to hand out a fresh transport per attempt. */
  nextTransport?: (server: McpServerConfig, attempt: number) => McpTransport;
}): Harness {
  const registry = options.registry ?? createFakeRegistry();
  const warnings: Array<Record<string, unknown>> = [];
  const logs: Array<{ level: string; obj: Record<string, unknown>; msg: string | undefined }> = [];
  const offloadBaseDir = mkdtempSync(path.join(tmpdir(), 'mcp-manager-test-'));
  // A per-test log dir, so the sink (§13.12) never touches the real log location.
  const logDir = mkdtempSync(path.join(tmpdir(), 'mcp-manager-logs-'));
  tempDirs.push(offloadBaseDir, logDir);
  process.env.OHMYAGENT_LOG_DIR = logDir;
  const transportRequests: McpServerConfig[] = [];
  let lastHooks: TransportHooks | undefined;

  const manager = createMcpManager({
    config: options.config,
    logger: {
      debug(obj, msg) {
        logs.push({ level: 'debug', obj, msg });
      },
      info(obj, msg) {
        logs.push({ level: 'info', obj, msg });
      },
      warn(obj, msg) {
        logs.push({ level: 'warn', obj, msg });
        warnings.push(obj);
      },
      error(obj, msg) {
        logs.push({ level: 'error', obj, msg });
      },
    },
    toolRegistry: registry,
    offloadStore: new OffloadStore(offloadBaseDir),
    createTransport: (server, hooks) => {
      transportRequests.push(server);
      lastHooks = hooks;
      if (options.nextTransport) {
        return options.nextTransport(server, transportRequests.length - 1);
      }
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
    logs,
    offloadBaseDir,
    logDir,
    transportRequests,
    get lastHooks() {
      return lastHooks;
    },
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
  if (originalLogDir === undefined) delete process.env.OHMYAGENT_LOG_DIR;
  else process.env.OHMYAGENT_LOG_DIR = originalLogDir;
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

  it('cancels an in-flight connect on stop() and closes its transport (A1/R1)', async () => {
    const server = await createTestMcpServer();
    server.setTools([makeTool('read_file')]);
    const sendGate = deferred();
    const transport = new InstrumentedTransport(server.clientTransport, {
      send: sendGate.promise,
    });
    const harness = createHarness({
      config: sectionWith([stdioServer()]),
      transports: { filesystem: transport },
    });

    // `ready()` starts the connect; the gated `send()` parks it mid-handshake.
    const ready = harness.manager.ready();
    await vi.waitFor(() => {
      expect(harness.manager.getServerState('filesystem')?.state).toBe('connecting');
    });

    await harness.manager.stop();
    sendGate.resolve();
    await ready;

    // Before the fix the handshake ran to completion after `stop()` returned:
    // state stayed `connected`, the tools were registered and nothing ever
    // closed the transport (so a stdio child process survived the shutdown).
    expect(transport.closed).toBe(true);
    expect(harness.manager.getServerState('filesystem')?.state).toBe('disabled');
    expect(harness.registry.names()).toEqual([]);
  });

  it('cancels an in-flight connect when a reload disables the server (A1/R1)', async () => {
    const server = await createTestMcpServer();
    server.setTools([makeTool('read_file')]);
    const sendGate = deferred();
    const transport = new InstrumentedTransport(server.clientTransport, {
      send: sendGate.promise,
    });

    let current = sectionWith([stdioServer()]);
    const harness = createHarness({
      config: current,
      transports: { filesystem: transport },
      resolveConfig: () => current,
    });

    const ready = harness.manager.ready();
    await vi.waitFor(() => {
      expect(harness.manager.getServerState('filesystem')?.state).toBe('connecting');
    });

    current = sectionWith([stdioServer({ enabled: false })]);
    await harness.manager.reload();

    expect(transport.closed).toBe(true);
    expect(harness.manager.getServerState('filesystem')?.state).toBe('disabled');
    expect(harness.registry.names()).toEqual([]);

    sendGate.resolve();
    await ready;
  });

  it('cancels the in-flight attempt and reconnects with the new config on reload (R2)', async () => {
    const first = await createTestMcpServer();
    const second = await createTestMcpServer();
    first.setTools([makeTool('old_tool')]);
    second.setTools([makeTool('new_tool')]);

    const sendGate = deferred();
    const attempts: string[] = [];

    let current = sectionWith([]);
    const harness = createHarness({
      config: current,
      transports: {},
      resolveConfig: () => current,
      nextTransport: (server, attempt) => {
        attempts.push(server.transport === 'stdio' ? server.args.join(' ') : server.url);
        return attempt === 0
          ? new InstrumentedTransport(first.clientTransport, { send: sendGate.promise })
          : second.clientTransport;
      },
    });
    await harness.manager.ready();

    current = sectionWith([stdioServer({ args: ['--old'] })]);
    const firstPass = harness.manager.reload();
    await vi.waitFor(() => {
      expect(harness.manager.getServerState('filesystem')?.state).toBe('connecting');
    });

    // The edit lands while the first attempt is still parked in its handshake.
    current = sectionWith([stdioServer({ args: ['--new'] })]);
    const secondPass = harness.manager.reload();
    sendGate.resolve();
    await Promise.all([firstPass, secondPass]);

    // Before the fix the second pass reused the in-flight attempt (`connectServer`
    // returns the pending promise), so the transport factory was called once and
    // the edited command never reached a connection.
    expect(attempts).toEqual(['--old', '--new']);
    expect(harness.manager.getServerState('filesystem')?.state).toBe('connected');
    expect(harness.registry.names()).toEqual(['mcp__filesystem__new_tool']);
  });

  it('serialises overlapping reloads so a stale pass cannot undo a newer one (R3)', async () => {
    const slow = await createTestMcpServer();
    const flip = await createTestMcpServer();
    flip.setTools([makeTool('flip_tool')]);

    const closeGate = deferred();
    const slowTransport = new InstrumentedTransport(slow.clientTransport, {
      close: closeGate.promise,
    });

    let current = sectionWith([
      stdioServer({ name: 'slow', enabled: true }),
      stdioServer({ name: 'flip', enabled: false }),
    ]);
    const harness = createHarness({
      config: current,
      transports: { slow: slowTransport, flip: flip.clientTransport },
      resolveConfig: () => current,
    });
    await harness.manager.ready();
    expect(harness.manager.getServerState('slow')?.state).toBe('connected');

    // Pass 1 disables `slow` and parks in its (gated) transport close, still
    // holding a snapshot in which `flip` is disabled.
    current = sectionWith([
      stdioServer({ name: 'slow', enabled: false }),
      stdioServer({ name: 'flip', enabled: false }),
    ]);
    const firstPass = harness.manager.reload();
    await vi.waitFor(() => {
      expect(slowTransport.closeCalls).toBeGreaterThan(0);
    });

    // A second WebUI write enables `flip` while pass 1 is parked.
    current = sectionWith([
      stdioServer({ name: 'slow', enabled: false }),
      stdioServer({ name: 'flip', enabled: true }),
    ]);
    const secondPass = harness.manager.reload();

    // Gives a *concurrent* pass time to reach `flip`; when reloads are serialised
    // this only waits, because pass 2 cannot start before pass 1 finished.
    await new Promise((resolve) => setTimeout(resolve, 25));
    closeGate.resolve();
    await Promise.all([firstPass, secondPass]);

    // Before the fix pass 2 ran concurrently, enabled `flip`, and pass 1 then
    // applied its stale snapshot last and disabled it again.
    expect(harness.manager.getServerState('flip')?.state).toBe('connected');
    expect(harness.registry.names()).toContain('mcp__flip__flip_tool');
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

// ── tools/list resilience (A3) ──────────────────────────────────────────────

describe('McpManager tools/list resilience', () => {
  it('keeps the server online when one tools/list entry is malformed (A3)', async () => {
    const server = await createTestMcpServer();
    // Upstream's page validation throws on the first bad entry, so this used to
    // take the whole server to `error` state and lose the good tool with it.
    server.setTools([
      makeTool('good_tool'),
      { name: 'sloppy_tool', description: 'no inputSchema' } as never,
    ]);

    const harness = createHarness({
      config: sectionWith([stdioServer()]),
      transports: { filesystem: server.clientTransport },
    });
    await harness.manager.ready();

    const state = harness.manager.getServerState('filesystem');
    expect(state?.state).toBe('connected');
    expect(state?.errorCount).toBe(0);
    expect(harness.registry.names()).toEqual(['mcp__filesystem__good_tool']);
    // The dropped entry never reaches the cache, so `listTools()` stays a list of
    // usable tools rather than a list of claims.
    expect(harness.manager.listTools('filesystem').map((tool) => tool.name)).toEqual(['good_tool']);
    expect(harness.warnings).toContainEqual(
      expect.objectContaining({ server: 'filesystem', skipped: ['sloppy_tool'], kept: 1 }),
    );

    await server.close();
    await harness.manager.stop();
  });

  it('still fails a broken tools/list envelope instead of registering nothing', async () => {
    const server = await createTestMcpServer();
    server.setHandler('tools/list', () => ({ tools: 'not-an-array' }));

    const harness = createHarness({
      config: sectionWith([stdioServer()]),
      transports: { filesystem: server.clientTransport },
    });
    await harness.manager.ready();

    expect(harness.manager.getServerState('filesystem')?.state).toBe('error');
    expect(harness.registry.names()).toEqual([]);

    await harness.manager.stop();
  });

  it('pages through tools/list and rejects a repeated cursor', async () => {
    const server = await createTestMcpServer();
    server.setHandler('tools/list', (request) => {
      const cursor = (request.params as { cursor?: string } | undefined)?.cursor;
      if (cursor === undefined) return { tools: [makeTool('first')], nextCursor: 'page-2' };
      if (cursor === 'page-2') return { tools: [makeTool('second')] };
      return { tools: [] };
    });

    const harness = createHarness({
      config: sectionWith([stdioServer()]),
      transports: { filesystem: server.clientTransport },
    });
    await harness.manager.ready();

    expect(harness.registry.names().sort()).toEqual([
      'mcp__filesystem__first',
      'mcp__filesystem__second',
    ]);

    const looping = await createTestMcpServer();
    looping.setHandler('tools/list', () => ({ tools: [], nextCursor: 'same' }));
    const second = createHarness({
      config: sectionWith([stdioServer()]),
      transports: { filesystem: looping.clientTransport },
    });
    await second.manager.ready();

    expect(second.manager.getServerState('filesystem')?.error).toContain('duplicate cursor');

    await server.close();
    await harness.manager.stop();
    await looping.close();
    await second.manager.stop();
  });
});

// ── transport frame limit and stderr tail (A4 / R7) ─────────────────────────

describe('McpManager transport limits', () => {
  it('derives the transport frame limit from mcp.max_output_bytes (A4)', () => {
    expect(
      mcpTransportMaxMessageBytes({ ...DEFAULT_MCP_SECTION, maxOutputBytes: 24 * 1024 * 1024 }),
    ).toBe(28 * 1024 * 1024);
    // Never below upstream's own 16MB default, whatever the section says.
    expect(mcpTransportMaxMessageBytes({ ...DEFAULT_MCP_SECTION, maxOutputBytes: 20_480 })).toBe(
      16 * 1024 * 1024,
    );
  });

  it('hands the derived limit to the transport factory (A4)', async () => {
    const server = await createTestMcpServer();
    const harness = createHarness({
      config: sectionWith([stdioServer()], { maxOutputBytes: 24 * 1024 * 1024 }),
      transports: { filesystem: server.clientTransport },
    });
    await harness.manager.ready();

    expect(harness.lastHooks?.maxMessageBytes).toBe(28 * 1024 * 1024);
    expect(harness.lastHooks?.maxMessageBytes).toBeGreaterThan(24 * 1024 * 1024);

    await server.close();
    await harness.manager.stop();
  });

  it('reports an over-limit reply explicitly and drops the desynchronised link (A4)', async () => {
    const server = await createTestMcpServer();
    server.setTools([makeTool('read_file')]);
    const transport = new InstrumentedTransport(server.clientTransport);
    const harness = createHarness({
      config: sectionWith([stdioServer()], { maxOutputBytes: 24 * 1024 * 1024 }),
      transports: { filesystem: transport },
    });
    await harness.manager.ready();

    const call = harness.manager.callTool('filesystem', 'read_file', {});
    await vi.waitFor(() => {
      expect(server.received.some((message) => 'method' in message)).toBe(true);
    });
    // Exactly what StdioTransport emits when a frame is over the limit.
    transport.reportError(new Error('MCP stdio message exceeds 29360128 bytes'));

    // Before the fix the frame was dropped silently and the call hung for the
    // full request timeout, ending in a bare "timed out" error.
    await expect(call).rejects.toThrow(/transport limit/);
    await expect(call).rejects.toThrow(/max_output_bytes/);
    expect(transport.closed).toBe(true);
    expect(harness.manager.getServerState('filesystem')?.state).toBe('disconnected');

    await server.close();
    await harness.manager.stop();
  });

  it('caps the stdio stderr tail by bytes, not characters (R7)', async () => {
    const server = await createTestMcpServer();
    const harness = createHarness({
      config: sectionWith([stdioServer()]),
      transports: { filesystem: server.clientTransport },
    });
    await harness.manager.ready();

    // Two bytes per character: a character cap kept 128KB of the intended 64KB.
    harness.lastHooks?.onStderr('é'.repeat(100_000));
    const tail = harness.manager.getServerState('filesystem')?.stderrTail ?? '';

    expect(Buffer.byteLength(tail, 'utf8')).toBeLessThanOrEqual(MCP_STDERR_TAIL_BYTES);
    expect(Buffer.byteLength(tail, 'utf8')).toBeGreaterThan(MCP_STDERR_TAIL_BYTES - 4);
    expect(tail).toMatch(/^é+$/);

    await server.close();
    await harness.manager.stop();
  });
});

// ── per-server log file sink (§13.12) ───────────────────────────────────────

describe('McpManager log sink', () => {
  it('appends ISO-timestamped stderr to the server log file', async () => {
    const server = await createTestMcpServer();
    const harness = createHarness({
      config: sectionWith([stdioServer()]),
      transports: { filesystem: server.clientTransport },
    });
    await harness.manager.ready();

    const logFile = mcpLogFilePath('filesystem');
    // The file is created lazily: nothing is on disk until there is output.
    expect(existsSync(logFile)).toBe(false);

    harness.lastHooks?.onStderr('npm error boom\nsecond line');

    // Before the fix nothing wrote a file at all — only the in-memory tail moved.
    await server.close();
    await harness.manager.stop();

    const lines = readFileSync(logFile, 'utf-8').trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z /);
    expect(lines[0]).toMatch(/npm error boom$/);
    expect(lines[1]).toMatch(/second line$/);
  });

  it('creates the log directory and file lazily on first output', async () => {
    const server = await createTestMcpServer();
    const harness = createHarness({
      config: sectionWith([stdioServer()]),
      transports: { filesystem: server.clientTransport },
    });
    await harness.manager.ready();

    // A directory that does not exist yet, so the sink has to create it.
    const nested = path.join(harness.logDir, 'nested', 'logs');
    process.env.OHMYAGENT_LOG_DIR = nested;
    expect(existsSync(nested)).toBe(false);

    harness.lastHooks?.onStderr('hello\n');
    await server.close();
    await harness.manager.stop();

    const logFile = mcpLogFilePath('filesystem');
    expect(existsSync(logFile)).toBe(true);
    expect(readFileSync(logFile, 'utf-8')).toMatch(/hello\n$/);
  });

  it('rotates to a single .1 generation before the file exceeds 5 MB', async () => {
    const server = await createTestMcpServer();
    const harness = createHarness({
      config: sectionWith([stdioServer()]),
      transports: { filesystem: server.clientTransport },
    });
    await harness.manager.ready();

    const logFile = mcpLogFilePath('filesystem');
    const rotated = `${logFile}.1`;
    // A stale generation and a file already at the limit: the next append rotates.
    writeFileSync(rotated, 'stale generation\n');
    writeFileSync(logFile, 'x'.repeat(MCP_LOG_MAX_BYTES));

    harness.lastHooks?.onStderr('after rotation\n');
    await server.close();
    await harness.manager.stop();

    // Single generation: `.1` is the old file, the stale content is gone.
    expect(readFileSync(rotated, 'utf-8')).toMatch(/^x+$/);
    expect(readFileSync(rotated, 'utf-8')).toHaveLength(MCP_LOG_MAX_BYTES);
    const fresh = readFileSync(logFile, 'utf-8');
    expect(fresh).toMatch(/after rotation\n$/);
    expect(fresh.length).toBeLessThan(MCP_LOG_MAX_BYTES);
  });

  it('writes a single chunk larger than the limit instead of dropping it', async () => {
    const server = await createTestMcpServer();
    const harness = createHarness({
      config: sectionWith([stdioServer()]),
      transports: { filesystem: server.clientTransport },
    });
    await harness.manager.ready();

    const logFile = mcpLogFilePath('filesystem');
    harness.lastHooks?.onStderr('z'.repeat(MCP_LOG_MAX_BYTES + 1024));
    await server.close();
    await harness.manager.stop();

    const text = readFileSync(logFile, 'utf-8');
    expect(text.trimEnd().split('\n')).toHaveLength(1);
    expect(text.trimEnd()).toMatch(/z{100}$/);
    // Nothing existed to rotate, so no `.1` generation is created.
    expect(existsSync(`${logFile}.1`)).toBe(false);
  });

  it('forwards notifications/message to the logger and the log file', async () => {
    const server = await createTestMcpServer();
    const harness = createHarness({
      config: sectionWith([stdioServer()]),
      transports: { filesystem: server.clientTransport },
    });
    await harness.manager.ready();

    await server.notify('notifications/message', {
      level: 'warning',
      data: 'disk almost full',
    });

    // Before the fix the notification was never subscribed, so neither the
    // logger nor the file saw it.
    const warn = harness.logs.find(
      (entry) => entry.level === 'warn' && entry.msg === 'disk almost full',
    );
    expect(warn?.obj).toEqual({ server: 'filesystem' });

    await server.close();
    await harness.manager.stop();

    const text = readFileSync(mcpLogFilePath('filesystem'), 'utf-8');
    expect(text).toMatch(/warn disk almost full\n$/);
  });

  it('maps the notification level and falls back to info for an unknown one', async () => {
    const server = await createTestMcpServer();
    const harness = createHarness({
      config: sectionWith([stdioServer()]),
      transports: { filesystem: server.clientTransport },
    });
    await harness.manager.ready();

    await server.notify('notifications/message', { level: 'debug', data: 'd' });
    await server.notify('notifications/message', { level: 'notice', data: 'n' });
    await server.notify('notifications/message', { level: 'critical', data: 'c' });
    await server.notify('notifications/message', { level: 'bogus', data: 'b' });
    await server.notify('notifications/message', { data: 'no level' });

    const at = (msg: string) => harness.logs.find((entry) => entry.msg === msg)?.level;
    expect(at('d')).toBe('debug');
    expect(at('n')).toBe('info');
    expect(at('c')).toBe('error');
    // An unknown level must not throw and must degrade to info.
    expect(at('b')).toBe('info');
    expect(at('no level')).toBe('info');

    await server.close();
    await harness.manager.stop();
  });

  it('flushes queued writes on stop and drops writes that arrive after it', async () => {
    const server = await createTestMcpServer();
    const harness = createHarness({
      config: sectionWith([stdioServer()]),
      transports: { filesystem: server.clientTransport },
    });
    await harness.manager.ready();

    harness.lastHooks?.onStderr('before stop\n');
    await server.close();
    await harness.manager.stop();

    // `stop()` waits for the queue, so the chunk is on disk.
    const logFile = mcpLogFilePath('filesystem');
    expect(readFileSync(logFile, 'utf-8')).toMatch(/before stop\n$/);

    // A chunk arriving after stop (the stale transport hook cannot fire again in
    // production, but the guard is what keeps a closed sink closed) is dropped.
    harness.lastHooks?.onStderr('after stop\n');
    await new Promise((resolve) => setImmediate(resolve));
    expect(readFileSync(logFile, 'utf-8')).not.toMatch(/after stop/);
  });
});

// ── config reconciliation (C5 / R5) ─────────────────────────────────────────

describe('McpManager config reconciliation', () => {
  it('applies a description-only edit without reconnecting (C5)', async () => {
    const server = await createTestMcpServer();
    server.setTools([makeTool('read_file')]);

    let current = sectionWith([stdioServer({ description: 'old' })]);
    const harness = createHarness({
      config: current,
      transports: { filesystem: server.clientTransport },
      resolveConfig: () => current,
    });
    await harness.manager.ready();
    const connectedAt = harness.manager.getServerState('filesystem')?.connectedAt;

    current = sectionWith([stdioServer({ description: 'new' })]);
    await harness.manager.reload();

    // Before the fix the whole config was compared, so a description edit closed
    // the client and reconnected the server (a fresh `npx` spawn in production).
    expect(harness.transportRequests).toHaveLength(1);
    expect(harness.manager.getServerState('filesystem')?.connectedAt).toBe(connectedAt);

    // Exposure edits are re-applied to the cached list without a reconnect too.
    current = sectionWith([
      stdioServer({ description: 'new', toolExposure: { read_file: 'direct' } }),
    ]);
    await harness.manager.reload();

    expect(harness.transportRequests).toHaveLength(1);
    expect(harness.def('mcp__filesystem__read_file').deferrable).toBe(false);
    expect(harness.manager.alwaysVisibleTools()).toEqual(['mcp__filesystem__read_file']);

    await server.close();
    await harness.manager.stop();
  });

  it('reads mcp.max_output_bytes at call time, so a section-only edit applies (R5)', async () => {
    const server = await createTestMcpServer();
    server.setTools([makeTool('read_file')]);
    const big = 'x'.repeat(5_000);
    server.setHandler('tools/call', () => ({ content: [{ type: 'text', text: big }] }));

    let current = sectionWith([stdioServer()], { maxOutputBytes: 128 });
    const harness = createHarness({
      config: current,
      transports: { filesystem: server.clientTransport },
      resolveConfig: () => current,
    });
    await harness.manager.ready();

    const context = createToolContext({} as AppServices, { sessionId: 'sess-r5' });
    const first = await harness.def('mcp__filesystem__read_file').execute({}, context);
    expect(first.metadata?.fullOutputPath).toBeTruthy();

    // Section-only edit: the server config is untouched, so nothing reconnects
    // and the already-registered definition must pick the new limit up anyway.
    current = sectionWith([stdioServer()], { maxOutputBytes: 100_000 });
    await harness.manager.reload();
    expect(harness.transportRequests).toHaveLength(1);

    const second = await harness.def('mcp__filesystem__read_file').execute({}, context);
    expect(second.metadata?.fullOutputPath).toBeUndefined();
    expect((second.content[0] as { text: string }).text).toBe(big);

    await server.close();
    await harness.manager.stop();
  });
});

// ── tool switches and reserved names (toolEnabled / S2 / A2) ────────────────

describe('McpManager tool switches', () => {
  it('does not register a tool switched off by tool_enabled but still lists it', async () => {
    const server = await createTestMcpServer();
    server.setTools([makeTool('read_file'), makeTool('write_file')]);

    const harness = createHarness({
      config: sectionWith([stdioServer({ toolEnabled: { write_file: false } })]),
      transports: { filesystem: server.clientTransport },
    });
    await harness.manager.ready();

    expect(harness.registry.names()).toEqual(['mcp__filesystem__read_file']);
    // The cache keeps it so the WebUI can switch it back on (§13.7).
    expect(harness.manager.listTools('filesystem').map((tool) => tool.name)).toEqual([
      'read_file',
      'write_file',
    ]);

    await server.close();
    await harness.manager.stop();
  });

  it('refuses a tool that would take over a built-in resource tool name (S2/A2)', async () => {
    const server = await createTestMcpServer();
    server.setTools([makeTool('list'), makeTool('read_file')]);

    // No resource-capable server is connected, so the built-in resource tools are
    // not in the registry — which is exactly when the collision slipped through:
    // `list` became `mcp__resources__list` and silently replaced the built-in.
    const harness = createHarness({
      config: sectionWith([stdioServer({ name: 'resources' })]),
      transports: { resources: server.clientTransport },
    });
    await harness.manager.ready();

    expect(harness.registry.names()).toEqual(['mcp__resources__read_file']);
    expect(harness.warnings).toContainEqual(
      expect.objectContaining({
        server: 'resources',
        tool: 'list',
        name: 'mcp__resources__list',
      }),
    );

    await server.close();
    await harness.manager.stop();
  });
});

// ── state fields for the WebUI (C1-backend) ─────────────────────────────────

describe('McpManager server state fields', () => {
  it('keeps the server instructions, truncated, and clears lastError on connect', async () => {
    const server = await createTestMcpServer();
    server.setHandler('initialize', () => ({
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'test-mcp', version: '0.0.1' },
      instructions: 'Read before you write.',
    }));

    const harness = createHarness({
      config: sectionWith([stdioServer()]),
      transports: { filesystem: server.clientTransport },
    });
    await harness.manager.ready();

    const state = harness.manager.getServerState('filesystem');
    expect(state?.instructionsSummary).toBe('Read before you write.');
    expect(state?.lastError).toBeUndefined();
    expect(state?.protocolVersion).toBe('2025-06-18');

    await server.close();
    await harness.manager.stop();
  });

  it('truncates a long instructions block to the documented cap', async () => {
    const server = await createTestMcpServer();
    server.setHandler('initialize', () => ({
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'test-mcp', version: '0.0.1' },
      instructions: 'i'.repeat(5_000),
    }));

    const harness = createHarness({
      config: sectionWith([stdioServer()]),
      transports: { filesystem: server.clientTransport },
    });
    await harness.manager.ready();

    const summary = harness.manager.getServerState('filesystem')?.instructionsSummary ?? '';
    expect(summary).toHaveLength(MCP_INSTRUCTIONS_SUMMARY_MAX_CHARS + 1);
    expect(summary.endsWith('…')).toBe(true);

    await server.close();
    await harness.manager.stop();
  });

  it('records lastError with a timestamp when a connect fails', async () => {
    const harness = createHarness({
      config: sectionWith([stdioServer()]),
      transports: { filesystem: await deadTransport() },
    });

    await harness.manager.ready();

    const state = harness.manager.getServerState('filesystem');
    expect(state?.state).toBe('error');
    expect(state?.lastError?.message).toBeTruthy();
    expect(state?.lastError?.at).toBeGreaterThan(0);

    await harness.manager.stop();
  });
});
