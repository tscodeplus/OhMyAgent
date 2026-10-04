// ---------------------------------------------------------------------------
// MCP test harness — a scriptable MCP server over an in-memory transport
// ---------------------------------------------------------------------------
//
// `@earendil-works/pi-mcp/testing` ships `createInMemoryTransportPair()`, which
// gives a pair of connected transports but no server. This helper wraps the
// server side with a method->handler map so tests can drive real protocol
// traffic (initialize / tools/list / tools/call / resources/*) without spawning
// a child process or binding a port.

import {
  McpClient,
  McpError,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type ServerCapabilities,
  type Tool,
} from '@earendil-works/pi-mcp';
import {
  createInMemoryTransportPair,
  type InMemoryTransport,
} from '@earendil-works/pi-mcp/testing';

export type McpHandler = (request: JsonRpcRequest) => unknown | Promise<unknown>;

export interface TestMcpServer {
  /** Hand this to `new McpClient().connect()`. */
  clientTransport: InMemoryTransport;
  /** The server-side transport, already started. */
  serverTransport: InMemoryTransport;
  /** Register a JSON-RPC method handler. */
  setHandler(method: string, handler: McpHandler): void;
  /** Push a server-initiated notification (e.g. tools/list_changed). */
  notify(method: string, params?: unknown): Promise<void>;
  /** Every message the server received, for assertions. */
  received: JsonRpcMessage[];
  /** Tool list served by the built-in `tools/list` handler. */
  setTools(tools: Tool[]): void;
  getTools(): Tool[];
  /** Override the initialize result (capabilities, serverInfo, version). */
  setCapabilities(capabilities: ServerCapabilities): void;
  /** Make `tools/call` return an MCP-level error result (`isError: true`). */
  setCallError(message: string): void;
  close(): Promise<void>;
}

export interface TestMcpServerOptions {
  name?: string;
  version?: string;
  capabilities?: ServerCapabilities;
  protocolVersion?: string;
}

/**
 * Start an in-memory MCP server. Always `await server.close()` (or call it from
 * `afterEach`) so the transport pair is torn down.
 */
export async function createTestMcpServer(
  options: TestMcpServerOptions = {},
): Promise<TestMcpServer> {
  const pair = createInMemoryTransportPair();
  const handlers = new Map<string, McpHandler>();
  const received: JsonRpcMessage[] = [];
  let tools: Tool[] = [];
  let callError: string | undefined;

  let capabilities: ServerCapabilities = options.capabilities ?? { tools: {} };

  const server: TestMcpServer = {
    clientTransport: pair.client,
    serverTransport: pair.server,
    received,
    setHandler(method, handler) {
      handlers.set(method, handler);
    },
    async notify(method, params) {
      await pair.server.send({
        jsonrpc: '2.0',
        method,
        ...(params === undefined ? {} : { params }),
      } as JsonRpcMessage);
    },
    setTools(next) {
      tools = next;
    },
    getTools() {
      return tools;
    },
    setCapabilities(next) {
      capabilities = next;
    },
    setCallError(message) {
      callError = message;
    },
    async close() {
      await pair.server.close();
    },
  };

  handlers.set('initialize', () => ({
    protocolVersion: options.protocolVersion ?? '2025-06-18',
    capabilities,
    serverInfo: { name: options.name ?? 'test-mcp', version: options.version ?? '0.0.1' },
  }));
  handlers.set('tools/list', () => ({ tools }));
  handlers.set('tools/call', (request) => {
    if (callError !== undefined) {
      return { content: [{ type: 'text', text: callError }], isError: true };
    }
    const params = (request.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
    return {
      content: [
        { type: 'text', text: `${params.name}(${JSON.stringify(params.arguments ?? {})})` },
      ],
      structuredContent: { tool: params.name, args: params.arguments ?? {} },
    };
  });
  handlers.set('resources/list', () => ({ resources: [] }));
  handlers.set('resources/templates/list', () => ({ resourceTemplates: [] }));

  pair.server.onMessage((message: JsonRpcMessage) => {
    received.push(message);
    if (!('id' in message) || !('method' in message)) return;
    const request = message as JsonRpcRequest;

    /**
     * Deliver a response, ignoring a transport that has already closed.
     *
     * The manager legitimately tears the transport down mid-request — that is
     * exactly what the cancellation tests exercise — so a response racing the
     * close is a normal outcome, not a failure. Without this, the late send
     * escapes as an unhandled rejection and vitest reports an error that
     * masks the real assertions.
     */
    const sendSafe = async (payload: JsonRpcMessage): Promise<void> => {
      try {
        await pair.server.send(payload);
      } catch {
        // Transport closed before the response was delivered; nothing to do.
      }
    };

    // Handlers may be async; the transport is synchronous, so settle on a
    // microtask. Errors are converted to JSON-RPC error responses.
    queueMicrotask(() => {
      const handler = handlers.get(request.method);
      if (!handler) {
        void sendSafe({
          jsonrpc: '2.0',
          id: request.id,
          error: { code: -32601, message: `Method not found: ${request.method}` },
        });
        return;
      }
      void (async () => {
        try {
          const result = await handler(request);
          await sendSafe({ jsonrpc: '2.0', id: request.id, result });
        } catch (error) {
          const mcpError = error instanceof McpError ? error : new McpError(-32603, String(error));
          await sendSafe({
            jsonrpc: '2.0',
            id: request.id,
            error: { code: mcpError.code, message: mcpError.message, data: mcpError.data },
          });
        }
      })();
    });
  });

  await pair.server.start();
  return server;
}

/** Build a minimal MCP `Tool` with sane defaults. */
export function makeTool(name: string, overrides: Partial<Tool> = {}): Tool {
  return {
    name,
    description: `${name} description`,
    inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
    ...overrides,
  };
}

/** Connect a client to a `TestMcpServer` and return both. */
export async function connectTestClient(
  server: TestMcpServer,
  clientOptions: { name?: string; version?: string } = {},
): Promise<McpClient> {
  const client = new McpClient({
    name: clientOptions.name ?? 'oma-test',
    version: clientOptions.version ?? '0.0.1',
  });
  await client.connect(server.clientTransport);
  return client;
}
