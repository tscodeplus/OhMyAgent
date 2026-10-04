// ---------------------------------------------------------------------------
// MCP integration — server lifecycle, tool registration and call forwarding
// ---------------------------------------------------------------------------
//
// See MyDocs/MCP_INTEGRATION_DESIGN.md §6.1-§6.7 (registration), §9 (lifecycle)
// and §7 (exposure / deferred integration).
//
// The manager is the only writer of MCP tool registrations. Two invariants it
// exists to enforce:
//
//   * A *failing* server must never block startup. `ready()` never rejects; a
//     server that cannot connect degrades to `error` state and is retried
//     lazily on the next call, with exponential backoff.
//
//   * Registration and connection are separate. A disconnect keeps the
//     registrations (§6.7) — dropping them would leave transcript `toolsAdded`
//     records pointing at tools that no longer exist — while a *disabled* server
//     (an explicit user action, D12) unregisters its tools and its capabilities.
//
// Everything the manager touches is injected (`McpManagerDeps`), including the
// transport factory, so tests can drive the whole engine over
// `createInMemoryTransportPair()` without spawning a child process or reaching
// for globals.

import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  McpAuthRequiredError,
  McpClient,
  StdioTransport,
  StreamableHttpTransport,
  type AuthProvider,
  type CallToolResult,
  type McpFetch,
  type McpTransport,
  type Tool,
} from '@earendil-works/pi-mcp';
import {
  adaptOAuthProvider,
  authorizeMcp,
  McpOAuthProvider,
  McpOAuthAuthorizationRequiredError,
  OAuthCallbackServer,
  type McpOAuthStateStore,
  type OAuthFlowOptions,
  type OAuthFlowResult,
} from '@earendil-works/pi-mcp/oauth';
import { getAppVersion } from '../app/version.js';
import {
  registerToolCapability,
  unregisterToolCapability,
} from '../policy/tool-capability-registry.js';
import { resolveAgentPath } from '../shared/agent-home.js';
import { withTimeout } from '../shared/with-timeout.js';
import type { OffloadStore } from '../runtime-artifacts/offload-store.js';
import type { ToolCapabilityDescriptor } from '../tools/platform/tool-capabilities.js';
import type { ToolDefinition } from '../tools/platform/tool-definition.js';
import { capabilityFromAnnotations } from './capability.js';
import { takeTailBytes } from './offload.js';
import { MCP_RESOURCE_TOOL_NAMES } from './resources.js';
import { createMcpToolName, resolveMcpExposure, toMcpToolDefinition } from './tool-adapter.js';
import type {
  McpCallOptions,
  McpConnectionState,
  McpExposure,
  McpLoginResult,
  McpManager,
  McpOAuthConfig,
  McpResourceAccess,
  McpSectionConfig,
  McpServerConfig,
  McpServerState,
  ListResourceTemplatesResult,
  ListResourcesResult,
  ReadResourceResult,
} from './types.js';

/** Advertised client identity — matches the design's default OAuth client name. */
const MCP_CLIENT_NAME = 'OhMyAgent';

/** Cap on the captured stdio stderr tail (upstream caps its own buffer at 64KB). */
export const MCP_STDERR_TAIL_BYTES = 64 * 1024;

/**
 * Size at which a server's log file is rotated to `<file>.1` (§13.12).
 *
 * A single generation is kept — the newer `.1` overwrites the older one — so the
 * sink never grows into an unbounded numbered series.
 */
export const MCP_LOG_MAX_BYTES = 5 * 1024 * 1024;

/** Cap on the `initialize.instructions` summary kept in the server state (§13.7). */
export const MCP_INSTRUCTIONS_SUMMARY_MAX_CHARS = 500;

/**
 * Framing headroom added on top of `mcp.max_output_bytes` when deriving a
 * transport's frame limit (A4).
 *
 * A JSON-RPC reply is larger than the text it carries (envelope, escaping,
 * pagination), so a limit equal to `max_output_bytes` would drop replies that the
 * output limiter was about to truncate anyway.
 */
const TRANSPORT_FRAME_HEADROOM_BYTES = 4 * 1024 * 1024;

/**
 * Floor for the derived frame limit: upstream's own `DEFAULT_MAX_MESSAGE_BYTES`,
 * repeated here because pi-mcp does not re-export it. A section that lowers
 * `max_output_bytes` must not shrink the transport below what upstream already
 * considers normal.
 */
const TRANSPORT_MIN_MESSAGE_BYTES = 16 * 1024 * 1024;

/** Mirrors upstream's `MAX_LIST_PAGES`, so a cursor loop cannot spin forever. */
const MAX_TOOL_LIST_PAGES = 1_000;

/**
 * Upstream's transports report an over-limit frame as `… exceeds <n> bytes` and
 * expose no error class for it, so the message is the only signal available
 * (A4). Both `StdioTransport` and `StreamableHttpTransport` use that wording.
 */
const TRANSPORT_OVERSIZE_PATTERN = /exceeds \d+ bytes/;

/**
 * Frame limit handed to a server's transport.
 *
 * Derived from `mcp.max_output_bytes` plus framing headroom, with upstream's
 * 16MB as a floor: without it the transport silently dropped every reply larger
 * than 16MB, which both desynchronised framing and made a larger
 * `mcp.max_output_bytes` unreachable (A4).
 */
export function mcpTransportMaxMessageBytes(section: McpSectionConfig): number {
  return Math.max(
    section.maxOutputBytes + TRANSPORT_FRAME_HEADROOM_BYTES,
    TRANSPORT_MIN_MESSAGE_BYTES,
  );
}

/** Lazy-reconnect backoff: 1s → 2s → 4s …, capped (design §9.2). */
const RECONNECT_BACKOFF_BASE_MS = 1_000;
const RECONNECT_BACKOFF_MAX_MS = 30_000;

/** Raised by every OAuth entry point when the manager was built without §10 wiring. */
const OAUTH_NOT_CONFIGURED_MESSAGE =
  'MCP OAuth is not configured: createMcpManager was called without an `oauth` ' +
  'dependency (design §10)';

/** Loopback path the callback server serves; must match the registered redirect URI. */
const OAUTH_CALLBACK_PATH = '/callback';

/** Minimal structural logger — pino and test doubles both satisfy it. */
export interface McpManagerLogger {
  debug(obj: Record<string, unknown>, msg?: string): void;
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

/** The slice of `ToolPlatformRegistry` the manager needs. */
export interface McpToolRegistryLike {
  registerDefinition(def: ToolDefinition): void;
  unregister(name: string): void;
  has(name: string): boolean;
}

export interface McpManagerDeps {
  /** The normalised `mcp:` section. */
  config: McpSectionConfig;
  logger: McpManagerLogger;
  /** v4 registry every adapted tool is registered into. */
  toolRegistry: McpToolRegistryLike;
  /**
   * MCP-owned offload store. Not the agent factory's: that one is `undefined`
   * when `memory.offloading.enabled` is false, and spill/truncation must not
   * depend on that switch (§6.6 / §19-14).
   */
  offloadStore: OffloadStore;
  /**
   * Transport factory. Tests inject in-memory transports; the default builds a
   * `StdioTransport` or `StreamableHttpTransport` from the server config. The
   * hook carries the per-server bearer-token provider so an injected factory
   * can see exactly what the real one would be wired with.
   */
  createTransport?: (
    server: McpServerConfig,
    hooks: {
      onStderr: (chunk: string) => void;
      authProvider?: AuthProvider;
      /** Frame limit for one transport message, see {@link mcpTransportMaxMessageBytes}. */
      maxMessageBytes: number;
    },
  ) => McpTransport;
  /** Re-reads the section for `reload()`; defaults to the injected config. */
  resolveConfig?: () => McpSectionConfig | undefined;
  /** Capability registration seam; defaults to the policy registry. */
  registerCapability?: (name: string, capability: ToolCapabilityDescriptor) => void;
  unregisterCapability?: (name: string) => void;
  /**
   * Durable OAuth plumbing (§10). Absent → `login` / `logout` / `submitCallback`
   * keep failing loudly and HTTP servers connect without a token provider, so a
   * 401 lands in `auth_required` exactly as it did before §10 existed.
   */
  oauth?: McpOAuthDeps;
}

/** Durable OAuth state and credential deletion, injected by the composer. */
export interface McpOAuthDeps {
  /**
   * State store for one server. `McpOAuthStateStore` is bound to a single
   * server URL upstream — `(server_name, server_url)` is the credential
   * table's primary key — so the manager resolves one store per server instead
   * of sharing a single instance across the section.
   */
  store(serverName: string, serverUrl: string): McpOAuthStateStore;
  /**
   * Delete the stored credentials of a server (the logout path). Backed by
   * `deleteMcpOAuthCredentials()`; without `serverUrl` every row of that name
   * is removed.
   */
  deleteCredentials(serverName: string, serverUrl?: string): void;
  /**
   * HTTP client for discovery / registration / token requests. Defaults to
   * `globalThis.fetch`; tests inject a stub so no socket is opened.
   */
  fetch?: McpFetch;
}

interface RegisteredTool {
  name: string;
  server: string;
  rawName: string;
  exposure: McpExposure;
}

interface ServerRuntime {
  config: McpServerConfig;
  state: McpServerState;
  enabled: boolean;
  client: McpClient | undefined;
  disposers: Array<() => void>;
  /** Stable registered name per raw tool name, across `tools/list_changed`. */
  toolNames: Map<string, string>;
  /** Names this server currently has registered. */
  registered: Set<string>;
  /** Fingerprint of name+exposure — a change means the visible tool set moved. */
  signature: string;
  connectPromise: Promise<void> | undefined;
  /**
   * Attempt counter, bumped by `cancelConnectAttempt()`. An in-flight
   * `doConnect()` compares it to the value it captured, so a superseded attempt
   * can tell that the world moved on and must publish nothing (A1/R1).
   */
  generation: number;
  /**
   * Transport of the current attempt, kept on the runtime so a cancel can close
   * it even while `connect()` is still in flight (A1/R1).
   */
  transport: McpTransport | undefined;
  /** Set when a transport dropped an over-limit frame, see {@link OversizeFrame}. */
  oversize: OversizeFrame | undefined;
  retryCount: number;
  nextRetryAt: number;
  stderrTail: string;
  /** Per-server log file sink, created on first output (§13.12). */
  logSink: McpServerLogSink | undefined;
  /** True while this manager is intentionally closing the client. */
  closing: boolean;
  /** OAuth provider + token provider, created on first use (§10). */
  oauth: OAuthRuntime | undefined;
}

/**
 * A frame a transport refused to deliver because it exceeded its limit (A4).
 *
 * Upstream drops the frame and reports it on the error channel only, which
 * leaves the pending request hanging until its timeout on a now-desynchronised
 * connection. The close is started immediately so the request fails now, and
 * awaited before the caller is told why.
 */
interface OversizeFrame {
  /** Ready-to-throw message naming the limit and the remedy. */
  message: string;
  /** Epoch ms the transport reported it. */
  at: number;
  /** Close of the desynchronised connection. */
  closing: Promise<void>;
}

/** One server's OAuth provider and the transport adapter built from it. */
interface OAuthRuntime {
  provider: McpOAuthProvider;
  authProvider: AuthProvider;
  /** Durable state, kept alongside the provider for the CSRF check. */
  store: McpOAuthStateStore;
  /** Last URL handed to the browser, or shown for the paste-a-URL flow. */
  authorizationUrl: string | undefined;
}

/** A login whose authorization code has not been exchanged yet. */
interface PendingOAuthFlow {
  /** Present while the loopback callback server is listening. */
  callbackServer: OAuthCallbackServer | undefined;
  /** Settles when the callback-server path concludes; absent otherwise. */
  watch: Promise<void> | undefined;
  /** Set once the flow ended either way, so a late callback is only logged. */
  settled: boolean;
  /** Set once the listener was closed, so nobody closes it twice. */
  closed: boolean;
}

/**
 * Create the MCP runtime engine (design §4.2, §9).
 *
 * The returned object is the frozen {@link McpManager} surface; nothing else is
 * expected to talk to the internals. Connections are kicked off by the first
 * `ready()` call, which the composer issues at startup so slow servers never
 * delay the gateway's HTTP listen.
 */
export function createMcpManager(deps: McpManagerDeps): McpManager {
  return new McpManagerImpl(deps);
}

class McpManagerImpl implements McpManager {
  private readonly servers = new Map<string, ServerRuntime>();
  private readonly registeredTools = new Map<string, RegisteredTool>();
  private readonly listeners = new Set<() => void>();

  private readonly createTransport: NonNullable<McpManagerDeps['createTransport']>;
  private readonly registerCapability: NonNullable<McpManagerDeps['registerCapability']>;
  private readonly unregisterCapability: NonNullable<McpManagerDeps['unregisterCapability']>;
  private readonly oauth: McpOAuthDeps | undefined;

  /** Logins whose code has not been exchanged yet, by server name (§10.1). */
  private readonly pendingFlows = new Map<string, PendingOAuthFlow>();

  private section: McpSectionConfig;
  private readyPromise: Promise<void> | undefined;
  private stopped = false;
  /**
   * Serialises `reload()`. One WebUI write issues it twice, and two overlapping
   * passes apply a stale snapshot last — the proven symptom was a stale pass
   * disabling a server a newer pass had just enabled (R3).
   */
  private reloadQueue: Promise<void> = Promise.resolve();

  /**
   * Resource access surface (§11). Optional on the interface, but always
   * present here — the three resource tools and the detail drawer feature-test
   * it with `manager.resources?`.
   */
  readonly resources: McpResourceAccess = {
    listResources: (serverName, cursor, opts) =>
      this.withResourceClient(serverName, (client, timeoutMs) =>
        client.listResourcesPage(cursor, { timeoutMs, signal: opts?.signal }),
      ),
    listResourceTemplates: (serverName, cursor, opts) =>
      this.withResourceClient(serverName, (client, timeoutMs) =>
        client.listResourceTemplatesPage(cursor, { timeoutMs, signal: opts?.signal }),
      ),
    readResource: (serverName, uri, opts) =>
      this.withResourceClient(serverName, (client, timeoutMs) =>
        client.readResource(uri, { timeoutMs, signal: opts?.signal }),
      ),
    serversWithResources: () =>
      [...this.servers.values()]
        .filter((rt) => rt.enabled && rt.state.supportsResources)
        .map((rt) => rt.config.name),
  };

  constructor(private readonly deps: McpManagerDeps) {
    this.section = deps.config;
    this.createTransport = deps.createTransport ?? defaultTransportFactory;
    this.registerCapability = deps.registerCapability ?? registerToolCapability;
    this.unregisterCapability = deps.unregisterCapability ?? unregisterToolCapability;
    this.oauth = deps.oauth;

    for (const server of Object.values(this.section.servers)) {
      this.servers.set(server.name, this.createServerRuntime(server, this.isEnabled(server)));
    }
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  ready(): Promise<void> {
    this.readyPromise ??= this.runInitialConnectPass();
    return this.readyPromise;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;

    const runtimes = [...this.servers.values()];
    await Promise.all(
      runtimes.map(async (rt) => {
        // `stopped` already invalidates every attempt; closing the transport is
        // what actually stops a half-open handshake — for a stdio server that
        // means the child process is killed rather than left running (A1/R1).
        await this.cancelConnectAttempt(rt);
        await this.cancelPendingFlow(rt.config.name);
        await this.closeClient(rt);
        this.unregisterServerTools(rt);
        this.setState(rt, 'disabled');
      }),
    );
    this.listeners.clear();
  }

  reload(): Promise<void> {
    const pass = this.reloadQueue.then(() => this.reloadOnce());
    // The stored chain must never reject, or one failed pass would poison every
    // later one. `pass` still carries the rejection to this caller.
    this.reloadQueue = pass.then(
      () => undefined,
      () => undefined,
    );
    return pass;
  }

  private async reloadOnce(): Promise<void> {
    if (this.stopped) return;

    const previousEnabled = this.section.enabled;
    this.section = this.deps.resolveConfig?.() ?? this.deps.config;

    // Servers removed from the section: drop the tools, then the connection.
    for (const [name, rt] of [...this.servers]) {
      if (this.section.servers[name]) continue;
      await this.disableServer(rt);
      this.servers.delete(name);
    }

    for (const server of Object.values(this.section.servers)) {
      const enabled = this.isEnabled(server);
      let rt = this.servers.get(server.name);
      // A runtime created in this pass has never held a client, so it must
      // connect even though `enabled` and `connectionChanged` both look like steady
      // state. Without this, installing or enabling a server would only take
      // effect after a restart — `createServerRuntime` seeds `enabled: true`
      // and `rt.config` is already the new config, so both guards pass.
      const isNew = rt === undefined;
      if (!rt) {
        rt = this.createServerRuntime(server, enabled);
        this.servers.set(server.name, rt);
      }

      const configChanged = JSON.stringify(rt.config) !== JSON.stringify(server);
      // Only an edit that changes how the connection is built needs a fresh
      // attempt: a description edit must not tear a healthy connection down (C5).
      const connectionChanged = connectionFingerprint(rt.config) !== connectionFingerprint(server);
      rt.config = server;
      if (configChanged) {
        // The provider is bound to one exact server URL, and a half-finished
        // login's redirect URI no longer matches after an edit either.
        rt.oauth = undefined;
        await this.cancelPendingFlow(server.name);
      }

      if (!enabled) {
        await this.disableServer(rt);
        continue;
      }

      const wasServing = !isNew && rt.enabled && !connectionChanged && previousEnabled;
      rt.enabled = true;
      if (wasServing) {
        // Nothing about the connection moved, but exposure and per-tool switches
        // may have: re-register from the cached list instead of reconnecting.
        if (configChanged) this.refreshRegistrations(rt);
        continue;
      }

      // A connection-affecting change needs a *fresh* attempt: an in-flight one
      // built its transport from the old config, and `connectServer()` would
      // otherwise hand it straight back, so the edit never applied (R2).
      await this.cancelConnectAttempt(rt);
      await this.closeClient(rt);
      await this.connectQuietly(rt, 'reload');
    }
  }

  /**
   * Re-apply exposure and per-tool switches to the cached tool list (C5).
   *
   * Notified even when the name/exposure signature is unchanged: a description
   * edit reaches the model through the system prompt, and the listener rebuilds
   * it (`bootstrap.ts` maps `onToolsChanged` → `invalidateRuntimes()`).
   */
  private refreshRegistrations(rt: ServerRuntime): void {
    if (rt.state.state !== 'connected' || !rt.client) return;
    this.registerTools(rt, rt.state.tools);
    this.notifyToolsChanged();
  }

  // ── Introspection ───────────────────────────────────────────────────────

  listServers(): McpServerState[] {
    return [...this.servers.values()].map((rt) => this.snapshot(rt));
  }

  getServerState(name: string): McpServerState | undefined {
    const rt = this.servers.get(name);
    return rt ? this.snapshot(rt) : undefined;
  }

  listTools(serverName: string): Tool[] {
    // Reads the manager cache, never the registry: `hidden` tools are never
    // registered, and the WebUI must still be able to list them (§13.7).
    return [...(this.servers.get(serverName)?.state.tools ?? [])];
  }

  alwaysVisibleTools(): string[] {
    return [...this.registeredTools.values()]
      .filter((entry) => entry.exposure === 'direct')
      .map((entry) => entry.name);
  }

  onToolsChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // ── Calls ───────────────────────────────────────────────────────────────

  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    opts: McpCallOptions = {},
  ): Promise<CallToolResult> {
    const rt = this.requireServer(serverName);
    await this.ensureConnected(rt);

    const client = rt.client;
    if (!client) throw new Error(`MCP server "${serverName}" is not connected`);

    const timeoutMs = opts.timeoutMs ?? this.serverRequestTimeoutMs(rt);
    const startedAt = Date.now();
    try {
      return await client.callTool(toolName, args, {
        ...(opts.signal ? { signal: opts.signal } : {}),
        timeoutMs,
      });
    } catch (err) {
      const oversize = await this.takeOversizeFailure(rt, startedAt);
      if (oversize) throw new Error(oversize);
      // A rejection while the client still reports `connected` is a server-side
      // error response (an unknown tool name, say), not a dropped connection.
      // Only an actually-dead connection is recorded as one; the registration
      // stays either way so the next call can lazily reconnect (§6.7).
      if (client.connectionState !== 'connected') this.markCallFailure(rt, err);
      throw err;
    }
  }

  async reconnect(serverName: string): Promise<McpServerState> {
    const rt = this.requireServer(serverName);
    // Must work mid-connect too: without the cancel, `connectServer()` hands the
    // in-flight attempt straight back and the reconnect is a no-op (R2).
    await this.cancelConnectAttempt(rt);
    await this.closeClient(rt);
    rt.retryCount = 0;
    rt.nextRetryAt = 0;
    // Resolves with the resulting state rather than rejecting: a manual
    // reconnect that fails is reported as `state: 'error'` + `error`.
    await this.connectQuietly(rt, 'manual-reconnect');
    return this.snapshot(rt);
  }

  async login(serverName: string): Promise<McpLoginResult> {
    const rt = this.requireOAuthServer(serverName);
    const oauthRt = this.oauthRuntime(rt);

    // A second click supersedes the first flow: two live PKCE verifiers for one
    // server would make a pasted callback ambiguous. The store keeps the last
    // written verifier, so the cancelled flow simply can no longer complete.
    await this.cancelPendingFlow(serverName);

    const callbackServer = await this.startCallbackListener(rt);
    // Registered before the first request: the listener is already bound, and a
    // failed flow below must not leak the port.
    const flow: PendingOAuthFlow = {
      callbackServer,
      watch: undefined,
      settled: false,
      closed: false,
    };
    this.pendingFlows.set(serverName, flow);

    oauthRt.authorizationUrl = undefined;
    let result: OAuthFlowResult;
    try {
      result = await authorizeMcp(oauthRt.provider, this.flowOptions(rt, { skipRefresh: true }));
    } catch (err) {
      await this.cancelPendingFlow(serverName);
      throw err;
    }

    const authorizationUrl = oauthRt.authorizationUrl;
    if (result !== 'REDIRECT' || !authorizationUrl) {
      await this.cancelPendingFlow(serverName);
      throw new Error(`MCP OAuth login for "${serverName}" produced no authorization URL`);
    }

    if (callbackServer) {
      flow.watch = this.watchCallback(rt, callbackServer, flow);
    }

    // `manual` is what the WebUI keys the paste-a-URL box off (§10.1 step 6).
    const manual = callbackServer === undefined;
    this.deps.logger.info(
      { server: serverName, manual },
      manual ? 'MCP OAuth login started (manual callback)' : 'MCP OAuth login started',
    );
    return { authorizationUrl, manual };
  }

  async logout(serverName: string): Promise<void> {
    const rt = this.requireServer(serverName);
    const oauth = this.requireOAuthDeps(serverName);
    await this.cancelPendingFlow(serverName);

    if (rt.config.transport === 'http') oauth.deleteCredentials(serverName, rt.config.url);
    else oauth.deleteCredentials(serverName);

    // Drop the memoised provider: it would otherwise keep serving the tokens
    // that were just deleted from SQLite.
    rt.oauth = undefined;
    await this.closeClient(rt);
    rt.state.authRequired = false;
    this.setState(rt, 'disabled');
    this.deps.logger.info({ server: serverName }, 'MCP OAuth credentials removed');
  }

  async submitCallback(serverName: string, callbackUrl: string): Promise<void> {
    const rt = this.requireOAuthServer(serverName);
    const oauthRt = this.oauthRuntime(rt);
    const parsed = parseCallbackUrl(callbackUrl, oauthRedirectUrl(requireOAuthConfig(rt.config)));

    const failure = parsed.searchParams.get('error');
    if (failure) {
      const description = parsed.searchParams.get('error_description') ?? failure;
      throw new Error(`MCP OAuth authorization for "${serverName}" failed: ${description}`);
    }

    const code = parsed.searchParams.get('code');
    if (!code) {
      throw new Error(`MCP OAuth callback URL for "${serverName}" carries no authorization code`);
    }

    // Anti-CSRF (RFC 6749 §10.12). Read straight from the store so a login that
    // started before a restart is still verifiable.
    const expectedState = (await oauthRt.store.load())?.oauthState;
    if (expectedState && parsed.searchParams.get('state') !== expectedState) {
      throw new Error(
        `MCP OAuth callback URL for "${serverName}" carries a stale or foreign state`,
      );
    }

    await this.completeFlow(rt, {
      code,
      iss: parsed.searchParams.get('iss') ?? undefined,
    });
  }

  // ── OAuth (§10) ─────────────────────────────────────────────────────────

  /**
   * The provider for one server, created on first use.
   *
   * One provider is shared by the login flow and by the transport's
   * `authProvider`, so both read and write the same `McpOAuthState`: a token
   * obtained through the paste-a-URL path is immediately visible to the
   * transport, and a step-up triggered by a 401 reuses the same PKCE verifier
   * and client registration.
   */
  private oauthRuntime(rt: ServerRuntime): OAuthRuntime {
    const existing = rt.oauth;
    if (existing) return existing;

    const oauth = requireOAuthConfig(rt.config);
    const serverUrl = httpUrlOf(rt.config);
    const store = this.requireOAuthDeps(rt.config.name).store(rt.config.name, serverUrl);

    const provider = new McpOAuthProvider({
      serverUrl,
      redirectUrl: oauthRedirectUrl(oauth),
      clientMetadata: {
        client_name: oauth.clientName || MCP_CLIENT_NAME,
        ...(oauth.scope ? { scope: oauth.scope } : {}),
      },
      ...(oauth.clientId ? { clientId: oauth.clientId } : {}),
      ...(oauth.clientSecret ? { clientSecret: oauth.clientSecret } : {}),
      store,
      // Recorded rather than opened: the WebUI decides whether to launch a
      // browser, and a background 401 must never pop one.
      onRedirect: (url) => {
        const runtime = rt.oauth;
        if (runtime) runtime.authorizationUrl = url.href;
      },
    });

    rt.oauth = {
      provider,
      authProvider: adaptOAuthProvider(provider),
      store,
      authorizationUrl: undefined,
    };
    return rt.oauth;
  }

  /** Bearer-token provider for an OAuth-configured HTTP server (§10.1 step 2). */
  private authProviderFor(rt: ServerRuntime): AuthProvider | undefined {
    if (rt.config.transport !== 'http' || !rt.config.oauth || !this.oauth) return undefined;
    return this.oauthRuntime(rt).authProvider;
  }

  /** `authorizeMcp()` options derived from the server's `oauth:` block. */
  private flowOptions(rt: ServerRuntime, extra: { skipRefresh?: boolean } = {}): OAuthFlowOptions {
    const oauth = requireOAuthConfig(rt.config);
    return {
      serverUrl: httpUrlOf(rt.config),
      ...(oauth.scope ? { scope: oauth.scope } : {}),
      ...(oauth.authServerMetadataUrl
        ? { authorizationServerMetadataUrl: new URL(oauth.authServerMetadataUrl) }
        : {}),
      ...(this.oauth?.fetch ? { fetch: this.oauth.fetch } : {}),
      ...(extra.skipRefresh ? { skipRefresh: true } : {}),
    };
  }

  /**
   * Bind the loopback callback server (§10.1 step 5).
   *
   * `undefined` means the flow is manual: either the configured redirect is not
   * on loopback (a remote gateway), or the port cannot be bound here (Termux,
   * or another process already listening). The WebUI then shows the URL and
   * accepts a pasted redirect instead.
   */
  private async startCallbackListener(rt: ServerRuntime): Promise<OAuthCallbackServer | undefined> {
    const target = loopbackCallbackTarget(oauthRedirectUrl(requireOAuthConfig(rt.config)));
    if (!target) {
      this.deps.logger.info(
        { server: rt.config.name },
        'MCP OAuth redirect is not on loopback — using the manual callback flow',
      );
      return undefined;
    }

    try {
      return await OAuthCallbackServer.listen({
        host: '127.0.0.1',
        redirectHost: target.host,
        port: target.port,
        path: target.path,
      });
    } catch (err) {
      this.deps.logger.warn(
        { server: rt.config.name, port: target.port, err: errorMessage(err) },
        'MCP OAuth callback port unavailable — falling back to the manual callback flow',
      );
      return undefined;
    }
  }

  /**
   * Await the browser callback in the background and finish the login.
   *
   * Never rejects: a callback that never arrives (the user pasted the URL
   * instead, or closed the tab) leaves one warning, and the pending flow dies
   * with the server. The promise is stored on the flow rather than discarded.
   */
  private watchCallback(
    rt: ServerRuntime,
    server: OAuthCallbackServer,
    flow: PendingOAuthFlow,
  ): Promise<void> {
    const serverName = rt.config.name;
    return (async () => {
      try {
        const state = await rt.oauth?.provider.state();
        const callback = await server.waitForCallback(state ?? '');
        await this.completeFlow(rt, {
          code: callback.code,
          ...(callback.iss ? { iss: callback.iss } : {}),
        });
        this.deps.logger.info({ server: serverName }, 'MCP OAuth login completed');
      } catch (err) {
        // A flow settled by `submitCallback` (or cancelled) closes this server
        // on purpose — that is not a failure.
        if (!flow.settled) {
          this.deps.logger.warn(
            { server: serverName, err: errorMessage(err) },
            'MCP OAuth callback did not complete the login',
          );
        }
      } finally {
        flow.settled = true;
        if (this.pendingFlows.get(serverName) === flow) this.pendingFlows.delete(serverName);
        await this.closeCallbackServer(flow, serverName);
      }
    })();
  }

  /**
   * Exchange an authorization code for tokens, then reconnect.
   *
   * The exchange re-reads the PKCE verifier, client registration and discovery
   * document from the store, so a login started before a gateway restart still
   * completes (§10.2). A reconnect that fails is not a login failure: the
   * tokens are already stored and the server state reports what went wrong.
   */
  private async completeFlow(
    rt: ServerRuntime,
    callback: { code: string; iss?: string },
  ): Promise<void> {
    const oauthRt = this.oauthRuntime(rt);
    const result = await authorizeMcp(oauthRt.provider, {
      ...this.flowOptions(rt),
      authorizationCode: callback.code,
      ...(callback.iss ? { iss: callback.iss } : {}),
    });
    if (result !== 'AUTHORIZED') {
      throw new Error(`MCP OAuth code exchange for "${rt.config.name}" did not complete`);
    }

    oauthRt.authorizationUrl = undefined;
    const flow = this.pendingFlows.get(rt.config.name);
    if (flow) {
      this.pendingFlows.delete(rt.config.name);
      flow.settled = true;
      // Unblocks the background callback watcher, which would otherwise keep
      // waiting for a redirect the user already pasted.
      await this.closeCallbackServer(flow, rt.config.name);
    }

    await this.closeClient(rt);
    await this.connectQuietly(rt, 'oauth-login');
  }

  /** Close a half-finished login: its callback server stops listening. */
  private async cancelPendingFlow(serverName: string): Promise<void> {
    const flow = this.pendingFlows.get(serverName);
    if (!flow) return;
    this.pendingFlows.delete(serverName);
    flow.settled = true;
    await this.closeCallbackServer(flow, serverName);
  }

  private async closeCallbackServer(flow: PendingOAuthFlow, serverName: string): Promise<void> {
    const server = flow.callbackServer;
    if (!server || flow.closed) return;
    flow.closed = true;

    try {
      await server.close();
    } catch (err) {
      this.deps.logger.warn(
        { server: serverName, err: errorMessage(err) },
        'MCP OAuth callback server close failed',
      );
    }
  }

  /** Every OAuth entry point requires both an HTTP server and an injected store. */
  private requireOAuthServer(name: string): ServerRuntime {
    const rt = this.requireServer(name);
    this.requireOAuthDeps(name);
    if (rt.config.transport !== 'http') {
      throw new Error(`MCP server "${name}" uses stdio; OAuth applies to HTTP servers only`);
    }
    return rt;
  }

  private requireOAuthDeps(serverName: string): McpOAuthDeps {
    if (!this.oauth) throw new Error(`${OAUTH_NOT_CONFIGURED_MESSAGE} (server "${serverName}")`);
    return this.oauth;
  }

  // ── Connection ──────────────────────────────────────────────────────────

  /** Stage the first connect pass so at most `max_concurrent_connects` run. */
  private async runInitialConnectPass(): Promise<void> {
    const queue = [...this.servers.values()].filter((rt) => rt.enabled);
    if (queue.length === 0) return;

    const limit = Math.max(1, Math.min(this.section.maxConcurrentConnects, queue.length));
    const workers = Array.from({ length: limit }, async () => {
      for (;;) {
        const rt = queue.shift();
        if (!rt || this.stopped) return;
        await this.connectQuietly(rt, 'startup');
      }
    });
    await Promise.all(workers);
  }

  /** Connect, recording the failure in the server state instead of throwing. */
  private async connectQuietly(rt: ServerRuntime, reason: string): Promise<void> {
    try {
      await this.connectServer(rt, reason);
    } catch {
      // connectServer already logged and moved the server to error state.
    }
  }

  private async connectServer(rt: ServerRuntime, reason: string): Promise<void> {
    if (this.stopped) throw new Error('MCP manager has been stopped');
    if (!rt.enabled) throw new Error(`MCP server "${rt.config.name}" is disabled`);
    if (rt.connectPromise) return rt.connectPromise;

    const pending = this.doConnect(rt, reason);
    rt.connectPromise = pending;
    try {
      await pending;
    } finally {
      if (rt.connectPromise === pending) rt.connectPromise = undefined;
    }
  }

  private async doConnect(rt: ServerRuntime, reason: string): Promise<void> {
    const name = rt.config.name;
    // Captured before the first await: a cancel bumps the runtime's counter, and
    // this attempt is only allowed to publish while the two still match (A1/R1).
    const generation = rt.generation;
    this.setState(rt, 'connecting');
    rt.oversize = undefined;

    const client = new McpClient({ name: MCP_CLIENT_NAME, version: getAppVersion() ?? '0.0.0' });
    const disposers: Array<() => void> = [
      client.onError((err) => {
        this.deps.logger.warn({ server: name, err: err.message }, 'MCP client error');
        this.noteTransportError(rt, err);
      }),
      client.onClose(() => {
        this.handleClientClosed(rt, client);
      }),
      client.onNotification('notifications/tools/list_changed', () => {
        void this.syncTools(rt, 'notifications/tools/list_changed').catch((err: unknown) => {
          this.deps.logger.warn(
            { server: name, err: errorMessage(err) },
            'MCP tools/list_changed resync failed',
          );
        });
      }),
      client.onNotification('notifications/message', (params) => {
        this.handleLogMessage(rt, params);
      }),
    ];

    let transport: McpTransport | undefined;
    try {
      // Only an explicitly OAuth-configured HTTP server gets a token provider;
      // everything else keeps the pre-§10 behaviour where a 401 surfaces as
      // `McpAuthRequiredError`.
      const authProvider = this.authProviderFor(rt);
      transport = this.createTransport(rt.config, {
        onStderr: (chunk) => this.appendStderr(rt, chunk),
        maxMessageBytes: mcpTransportMaxMessageBytes(this.section),
        ...(authProvider ? { authProvider } : {}),
      });
      // Stored before the handshake so `cancelConnectAttempt()` can close it
      // while `connect()` is still parked (A1/R1).
      rt.transport = transport;

      const connectTimeoutMs = this.section.connectTimeoutSec * 1000;
      await withTimeout(
        client.connect(transport),
        connectTimeoutMs,
        `MCP server "${name}" connect timed out after ${connectTimeoutMs}ms`,
      );

      // Cancelled mid-handshake: a stop, a disable or a newer attempt owns this
      // runtime now, so this one publishes nothing (A1/R1).
      if (!this.isAttemptCurrent(rt, generation)) {
        await this.discardAttempt(rt, client, disposers, transport);
        throw new ConnectCancelledError(name);
      }

      const tools = await this.requestTools(rt, client);

      if (!this.isAttemptCurrent(rt, generation)) {
        await this.discardAttempt(rt, client, disposers, transport);
        throw new ConnectCancelledError(name);
      }

      rt.client = client;
      rt.disposers = disposers;

      const capabilities = client.serverCapabilities ?? {};
      rt.retryCount = 0;
      rt.nextRetryAt = 0;

      rt.state = {
        ...rt.state,
        state: 'connected',
        error: undefined,
        errorCount: 0,
        connectedAt: Date.now(),
        updatedAt: Date.now(),
        authRequired: false,
        supportsResources: capabilities.resources !== undefined,
        supportsPrompts: capabilities.prompts !== undefined,
        instructionsSummary: summariseInstructions(client.instructions),
        lastError: undefined,
        ...(client.protocolVersion ? { protocolVersion: client.protocolVersion } : {}),
        ...(client.serverInfo?.name ? { serverName: client.serverInfo.name } : {}),
        ...(client.serverInfo?.version ? { serverVersion: client.serverInfo.version } : {}),
      };
      rt.state.tools = tools;

      this.registerTools(rt, tools);
      this.deps.logger.info(
        { server: name, reason, tools: tools.length, protocolVersion: client.protocolVersion },
        'MCP server connected',
      );
      this.notifyToolsChanged();
    } catch (err) {
      for (const dispose of disposers) dispose();
      if (transport && rt.transport === transport) rt.transport = undefined;
      try {
        await client.close();
      } catch {
        // Best effort — the connect failure below is the one worth reporting.
      }

      // A superseded attempt must not touch the state either: the attempt that
      // replaced it owns the runtime now (A1/R1).
      if (!this.isAttemptCurrent(rt, generation)) {
        this.deps.logger.debug({ server: name, reason }, 'MCP connect attempt was cancelled');
        throw new ConnectCancelledError(name);
      }

      // A 401 with no usable credentials is not an error: the server needs the
      // user to authorize, and the WebUI renders that as a distinct state
      // (§10.1 step 3). Both the no-provider case and the provider's own
      // "user interaction required" outcome land here.
      const authRequired = isAuthRequiredError(err);
      rt.retryCount += 1;
      rt.nextRetryAt = Date.now() + reconnectBackoffMs(rt.retryCount);
      rt.state.errorCount += 1;
      rt.state.authRequired = authRequired;
      // §13.7 keeps the failure text and its timestamp next to the state, so the
      // WebUI can show *when* a server last broke instead of only that it is not
      // connected right now.
      rt.state.lastError = { message: errorMessage(err), at: Date.now() };
      this.setState(rt, authRequired ? 'auth_required' : 'error', errorMessage(err));

      this.deps.logger.warn(
        { server: name, reason, err: errorMessage(err), authRequired },
        'MCP server connection failed',
      );
      throw err;
    }
  }

  /** True while the attempt that captured `generation` may still publish. */
  private isAttemptCurrent(rt: ServerRuntime, generation: number): boolean {
    return rt.enabled && !this.stopped && rt.generation === generation;
  }

  /**
   * Invalidate and abort an in-flight connect attempt (A1/R1).
   *
   * Upstream's `McpClient.connect()` takes no `AbortSignal` and may not be
   * patched, so the transport is closed instead: that unblocks the pending
   * `initialize` and, for a stdio server, kills the child process. The attempt
   * itself notices the bumped generation and discards its result.
   */
  private async cancelConnectAttempt(rt: ServerRuntime): Promise<void> {
    rt.generation += 1;
    const pending = rt.connectPromise;
    if (!pending) return;

    const transport = rt.transport;
    if (transport) {
      try {
        await transport.close();
      } catch (err) {
        this.deps.logger.warn(
          { server: rt.config.name, err: errorMessage(err) },
          'MCP transport close during connect cancel failed',
        );
      }
    }

    // Awaited, so a caller that just disabled or stopped the server returns with
    // the handshake finished rather than racing it.
    try {
      await pending;
    } catch {
      // The cancelled attempt reports its own failure; nothing to add here.
    }
    if (rt.connectPromise === pending) rt.connectPromise = undefined;
  }

  /** Drop a superseded attempt's client and listeners without publishing it. */
  private async discardAttempt(
    rt: ServerRuntime,
    client: McpClient,
    disposers: Array<() => void>,
    transport: McpTransport,
  ): Promise<void> {
    for (const dispose of disposers) dispose();
    if (rt.transport === transport) rt.transport = undefined;
    try {
      await client.close();
    } catch (err) {
      this.deps.logger.debug(
        { server: rt.config.name, err: errorMessage(err) },
        'MCP cancelled connect attempt did not close cleanly',
      );
    }
  }

  private async closeClient(rt: ServerRuntime): Promise<void> {
    const client = rt.client;
    rt.client = undefined;
    for (const dispose of rt.disposers) dispose();
    rt.disposers = [];
    // The client owns the transport once it is connected, so the runtime stops
    // tracking it here; only a *pending* attempt keeps one (A1/R1).
    rt.transport = undefined;
    // Flush and drop the log file sink so a stopped or disabled server leaves
    // nothing holding its log file (§13.12).
    const sink = rt.logSink;
    rt.logSink = undefined;
    await sink?.close();
    if (!client) return;

    rt.closing = true;
    try {
      await client.close();
    } catch (err) {
      this.deps.logger.warn(
        { server: rt.config.name, err: errorMessage(err) },
        'MCP client close failed',
      );
    } finally {
      rt.closing = false;
    }
  }

  private handleClientClosed(rt: ServerRuntime, client: McpClient): void {
    if (rt.client !== client || rt.closing) return;
    rt.client = undefined;
    // A passive disconnect does not consume the retry budget: the backoff exists
    // for *failed* reconnect attempts (§9.2), and a dropped server should be
    // retried on the very next call.
    rt.retryCount = 0;
    rt.nextRetryAt = 0;
    this.setState(rt, 'disconnected', 'connection closed by the server');
    this.deps.logger.warn({ server: rt.config.name }, 'MCP server disconnected');
    // Registrations survive (§6.7) but the tool set is now unreachable, so
    // runtime invalidation listeners are told.
    this.notifyToolsChanged();
  }

  /** Treat a failed call as a dropped connection and schedule the retry. */
  private markCallFailure(rt: ServerRuntime, err: unknown): void {
    rt.retryCount += 1;
    rt.nextRetryAt = Date.now() + reconnectBackoffMs(rt.retryCount);
    rt.state.errorCount += 1;
    this.setState(rt, 'disconnected', errorMessage(err));
  }

  private async ensureConnected(rt: ServerRuntime): Promise<void> {
    if (this.stopped) throw new Error('MCP manager has been stopped');
    if (!rt.enabled) throw new Error(`MCP server "${rt.config.name}" is disabled`);
    if (rt.state.state === 'connected' && rt.client) return;

    const waitMs = rt.nextRetryAt - Date.now();
    if (waitMs > 0) {
      throw new Error(
        `MCP server "${rt.config.name}" is not connected; retry available in ` +
          `${Math.ceil(waitMs / 1000)}s`,
      );
    }

    await this.connectServer(rt, 'lazy-reconnect');
    if (rt.state.state !== 'connected' || !rt.client) {
      throw new Error(
        `MCP server "${rt.config.name}" is not connected: ${rt.state.error ?? 'unknown error'}`,
      );
    }
  }

  /** Close the connection and unregister everything the server contributed (D12). */
  private async disableServer(rt: ServerRuntime): Promise<void> {
    rt.enabled = false;
    // An in-flight connect is cancelled *and awaited* before the tools go: it
    // would otherwise finish later, register its tools and flip the state back
    // to `connected` after the user disabled the server (A1/R1).
    await this.cancelConnectAttempt(rt);
    await this.cancelPendingFlow(rt.config.name);
    await this.closeClient(rt);
    this.unregisterServerTools(rt);
    this.setState(rt, 'disabled');
    this.notifyToolsChanged();
  }

  // ── Tool registration ───────────────────────────────────────────────────

  private async syncTools(rt: ServerRuntime, reason: string): Promise<void> {
    const client = rt.client;
    if (!client || rt.state.state !== 'connected') return;

    const tools = await this.requestTools(rt, client);
    rt.state.tools = tools;
    const changed = this.registerTools(rt, tools);
    this.deps.logger.info(
      { server: rt.config.name, reason, tools: tools.length },
      'MCP tool list refreshed',
    );
    if (changed) this.notifyToolsChanged();
  }

  /**
   * Diff the server's tools against the current registrations: add new ones,
   * drop vanished ones, refresh capability/exposure bookkeeping.
   *
   * @returns whether the visible (name + exposure) tool set changed.
   */
  private registerTools(rt: ServerRuntime, tools: Tool[]): boolean {
    const desired = new Map<string, { tool: Tool; exposure: McpExposure }>();
    // Names are reserved as they are allocated: the diff below runs before any
    // registration happens, so two tools that sanitise to the same name would
    // otherwise both receive it and the second would replace the first.
    const reserved = new Set<string>(this.registeredTools.keys());

    for (const tool of tools) {
      const exposure = resolveMcpExposure(rt.config, tool.name);
      // `hidden` — and a tool switched off through `tool_enabled` — means "do not
      // register at all". Both stay in `rt.state.tools` so the WebUI can still
      // list them and switch them back on (§7.1, §13.7).
      if (exposure === 'hidden' || !isToolEnabled(rt.config, tool.name)) continue;

      const name = rt.toolNames.get(tool.name) ?? this.allocateToolName(rt, tool.name, reserved);
      if (name === undefined) continue;
      reserved.add(name);
      desired.set(name, { tool, exposure });
    }

    for (const name of [...rt.registered]) {
      if (!desired.has(name)) this.unregisterTool(name);
    }

    for (const [name, entry] of desired) {
      const isNew = !rt.registered.has(name);

      // Re-registering an existing name refreshes the definition: a server can
      // rewrite descriptions or annotations between listings, and exposure may
      // have moved through `tool_exposure`.
      this.deps.toolRegistry.registerDefinition(
        toMcpToolDefinition({
          server: rt.config,
          tool: entry.tool,
          name,
          exposure: entry.exposure,
          callTool: (rawToolName, args, opts) =>
            this.callTool(rt.config.name, rawToolName, args, opts),
          offload: { store: this.deps.offloadStore, maxBytes: () => this.section.maxOutputBytes },
        }),
      );
      this.registerCapability(name, capabilityFromAnnotations(entry.tool.annotations, rt.config));
      rt.registered.add(name);

      if (isNew) {
        this.deps.logger.debug(
          { server: rt.config.name, tool: entry.tool.name, name, exposure: entry.exposure },
          'MCP tool registered',
        );
      }

      this.registeredTools.set(name, {
        name,
        server: rt.config.name,
        rawName: entry.tool.name,
        exposure: entry.exposure,
      });
    }

    const signature = [...desired.entries()]
      .map(([name, entry]) => `${name}:${entry.exposure}`)
      .sort()
      .join(',');
    const changed = signature !== rt.signature;
    rt.signature = signature;
    return changed;
  }

  /**
   * Reserve the registered name for one server tool.
   *
   * Returns `undefined` — and registers nothing — when the (hash-suffixed) name
   * collides with a tool the gateway already owns: masking a built-in (or one of
   * the three `mcp__resources__*` tools) behind an alias would silently replace
   * it, so the design calls for refusal + warning (§6.1 layer 2, §17).
   *
   * `createMcpToolName()` only hashes around an *MCP-internal* collision, so the
   * check has to come after it: a server literally named `resources` must be
   * refused, not renamed (S2/A2).
   */
  private allocateToolName(
    rt: ServerRuntime,
    rawToolName: string,
    reserved: ReadonlySet<string>,
  ): string | undefined {
    const name = createMcpToolName(rt.config.name, rawToolName, (candidate) =>
      reserved.has(candidate),
    );

    if (reserved.has(name) || this.isGatewayOwnedToolName(name)) {
      this.deps.logger.warn(
        { server: rt.config.name, tool: rawToolName, name },
        'MCP tool name collides with an existing tool — refusing to register it',
      );
      return undefined;
    }

    rt.toolNames.set(rawToolName, name);
    return name;
  }

  /**
   * True for names the gateway owns rather than any server: the three resource
   * tools (§11) plus everything already in the v4 registry.
   */
  private isGatewayOwnedToolName(name: string): boolean {
    return (
      (MCP_RESOURCE_TOOL_NAMES as readonly string[]).includes(name) ||
      this.deps.toolRegistry.has(name)
    );
  }

  private unregisterServerTools(rt: ServerRuntime): void {
    for (const name of [...rt.registered]) this.unregisterTool(name);
    rt.toolNames.clear();
    rt.signature = '';
  }

  private unregisterTool(name: string): void {
    this.deps.toolRegistry.unregister(name);
    this.unregisterCapability(name);
    this.registeredTools.delete(name);
  }

  /**
   * Fetch a server's tool list, validating each entry leniently (A3).
   *
   * Upstream `McpClient.listTools()` validates a whole page with
   * `validateListPage()`, which throws on the *first* malformed entry — so one
   * sloppy tool (a missing `inputSchema`, say) took the entire server offline
   * and lost the valid tools with it. pi-mcp is vendored and off-limits, so the
   * page is requested directly and validated here instead: unusable entries are
   * dropped with a warning and the rest are registered.
   */
  private async requestTools(rt: ServerRuntime, client: McpClient): Promise<Tool[]> {
    const timeoutMs = (rt.config.timeoutSec ?? this.section.requestTimeoutSec) * 1000;
    const startedAt = Date.now();
    try {
      return await withTimeout(
        this.listToolsLeniently(rt, client, timeoutMs),
        timeoutMs,
        `MCP server "${rt.config.name}" tools/list timed out after ${timeoutMs}ms`,
      );
    } catch (err) {
      const oversize = await this.takeOversizeFailure(rt, startedAt);
      if (oversize) throw new Error(oversize);
      throw err;
    }
  }

  /** Page through `tools/list`, keeping the entries upstream would have thrown on. */
  private async listToolsLeniently(
    rt: ServerRuntime,
    client: McpClient,
    timeoutMs: number,
  ): Promise<Tool[]> {
    const tools: Tool[] = [];
    const skipped: string[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;

    for (let page = 0; page < MAX_TOOL_LIST_PAGES; page++) {
      const raw = await client.request<unknown>(
        'tools/list',
        cursor === undefined ? undefined : { cursor },
        { timeoutMs },
      );
      const parsed = parseToolListPage(raw, skipped);
      tools.push(...parsed.tools);

      if (parsed.nextCursor === undefined) {
        if (skipped.length > 0) {
          this.deps.logger.warn(
            { server: rt.config.name, skipped, kept: tools.length },
            'MCP server returned invalid tools/list entries — skipping them',
          );
        }
        if (parsed.badCursor) {
          this.deps.logger.warn(
            { server: rt.config.name, kept: tools.length },
            'MCP server returned an unusable tools/list cursor — stopping pagination',
          );
        }
        return tools;
      }

      if (cursors.has(parsed.nextCursor)) {
        throw new Error(
          `MCP server "${rt.config.name}" tools/list returned duplicate cursor: ${parsed.nextCursor}`,
        );
      }
      cursors.add(parsed.nextCursor);
      cursor = parsed.nextCursor;
    }

    throw new Error(
      `MCP server "${rt.config.name}" tools/list exceeded ${MAX_TOOL_LIST_PAGES} pages`,
    );
  }

  /**
   * Turn an over-limit transport frame into an explicit error (A4).
   *
   * The frame is dropped and the pending request would otherwise hang until its
   * timeout; the connection is desynchronised by then, so it has already been
   * closed and the caller gets a message naming the limit instead.
   */
  private async takeOversizeFailure(rt: ServerRuntime, since: number): Promise<string | undefined> {
    const oversize = rt.oversize;
    if (!oversize || oversize.at < since) return undefined;

    rt.oversize = undefined;
    await oversize.closing;
    this.setState(rt, 'disconnected', oversize.message);
    this.notifyToolsChanged();
    return oversize.message;
  }

  /** Record — and act on — a frame the transport refused to deliver (A4). */
  private noteTransportError(rt: ServerRuntime, err: Error): void {
    if (!TRANSPORT_OVERSIZE_PATTERN.test(err.message)) return;

    const limit = mcpTransportMaxMessageBytes(this.section);
    const message =
      `MCP server "${rt.config.name}" sent a response larger than the transport limit ` +
      `(${limit} bytes) and the connection was dropped; raise mcp.max_output_bytes ` +
      `to allow bigger responses. Transport said: ${err.message}`;
    this.deps.logger.error(
      { server: rt.config.name, limit, err: err.message },
      'MCP response exceeded the transport message limit — dropping the connection',
    );
    // Framing is desynchronised after a dropped frame, so the connection goes:
    // the pending request fails now instead of hanging to its timeout.
    rt.oversize = { message, at: Date.now(), closing: this.closeClient(rt) };
  }

  /**
   * Resolve a connected client for one resource request. Resources are read the
   * same way tool calls run: lazily reconnect a dropped server (§6.7) and bound
   * the request with the server's timeout.
   */
  private async withResourceClient<T>(
    serverName: string,
    work: (client: McpClient, timeoutMs: number) => Promise<T>,
  ): Promise<T> {
    const rt = this.requireServer(serverName);
    await this.ensureConnected(rt);
    const client = rt.client;
    if (!client) throw new Error(`MCP server "${serverName}" is not connected`);

    const startedAt = Date.now();
    try {
      return await work(client, this.serverRequestTimeoutMs(rt));
    } catch (err) {
      const oversize = await this.takeOversizeFailure(rt, startedAt);
      if (oversize) throw new Error(oversize);
      throw err;
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private createServerRuntime(config: McpServerConfig, enabled: boolean): ServerRuntime {
    return {
      config,
      enabled,
      client: undefined,
      disposers: [],
      toolNames: new Map(),
      registered: new Set(),
      signature: '',
      connectPromise: undefined,
      generation: 0,
      transport: undefined,
      oversize: undefined,
      retryCount: 0,
      nextRetryAt: 0,
      stderrTail: '',
      logSink: undefined,
      closing: false,
      oauth: undefined,
      state: {
        name: config.name,
        state: enabled ? 'disconnected' : 'disabled',
        tools: [],
        errorCount: 0,
        updatedAt: Date.now(),
        authRequired: false,
        supportsResources: false,
        supportsPrompts: false,
      },
    };
  }

  private isEnabled(server: McpServerConfig): boolean {
    return this.section.enabled && server.enabled;
  }

  private requireServer(name: string): ServerRuntime {
    const rt = this.servers.get(name);
    if (!rt) throw new Error(`Unknown MCP server "${name}"`);
    return rt;
  }

  /** Per-server request timeout, falling back to `mcp.request_timeout_sec`. */
  private serverRequestTimeoutMs(rt: ServerRuntime): number {
    return (rt.config.timeoutSec ?? this.section.requestTimeoutSec) * 1000;
  }

  private setState(rt: ServerRuntime, state: McpConnectionState, error?: string): void {
    rt.state.state = state;
    rt.state.error = error;
    rt.state.updatedAt = Date.now();
  }

  /**
   * Bounded stderr tail for the WebUI log pane (§9.3 / §13.3).
   *
   * The tail is capped by *bytes*: counting characters let non-ASCII stderr hold
   * roughly twice the intended budget (R7). Each chunk is also appended to the
   * server's log file (§13.12).
   */
  private appendStderr(rt: ServerRuntime, chunk: string): void {
    if (this.stopped) return;
    rt.stderrTail = takeTailBytes(`${rt.stderrTail}${chunk}`, MCP_STDERR_TAIL_BYTES);
    rt.state.stderrTail = rt.stderrTail;
    this.logSinkFor(rt).append(chunk);
  }

  /**
   * The server's file sink, created on first output (§13.12).
   *
   * Every server gets one, not just stdio ones: an HTTP server has no stderr but
   * still reports through `notifications/message`.
   */
  private logSinkFor(rt: ServerRuntime): McpServerLogSink {
    rt.logSink ??= new McpServerLogSink(
      mcpLogFilePath(rt.config.name),
      rt.config.name,
      this.deps.logger,
    );
    return rt.logSink;
  }

  /**
   * Forward one `notifications/message` entry (§13.12) to the main logger at the
   * level it declares, and to the server's log file.
   *
   * An unknown level degrades to `info` instead of throwing: a misbehaving server
   * must not take the gateway down.
   */
  private handleLogMessage(rt: ServerRuntime, params: unknown): void {
    if (this.stopped) return;
    const entry = isPlainObject(params) ? params : {};
    const level = mapMcpLogLevel(entry['level']);
    const fields = { server: rt.config.name };
    const text = formatLogMessageData(entry['data']);

    if (level === 'debug') this.deps.logger.debug(fields, text);
    else if (level === 'warn') this.deps.logger.warn(fields, text);
    else if (level === 'error') this.deps.logger.error(fields, text);
    else this.deps.logger.info(fields, text);

    this.logSinkFor(rt).append(text === '' ? level : `${level} ${text}`);
  }

  private snapshot(rt: ServerRuntime): McpServerState {
    return { ...rt.state, tools: [...rt.state.tools] };
  }

  private notifyToolsChanged(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (err) {
        this.deps.logger.error({ err: errorMessage(err) }, 'MCP onToolsChanged listener threw');
      }
    }
  }
}

/** Backoff for the nth consecutive failure: 1s, 2s, 4s … capped at 30s (§9.2). */
function reconnectBackoffMs(failureCount: number): number {
  const exponent = Math.max(0, failureCount - 1);
  return Math.min(RECONNECT_BACKOFF_BASE_MS * 2 ** exponent, RECONNECT_BACKOFF_MAX_MS);
}

/**
 * Raised when a connect attempt was superseded by `stop()`, a disable or a newer
 * attempt (A1/R1).
 *
 * It exists so a caller never mistakes a cancelled attempt for a successful one:
 * `connectQuietly()` and `cancelConnectAttempt()` swallow it, everything else
 * sees a rejection rather than a half-connected runtime.
 */
class ConnectCancelledError extends Error {
  constructor(serverName: string) {
    super(`MCP connection attempt for "${serverName}" was cancelled`);
    this.name = 'ConnectCancelledError';
  }
}

/**
 * The parts of a server config that decide *how* the connection is built (C5).
 *
 * `description` is deliberately absent: it reaches the model through the system
 * prompt, so a description edit must not tear a healthy connection down.
 */
function connectionFingerprint(server: McpServerConfig): string {
  const shared = {
    transport: server.transport,
    timeoutSec: server.timeoutSec,
    exposure: server.exposure,
    toolEnabled: server.toolEnabled,
  };

  return JSON.stringify(
    server.transport === 'stdio'
      ? { ...shared, command: server.command, args: server.args, env: server.env, cwd: server.cwd }
      : { ...shared, url: server.url, headers: server.headers, oauth: server.oauth },
  );
}

/**
 * Whether `tool_enabled` lets one tool be registered.
 *
 * A switched-off tool is still cached (so the UI can switch it back on) but is
 * never registered, so the model can neither see nor call it (§13.6).
 */
function isToolEnabled(server: McpServerConfig, rawToolName: string): boolean {
  return (server.toolEnabled ?? {})[rawToolName] !== false;
}

/** `initialize.instructions`, cut to a size the WebUI can render (§13.7). */
function summariseInstructions(instructions: string | undefined): string | undefined {
  const text = instructions?.trim();
  if (!text) return undefined;
  return text.length > MCP_INSTRUCTIONS_SUMMARY_MAX_CHARS
    ? `${text.slice(0, MCP_INSTRUCTIONS_SUMMARY_MAX_CHARS)}…`
    : text;
}

/** One validated `tools/list` page: usable tools, the cursor, what was dropped. */
interface ParsedToolListPage {
  tools: Tool[];
  nextCursor?: string;
  /** True when a cursor was present but unusable, so pagination stops there. */
  badCursor: boolean;
}

/**
 * Validate one `tools/list` result leniently (A3).
 *
 * A broken *envelope* still throws — that is a protocol failure, not a sloppy
 * tool — while individual entries are filtered down to what upstream's `isTool()`
 * requires (`name` plus an object `inputSchema`). Anything else is collected in
 * `skipped` so the caller can name it in a warning.
 */
function parseToolListPage(value: unknown, skipped: string[]): ParsedToolListPage {
  if (!isPlainObject(value) || !Array.isArray(value['tools'])) {
    throw new Error('Invalid MCP tools/list result');
  }

  const tools: Tool[] = [];
  for (const [index, entry] of value['tools'].entries()) {
    if (!isToolEntry(entry)) {
      skipped.push(describeSkippedEntry(entry, index));
      continue;
    }
    tools.push(entry);
  }

  return { tools, ...parseListCursor(value['nextCursor']) };
}

function isToolEntry(entry: unknown): entry is Tool {
  return (
    isPlainObject(entry) &&
    typeof entry['name'] === 'string' &&
    entry['name'].trim() !== '' &&
    isPlainObject(entry['inputSchema'])
  );
}

/** Names a dropped entry as precisely as its own payload allows. */
function describeSkippedEntry(entry: unknown, index: number): string {
  if (isPlainObject(entry) && typeof entry['name'] === 'string') return entry['name'];
  return `entry #${index}`;
}

/**
 * `nextCursor` may be absent, `null` or `''` — all three end pagination, exactly
 * as upstream treats them. Anything else is unusable, so pagination stops rather
 * than throwing away the tools already collected.
 */
function parseListCursor(raw: unknown): { nextCursor?: string; badCursor: boolean } {
  if (raw === undefined || raw === null || raw === '') return { badCursor: false };
  if (typeof raw === 'string') return { nextCursor: raw, badCursor: false };
  return { badCursor: true };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function defaultTransportFactory(
  server: McpServerConfig,
  hooks: {
    onStderr: (chunk: string) => void;
    authProvider?: AuthProvider;
    maxMessageBytes: number;
  },
): McpTransport {
  if (server.transport === 'stdio') {
    return new StdioTransport({
      command: server.command,
      args: server.args,
      ...(server.cwd ? { cwd: resolveAgentPath(server.cwd) } : {}),
      env: server.env,
      onStderr: hooks.onStderr,
      // Without this the transport kept its own 16MB default and silently dropped
      // every larger reply, which made a bigger `mcp.max_output_bytes`
      // unreachable and desynchronised framing (A4).
      maxMessageBytes: hooks.maxMessageBytes,
    });
  }
  return new StreamableHttpTransport({
    url: server.url,
    headers: server.headers,
    maxMessageBytes: hooks.maxMessageBytes,
    ...(hooks.authProvider ? { authProvider: hooks.authProvider } : {}),
  });
}

/** The `oauth:` block of an HTTP server; throws for anything else. */
function requireOAuthConfig(server: McpServerConfig): McpOAuthConfig {
  if (server.transport !== 'http' || !server.oauth) {
    throw new Error(`MCP server "${server.name}" has no oauth configuration`);
  }
  return server.oauth;
}

/** The server URL an OAuth provider is bound to. */
function httpUrlOf(server: McpServerConfig): string {
  if (server.transport !== 'http') {
    throw new Error(`MCP server "${server.name}" is not an HTTP server`);
  }
  return server.url;
}

/**
 * Redirect URL sent in the authorization request (§10.1 step 5).
 *
 * Derived from `oauth.callback_url` when set, otherwise from the stable
 * `oauth.callback_port`. It must not change between logins: it is part of the
 * registered client, and the local callback server binds exactly this port.
 */
function oauthRedirectUrl(oauth: McpOAuthConfig): string {
  const configured = oauth.callbackUrl.trim();
  if (configured) return new URL(configured).href;
  return `http://127.0.0.1:${oauth.callbackPort}${OAUTH_CALLBACK_PATH}`;
}

/** The parts of a redirect URL a loopback callback server has to reproduce. */
interface LoopbackCallbackTarget {
  host: string;
  port: number;
  path: string;
}

/**
 * `undefined` when the redirect is not on loopback — a remote gateway's URL
 * cannot be served from this process, so the flow has to be manual.
 */
function loopbackCallbackTarget(redirectUrl: string): LoopbackCallbackTarget | undefined {
  const url = new URL(redirectUrl);
  if (!isLoopbackHost(url.hostname)) return undefined;

  const defaultPort = url.protocol === 'https:' ? 443 : 80;
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : defaultPort,
    path: url.pathname || OAUTH_CALLBACK_PATH,
  };
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]'
  );
}

/**
 * Accept what a user can realistically paste into the WebUI: the whole redirect
 * URL, a bare query string, or just the `code=…&state=…` pair. The redirect URL
 * is the base, so a relative form resolves to the same shape.
 */
function parseCallbackUrl(raw: string, redirectUrl: string): URL {
  const value = raw.trim();
  if (!value) throw new Error('MCP OAuth callback URL is empty');
  try {
    return new URL(value);
  } catch {
    return new URL(value.startsWith('?') ? value : `?${value}`, redirectUrl);
  }
}

/**
 * Both the transport's own "this endpoint needs a token" error and the OAuth
 * provider's "the user has to finish an interactive flow" outcome mean the
 * server is waiting on the user, not that it is broken.
 */
function isAuthRequiredError(err: unknown): boolean {
  return err instanceof McpAuthRequiredError || err instanceof McpOAuthAuthorizationRequiredError;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Directory the per-server MCP log files live in (§13.12).
 *
 * Mirrors `resolveLogDir()` in `src/app/logger.ts`, the location the logs route
 * already reads from: `OHMYAGENT_LOG_DIR` wins, then `<OHMYAGENT_HOME>/logs`,
 * then `~/.ohmyagent/logs`. Both the sink and the route go through
 * {@link mcpLogFilePath}, so the writer and the reader cannot disagree.
 */
function resolveMcpLogDir(): string {
  if (process.env.OHMYAGENT_LOG_DIR) return process.env.OHMYAGENT_LOG_DIR;
  if (process.env.OHMYAGENT_HOME) return join(process.env.OHMYAGENT_HOME, 'logs');
  return join(homedir(), '.ohmyagent', 'logs');
}

/** Absolute path of one server's log file — the sink and the route share it. */
export function mcpLogFilePath(serverName: string): string {
  return join(resolveMcpLogDir(), `mcp-${serverName}.log`);
}

/** pino level methods the manager's minimal logger interface offers. */
type McpLogLevel = 'debug' | 'info' | 'warn' | 'error';

/** MCP `notifications/message` levels → pino levels. */
const MCP_LOG_LEVEL_MAP: Record<string, McpLogLevel> = {
  debug: 'debug',
  info: 'info',
  notice: 'info',
  warning: 'warn',
  error: 'error',
  critical: 'error',
  alert: 'error',
  emergency: 'error',
};

/** MCP notification level → pino level; anything unrecognised becomes `info`. */
function mapMcpLogLevel(level: unknown): McpLogLevel {
  return typeof level === 'string' ? (MCP_LOG_LEVEL_MAP[level] ?? 'info') : 'info';
}

/** Render a `notifications/message` `data` payload as one log line. */
function formatLogMessageData(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data === undefined) return '';
  try {
    return JSON.stringify(data) ?? String(data);
  } catch {
    return String(data);
  }
}

/**
 * Stamp every line of `text` with one ISO timestamp and a trailing newline.
 *
 * Splitting on lines is what lets a rotated file be read on its own: every line
 * carries the time it was written, not just the chunk that carried it. An empty
 * chunk yields an empty string so nothing is appended for it.
 */
function stampLogLines(text: string): string {
  if (text === '') return '';
  const stamp = new Date().toISOString();
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.map((line) => `${stamp} ${line}\n`).join('');
}

/**
 * Append-only, single-generation-rotating log file for one MCP server (§13.12).
 *
 * Writes are serialised through a promise chain, so the hot stderr path never
 * blocks the event loop and two appends never interleave: {@link append} queues
 * the chunk and returns. Every line is prefixed with an ISO timestamp.
 */
class McpServerLogSink {
  private queue: Promise<void> = Promise.resolve();
  private dirReady: Promise<void> | undefined;
  private closed = false;

  constructor(
    private readonly filePath: string,
    private readonly server: string,
    private readonly logger: McpManagerLogger,
  ) {}

  /** Queue `text` and return; a failed write is logged, never thrown. */
  append(text: string): void {
    if (this.closed) return;
    const stamped = stampLogLines(text);
    if (stamped === '') return;
    this.queue = this.queue
      .then(() => this.write(stamped))
      .catch((err: unknown) => {
        this.logger.warn(
          { server: this.server, err: errorMessage(err) },
          'MCP server log write failed',
        );
      });
  }

  /** Stop accepting writes and wait for whatever is still queued to land. */
  async close(): Promise<void> {
    this.closed = true;
    await this.queue;
  }

  private async write(stamped: string): Promise<void> {
    await this.ensureDir();
    await this.rotateIfNeeded(Buffer.byteLength(stamped, 'utf8'));
    await appendFile(this.filePath, stamped, 'utf8');
  }

  /** Create the log directory once; a failure is retried by the next append. */
  private ensureDir(): Promise<void> {
    this.dirReady ??= mkdir(dirname(this.filePath), { recursive: true }).then(
      () => undefined,
      (err: unknown) => {
        this.dirReady = undefined;
        throw err;
      },
    );
    return this.dirReady;
  }

  /**
   * Rotate to `<file>.1` when the next append would cross {@link MCP_LOG_MAX_BYTES}.
   *
   * The size check runs before the append and counts the incoming chunk, so a
   * chunk larger than the whole limit still lands in a fresh file instead of
   * being dropped. One generation is kept: the previous `.1` is overwritten.
   */
  private async rotateIfNeeded(incomingBytes: number): Promise<void> {
    let size: number;
    try {
      size = (await stat(this.filePath)).size;
    } catch {
      return; // Nothing written yet — there is no file to rotate.
    }
    if (size + incomingBytes <= MCP_LOG_MAX_BYTES) return;

    await rm(`${this.filePath}.1`, { force: true });
    await rename(this.filePath, `${this.filePath}.1`);
  }
}
