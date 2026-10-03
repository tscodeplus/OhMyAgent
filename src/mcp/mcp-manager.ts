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
    hooks: { onStderr: (chunk: string) => void; authProvider?: AuthProvider },
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
  retryCount: number;
  nextRetryAt: number;
  stderrTail: string;
  /** True while this manager is intentionally closing the client. */
  closing: boolean;
  /** OAuth provider + token provider, created on first use (§10). */
  oauth: OAuthRuntime | undefined;
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
   * Resource access surface (§11). Optional on the interface, but always
   * present here — the three resource tools and the detail drawer feature-test
   * it with `manager.resources?`.
   */
  readonly resources: McpResourceAccess = {
    listResources: (serverName, cursor) =>
      this.withResourceClient(serverName, (client, timeoutMs) =>
        client.listResourcesPage(cursor, { timeoutMs }),
      ),
    listResourceTemplates: (serverName, cursor) =>
      this.withResourceClient(serverName, (client, timeoutMs) =>
        client.listResourceTemplatesPage(cursor, { timeoutMs }),
      ),
    readResource: (serverName, uri) =>
      this.withResourceClient(serverName, (client, timeoutMs) =>
        client.readResource(uri, { timeoutMs }),
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
        await this.cancelPendingFlow(rt.config.name);
        await this.closeClient(rt);
        this.unregisterServerTools(rt);
        this.setState(rt, 'disabled');
      }),
    );
    this.listeners.clear();
  }

  async reload(): Promise<void> {
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
      // connect even though `enabled` and `configChanged` both look like steady
      // state. Without this, installing or enabling a server would only take
      // effect after a restart — `createServerRuntime` seeds `enabled: true`
      // and `rt.config` is already the new config, so both guards pass.
      const isNew = rt === undefined;
      if (!rt) {
        rt = this.createServerRuntime(server, enabled);
        this.servers.set(server.name, rt);
      }

      const configChanged = JSON.stringify(rt.config) !== JSON.stringify(server);
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

      const wasServing = !isNew && rt.enabled && !configChanged && previousEnabled;
      rt.enabled = true;
      // A config change (command/url/env/exposure) needs a fresh connection so
      // the new transport and the new tool set are actually used.
      if (!wasServing) {
        await this.closeClient(rt);
        await this.connectQuietly(rt, 'reload');
      }
    }
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
    try {
      return await client.callTool(toolName, args, {
        ...(opts.signal ? { signal: opts.signal } : {}),
        timeoutMs,
      });
    } catch (err) {
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
    this.setState(rt, 'connecting');

    const client = new McpClient({ name: MCP_CLIENT_NAME, version: getAppVersion() ?? '0.0.0' });
    const disposers: Array<() => void> = [
      client.onError((err) => {
        this.deps.logger.warn({ server: name, err: err.message }, 'MCP client error');
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
    ];

    try {
      // Only an explicitly OAuth-configured HTTP server gets a token provider;
      // everything else keeps the pre-§10 behaviour where a 401 surfaces as
      // `McpAuthRequiredError`.
      const authProvider = this.authProviderFor(rt);
      const transport = this.createTransport(rt.config, {
        onStderr: (chunk) => this.appendStderr(rt, chunk),
        ...(authProvider ? { authProvider } : {}),
      });
      const connectTimeoutMs = this.section.connectTimeoutSec * 1000;
      await withTimeout(
        client.connect(transport),
        connectTimeoutMs,
        `MCP server "${name}" connect timed out after ${connectTimeoutMs}ms`,
      );

      rt.client = client;
      rt.disposers = disposers;

      const tools = await this.requestTools(rt, client);
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
      try {
        await client.close();
      } catch {
        // Best effort — the connect failure below is the one worth reporting.
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
      this.setState(rt, authRequired ? 'auth_required' : 'error', errorMessage(err));

      this.deps.logger.warn(
        { server: name, reason, err: errorMessage(err), authRequired },
        'MCP server connection failed',
      );
      throw err;
    }
  }

  private async closeClient(rt: ServerRuntime): Promise<void> {
    const client = rt.client;
    rt.client = undefined;
    for (const dispose of rt.disposers) dispose();
    rt.disposers = [];
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
      // `hidden` means "do not register at all" — the tool stays in
      // `rt.state.tools` so the WebUI can still list and re-expose it (§7.1).
      if (exposure === 'hidden') continue;

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
          offload: this.offload(),
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
   * collides with an existing non-MCP tool: masking a built-in behind an alias
   * would silently replace it, so the design calls for refusal + warning
   * (§6.1 layer 2, §17).
   */
  private allocateToolName(
    rt: ServerRuntime,
    rawToolName: string,
    reserved: ReadonlySet<string>,
  ): string | undefined {
    const name = createMcpToolName(rt.config.name, rawToolName, (candidate) =>
      reserved.has(candidate),
    );

    if (reserved.has(name) || this.deps.toolRegistry.has(name)) {
      this.deps.logger.warn(
        { server: rt.config.name, tool: rawToolName, name },
        'MCP tool name collides with an existing tool — refusing to register it',
      );
      return undefined;
    }

    rt.toolNames.set(rawToolName, name);
    return name;
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

  private offload(): { store: OffloadStore; maxBytes: number } {
    return { store: this.deps.offloadStore, maxBytes: this.section.maxOutputBytes };
  }

  private requestTools(rt: ServerRuntime, client: McpClient): Promise<Tool[]> {
    const timeoutMs = (rt.config.timeoutSec ?? this.section.requestTimeoutSec) * 1000;
    return withTimeout(
      client.listTools(),
      timeoutMs,
      `MCP server "${rt.config.name}" tools/list timed out after ${timeoutMs}ms`,
    );
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
      retryCount: 0,
      nextRetryAt: 0,
      stderrTail: '',
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
    return work(client, this.serverRequestTimeoutMs(rt));
  }

  private setState(rt: ServerRuntime, state: McpConnectionState, error?: string): void {
    rt.state.state = state;
    rt.state.error = error;
    rt.state.updatedAt = Date.now();
  }

  /** Bounded stderr tail for the WebUI log pane (§9.3 / §13.3). */
  private appendStderr(rt: ServerRuntime, chunk: string): void {
    const combined = rt.stderrTail + chunk;
    rt.stderrTail =
      combined.length > MCP_STDERR_TAIL_BYTES
        ? combined.slice(combined.length - MCP_STDERR_TAIL_BYTES)
        : combined;
    rt.state.stderrTail = rt.stderrTail;
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

function defaultTransportFactory(
  server: McpServerConfig,
  hooks: { onStderr: (chunk: string) => void; authProvider?: AuthProvider },
): McpTransport {
  if (server.transport === 'stdio') {
    return new StdioTransport({
      command: server.command,
      args: server.args,
      ...(server.cwd ? { cwd: resolveAgentPath(server.cwd) } : {}),
      env: server.env,
      onStderr: hooks.onStderr,
    });
  }
  return new StreamableHttpTransport({
    url: server.url,
    headers: server.headers,
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
