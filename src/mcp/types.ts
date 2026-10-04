// ---------------------------------------------------------------------------
// MCP integration — shared types
// ---------------------------------------------------------------------------
//
// See MyDocs/MCP_INTEGRATION_DESIGN.md §5 (config), §6 (tool adapter),
// §11 (resources), §13.7 (API shapes).
//
// This file is the contract shared by `src/mcp/*`, `src/app/composers`,
// `src/app/webui/mcp-routes.ts` and the agent pipeline. Extend it; do not fork
// it, and keep it free of runtime imports (types only).

import type {
  CallToolResult,
  ListResourcesResult,
  ListResourceTemplatesResult,
  ReadResourceResult,
  Tool,
  ToolAnnotations,
} from '@earendil-works/pi-mcp';

export type {
  CallToolResult,
  ListResourcesResult,
  ListResourceTemplatesResult,
  ReadResourceResult,
  Tool,
  ToolAnnotations,
};

/** How a server's tools are surfaced to the model. Mirrors upstream semantics. */
export type McpExposure = 'direct' | 'deferred' | 'hidden';

/** Transport kind, normalised from the optional `type:` config key. */
export type McpTransportKind = 'stdio' | 'http';

export interface McpOAuthConfig {
  clientId: string;
  clientSecret: string;
  callbackPort: number;
  callbackUrl: string;
  scope: string;
  clientName: string;
  authServerMetadataUrl: string;
}

interface McpServerConfigBase {
  /** Server name as written in `config.yaml`; also the tool-name segment. */
  name: string;
  enabled: boolean;
  /** Default exposure for every tool of this server. */
  exposure: McpExposure;
  /**
   * Per-tool exposure overrides keyed by tool name. Keys support a trailing
   * `*` wildcard (`write_*: hidden`) via `matchesToolPattern()`.
   */
  toolExposure: Record<string, McpExposure>;
  /**
   * Per-tool on/off, keyed by raw server tool name. Absent means enabled.
   * A tool switched off is not registered at all, so the model cannot see or
   * call it, but it still appears in `listTools()` so the UI can re-enable it.
   */
  toolEnabled: Record<string, boolean>;
  /**
   * Capability override for servers whose tools carry no annotations (§8.1).
   * Absent means the default ladder (`medium` risk).
   */
  trust?: McpTrustLevel;
  /** Per-server request timeout override, in seconds. */
  timeoutSec?: number;
  description: string;
  oauth?: McpOAuthConfig;
}

export interface McpStdioServerConfig extends McpServerConfigBase {
  transport: 'stdio';
  command: string;
  args: string[];
  /** Already `${ENV}`-interpolated by the config loader. */
  env: Record<string, string>;
  cwd: string;
}

export interface McpHttpServerConfig extends McpServerConfigBase {
  transport: 'http';
  url: string;
  /** Already `${ENV}`-interpolated by the config loader. */
  headers: Record<string, string>;
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

/** The whole `mcp:` section of `config.yaml`, normalised. */
export interface McpSectionConfig {
  enabled: boolean;
  connectTimeoutSec: number;
  requestTimeoutSec: number;
  maxOutputBytes: number;
  maxConcurrentConnects: number;
  injectSystemPrompt: boolean;
  /** Empty means "no restriction". */
  allowServers: string[];
  denyServers: string[];
  servers: Record<string, McpServerConfig>;
}

export type McpConnectionState =
  'disabled' | 'connecting' | 'connected' | 'disconnected' | 'auth_required' | 'error';

/** Live per-server state, owned by `McpManager`. */
export interface McpServerState {
  name: string;
  state: McpConnectionState;
  /** Last successful `listTools()` result; kept across disconnects (§6.7). */
  tools: Tool[];
  error?: string;
  errorCount: number;
  connectedAt?: number;
  /** Epoch ms of the last state transition. */
  updatedAt: number;
  /** True once a 401/OAuth challenge has been seen. */
  authRequired: boolean;
  /** Server-declared `resources` capability, if any. */
  supportsResources: boolean;
  /** Server-declared `prompts` capability, if any. */
  supportsPrompts: boolean;
  protocolVersion?: string;
  serverName?: string;
  serverVersion?: string;
  /** Server `instructions` from the `initialize` result, already truncated. */
  instructionsSummary?: string;
  /** Tail of the child process stderr (stdio only), for the WebUI log pane. */
  stderrTail?: string;
  /** Last connection error text, kept alongside `error` for the §13.7 shape. */
  lastError?: McpServerLastError;
}

/** Server identity from the `initialize` result (§13.7). */
export interface McpServerInfo {
  protocolVersion?: string;
  name?: string;
  version?: string;
}

/** Last observed connection error and when it happened (§13.7). */
export interface McpServerLastError {
  message: string;
  /** Epoch ms. */
  at: number;
}

/**
 * Approval-risk bucket derived from a tool's annotations (§8.2).
 *
 * `low` = `readOnlyHint`, `high` = `destructiveHint`, `medium` = everything
 * else, including an unannotated tool. Mirrors `approvalRiskForTool()`.
 */
export type McpApprovalRisk = 'low' | 'medium' | 'high';

/**
 * Server-level capability override for servers that declare no annotations (§8.1).
 *
 * Applied only when a tool carries NO annotations at all: `read_only` treats it
 * as read-only (risk `low`), `high_risk` as destructive (risk `high`), and
 * `normal` keeps the default `medium`. A server that DOES annotate a tool is
 * never overridden — the annotations win.
 */
export type McpTrustLevel = 'read_only' | 'normal' | 'high_risk';

/**
 * Where a server's definition came from (§13.7).
 *
 * Decision D2 makes `config.yaml` the single source of truth, and both the
 * WebUI and `pnpm mcp:import` write it, so this is always `'config.yaml'`
 * today. The field exists so the API matches §13.7, and so a future second
 * source can be reported without another contract change.
 */
export type McpServerSource = 'config.yaml';

/** API response shape for one tool (`GET /api/mcp/servers/:name/tools`). */
export interface McpToolView {
  /** Registered tool name, including the `mcp__<server>__` prefix. */
  name: string;
  /** Raw tool name as declared by the server. */
  serverToolName: string;
  title?: string;
  description?: string;
  /** Effective exposure after `tool_exposure` overrides. */
  exposure: McpExposure;
  /**
   * False when `tool_enabled` switched this tool off. A disabled tool is still
   * listed (so the UI can switch it back on) but is not registered, so the
   * model never sees it.
   */
  enabled: boolean;
  approvalRisk: McpApprovalRisk;
  annotations?: ToolAnnotations;
  readOnly: boolean;
  destructive: boolean;
  idempotent: boolean;
  openWorld: boolean;
}

/** API response shape for one resource or template (§13.6 / §13.7). */
export interface McpResourceView {
  /** Owning server name. */
  server: string;
  /** Concrete resources only. */
  uri?: string;
  /** Templates only. */
  uriTemplate?: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
  /** True for entries that came from `listResourceTemplates`. */
  template: boolean;
}

/** API response shape for one server (`GET /api/mcp/servers`). */
export interface McpServerView {
  name: string;
  enabled: boolean;
  transport: McpTransportKind;
  exposure: McpExposure;
  description: string;
  state: McpConnectionState;
  error?: string;
  errorCount: number;
  connectedAt?: number;
  toolCount: number;
  /** Credentials are masked; never the raw secret. */
  hasCredentials: boolean;
  authRequired: boolean;
  /** Always true: a server in this list is configured by definition (§13.7). */
  installed: true;
  /** Identity reported by the server's `initialize` result. */
  serverInfo?: McpServerInfo;
  instructionsSummary?: string;
  lastError?: McpServerLastError;
  source: McpServerSource;
  /** stdio only. */
  command?: string;
  args?: string[];
  cwd?: string;
  envKeys?: string[];
  /** http only. */
  url?: string;
  headerKeys?: string[];
  toolExposure: Record<string, McpExposure>;
  timeoutSec?: number;
}

/** Request body for install / update (`POST` / `PUT /api/mcp/servers`). */
export interface McpServerInput {
  name: string;
  enabled?: boolean;
  exposure?: McpExposure;
  description?: string;
  toolExposure?: Record<string, McpExposure>;
  /** Per-tool on/off, keyed by raw server tool name (§13.6). */
  toolEnabled?: Record<string, boolean>;
  timeoutSec?: number;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  oauth?: Partial<McpOAuthConfig>;
}

export interface McpCallOptions {
  signal?: AbortSignal;
  /** Overrides `mcp.request_timeout_sec` for this call. */
  timeoutMs?: number;
}

/**
 * Resource access surface (§11).
 *
 * Kept separate from the main tool surface because it is only meaningful for
 * servers that declare the `resources` capability, and because the three
 * resource tools are registered globally rather than per-server. The concrete
 * manager implements this and exposes it as `McpManager.resources`; the
 * resource tool definitions take it as an injected dependency so they can be
 * unit-tested against a stub without a live server.
 */
export interface McpResourceAccess {
  listResources(
    serverName: string,
    cursor?: string,
    opts?: McpCallOptions,
  ): Promise<ListResourcesResult>;
  listResourceTemplates(
    serverName: string,
    cursor?: string,
    opts?: McpCallOptions,
  ): Promise<ListResourceTemplatesResult>;
  readResource(serverName: string, uri: string, opts?: McpCallOptions): Promise<ReadResourceResult>;
  /** Server names that declared the `resources` capability. */
  serversWithResources(): string[];
}

export interface McpLoginResult {
  authorizationUrl: string;
  /** True when the user must paste the callback URL back (headless). */
  manual: boolean;
}

/**
 * The surface every other layer programs against. Implemented by
 * `src/mcp/mcp-manager.ts`; `src/mcp/types.ts` stays free of implementation.
 */
export interface McpManager {
  /**
   * Resolves once the initial connect pass has settled. Never rejects — a
   * failing server degrades to `error` state rather than blocking startup.
   */
  ready(): Promise<void>;

  /** Idempotent shutdown: closes every client and clears timers. */
  stop(): Promise<void>;

  /** Re-read the injected config and reconcile (add / remove / reconnect). */
  reload(): Promise<void>;

  /** Every configured server, in `config.yaml` order. */
  listServers(): McpServerState[];

  getServerState(name: string): McpServerState | undefined;

  /**
   * Cached tool list for one server. Works while disconnected, which is what
   * `GET /api/mcp/servers/:name/tools` must use — `hidden` tools are never
   * registered, so the tool registry cannot answer this.
   */
  listTools(serverName: string): Tool[];

  /**
   * Forward a tool call. Transport failures throw; MCP-level failures are
   * reported inside the result via `isError` (§6.4).
   */
  callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    opts?: McpCallOptions,
  ): Promise<CallToolResult>;

  /** Force a reconnect now; resolves with the resulting state. */
  reconnect(serverName: string): Promise<McpServerState>;

  /** Registered names that must stay directly visible (`exposure: 'direct'`). */
  alwaysVisibleTools(): string[];

  /** Begin the OAuth flow; returns the URL to open. */
  login(serverName: string): Promise<McpLoginResult>;

  /** Drop stored credentials and disconnect. */
  logout(serverName: string): Promise<void>;

  /** Complete a headless OAuth flow with a pasted callback URL. */
  submitCallback(serverName: string, callbackUrl: string): Promise<void>;

  /** Subscribe to tool-set changes (connect, disconnect, `list_changed`). */
  onToolsChanged(listener: () => void): () => void;

  /**
   * Resource access (§11). Present only when the manager was built with resource
   * support; consumers must feature-test with `manager.resources?`. Declared
   * optional so the resource surface can evolve without breaking the core
   * lifecycle contract.
   */
  readonly resources?: McpResourceAccess;
}
