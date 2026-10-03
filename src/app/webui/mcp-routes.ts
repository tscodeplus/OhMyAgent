/**
 * MCP API routes — the 14 endpoints of MyDocs/MCP_INTEGRATION_DESIGN.md §13.7.
 *
 * See also §13.1 (the four orthogonal states), §13.4 (uninstall order),
 * §13.5 (enable/disable), §13.8 (persistence) and §13.11 (server strings).
 *
 * Auth: these routes are protected by exactly the same `webuiAuthHook` as every
 * other `/api/*` route. `bootstrap.ts` registers that hook on the root Fastify
 * instance *before* `registerWebUIRoutes()` runs, and Fastify applies an
 * `onRequest` hook to the routes registered after it — so this module adds no
 * auth handling of its own and must not be registered before that hook.
 *
 * Two rules shape the implementation:
 *
 *   1. `config.yaml` is the single source of truth (decision 19-2) and every
 *      write goes through `mutateConfigYaml()` (decision 19-11) — the shared
 *      process-wide FIFO queue that also serialises the settings form
 *      (`config-routes.ts`) and agent CRUD (`config-persist.ts`). Reads come
 *      from `AppConfig.mcp`, i.e. the *normalised* section, so this module never
 *      re-implements `${ENV}` interpolation or the `codemode` → `deferred`
 *      aliasing that `src/mcp/config.ts` owns.
 *
 *   2. Secrets never travel back. `env` / `headers` values are not part of
 *      `McpServerView` at all (only `envKeys` / `headerKeys`, §13.7), and a
 *      value the client echoes back that `isMaskedValue()` recognises is read
 *      as "leave the stored secret alone" — never written as the literal mask.
 *
 * Every response shape is taken from `src/mcp/types.ts`, the contract the
 * already-built WebUI (`ui/src/components/settings/mcp/`) consumes field by
 * field. Do not rename a field on one side only.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import type Database from 'better-sqlite3';
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import { DEFAULT_MCP_SECTION, MCP_SERVER_NAME_PATTERN } from '../../mcp/config.js';
import { mcpAnnotationFlags } from '../../mcp/capability.js';
import { isMaskedValue, maskRecord } from '../../mcp/masking.js';
import {
  createMcpManager,
  type McpManagerLogger,
  type McpToolRegistryLike,
} from '../../mcp/mcp-manager.js';
import { deleteMcpOAuthCredentials, hasMcpOAuthCredentials } from '../../mcp/oauth-store.js';
import { listMcpPresets } from '../../mcp/presets.js';
import { createMcpToolName, resolveMcpExposure } from '../../mcp/tool-adapter.js';
import type {
  McpConnectionState,
  McpExposure,
  McpManager,
  McpOAuthConfig,
  McpServerConfig,
  McpServerInput,
  McpServerView,
  McpToolView,
} from '../../mcp/types.js';
import { OffloadStore } from '../../runtime-artifacts/offload-store.js';
import { i18n } from '../../i18n/index.js';
import { loadConfig } from '../config.js';
import type { AppConfig } from '../types.js';
import { applyConfigObject, mutateConfigYaml, readConfigObject } from './yaml-mutation.js';

/** Result of `POST /api/mcp/test` — mirrors the WebUI's `McpTestResult`. */
export interface McpProbeResult {
  ok: boolean;
  serverInfo?: { name?: string; version?: string; protocolVersion?: string };
  tools?: Array<{ name: string; description?: string }>;
  error?: string;
  /** Tail of the child process stderr (stdio only), §13.3. */
  stderrTail?: string;
}

/**
 * Dry connect used by `POST /api/mcp/test` (§13.3): connects a throwaway
 * manager and never touches `config.yaml`. Injectable so tests can exercise the
 * route without spawning a real server (§16: MCP tests must not spawn `npx`).
 */
export type McpProbe = (server: McpServerConfig) => Promise<McpProbeResult>;

export interface McpRouteDeps {
  /** OAuth credential rows — `hasCredentials` on reads, purge on uninstall. */
  db: Database.Database;
  /** Current config; re-read after each write so responses carry fresh state. */
  getConfig: () => AppConfig;
  /**
   * Live manager, or `undefined` when `config.yaml` has no enabled `mcp:`
   * section (`src/app/composers/mcp-services.ts`). Config-editing endpoints
   * still work in that case; endpoints that need a running transport answer 503.
   */
  getManager: () => McpManager | undefined;
  /** Hot-reload callback `PUT /api/config` uses; called after every write. */
  onConfigSaved?: (newConfig: AppConfig) => void;
  /** Test seam for the dry connect; defaults to a real throwaway manager. */
  probe?: McpProbe;
}

/** Log tail length for `GET /api/mcp/servers/:name/logs`, and its hard cap. */
const DEFAULT_LOG_LINES = 200;
const MAX_LOG_LINES = 2000;
/** Bytes read from the end of a log file — a tail must not load the whole file (§13.12). */
const LOG_TAIL_MAX_BYTES = 256 * 1024;

// ─── Request schemas (§5.2 rules + §13.7 bodies) ───

const exposureSchema = z.enum(['direct', 'deferred', 'hidden']);

const serverNameSchema = z
  .string()
  .min(1)
  .regex(MCP_SERVER_NAME_PATTERN, 'may only contain [A-Za-z0-9_-]');

const oauthInputSchema = z
  .object({
    clientId: z.string().optional(),
    clientSecret: z.string().optional(),
    callbackPort: z.number().int().positive().optional(),
    callbackUrl: z.string().optional(),
    scope: z.string().optional(),
    clientName: z.string().optional(),
    authServerMetadataUrl: z.string().optional(),
  })
  .strict();

/** `POST` / `PUT /api/mcp/servers` — `McpServerInput` (§13.7). */
const serverInputSchema = z
  .object({
    name: serverNameSchema,
    enabled: z.boolean().optional(),
    exposure: exposureSchema.optional(),
    description: z.string().optional(),
    toolExposure: z.record(z.string(), exposureSchema).optional(),
    timeoutSec: z.number().int().positive().optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    cwd: z.string().optional(),
    url: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    oauth: oauthInputSchema.optional(),
  })
  .strict();

/**
 * `PATCH /api/mcp/servers/:name` — the design's §13.7 field names, which are
 * snake_case here (`tool_exposure`) unlike `McpServerInput`'s `toolExposure`.
 * The already-built WebUI sends exactly these (`McpSettings.tsx`), so the
 * spelling is part of the contract, not a style choice.
 */
const patchInputSchema = z
  .object({
    enabled: z.boolean().optional(),
    exposure: exposureSchema.optional(),
    description: z.string().optional(),
    tool_exposure: z.record(z.string(), exposureSchema).optional(),
  })
  .strict();

const loginCallbackSchema = z.object({ callbackUrl: z.string().min(1) }).strict();

const purgeQuerySchema = z.enum(['true', 'false']);

/** Raw per-server entry exactly as it is written to `config.yaml` (snake_case). */
type RawServerYaml = Record<string, unknown>;

// ─── Response helpers ───

/** i18next namespace of the API strings — one file per namespace in `src/locales`. */
const NS = 'mcp';

/**
 * Localised server string (§13.11).
 *
 * `key` is the dotted `error.*` key inside this namespace; the response's
 * machine-readable `error` field carries the full `mcp.error.<key>` form
 * (§13.7).
 */
function message(key: string, vars?: Record<string, string | number>): string {
  return i18n.t(`${NS}:${key}`, vars);
}

/**
 * Error response. `error` is a stable machine-readable code (`mcp.error.*`) so
 * clients can branch on it; `message` is the localised text the WebUI toasts.
 * Stack traces and raw config values are never included (§13.7).
 */
function fail(
  reply: FastifyReply,
  status: number,
  key: string,
  vars?: Record<string, string | number>,
) {
  return reply.status(status).send({ error: `${NS}.${key}`, message: message(key, vars) });
}

/** One-line summary of a zod failure — enough to fix the request, no internals. */
function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) =>
      issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message,
    )
    .join('; ');
}

function badBody(reply: FastifyReply, error: z.ZodError) {
  return fail(reply, 400, 'error.invalidBody', { detail: formatIssues(error) });
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A YAML mapping read back as strings — `args: [8080]` is a number in the file. */
function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) out[key] = String(entry);
  return out;
}

// ─── Masking-aware write mapping ───

/**
 * Resolve one incoming secret against the stored one.
 *
 * A client only ever *sees* `••••••`, so echoing it back means "unchanged" and
 * must resolve to the stored value (or to nothing at all for a key that has no
 * stored value — writing the placeholder as a real secret would be worse).
 */
function resolveSecret(incoming: string, stored: string | undefined): string | undefined {
  if (!isMaskedValue(incoming)) return incoming;
  return stored;
}

/**
 * Merge an incoming env/header map over the stored one, dropping masked values
 * that have nothing to resolve to. Absent values are the only thing preserved:
 * the WebUI sends the complete map, so a removed key really is removed.
 */
function mergeSecretRecord(
  incoming: Record<string, string> | undefined,
  stored: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!incoming) return undefined;
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(incoming)) {
    const resolved = resolveSecret(value, stored?.[key]);
    if (resolved !== undefined) merged[key] = resolved;
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/** `oauth` as written to `config.yaml` (snake_case, §5.1); `client_secret` keeps its stored value. */
function toRawOAuth(
  oauth: Partial<McpOAuthConfig> | undefined,
  stored: Record<string, string> | undefined,
): RawServerYaml | undefined {
  if (!oauth) return undefined;
  const raw: RawServerYaml = {};
  if (oauth.clientId) raw.client_id = oauth.clientId;
  const clientSecret = oauth.clientSecret
    ? resolveSecret(oauth.clientSecret, stored?.client_secret)
    : stored?.client_secret;
  if (clientSecret) raw.client_secret = clientSecret;
  if (oauth.callbackPort !== undefined) raw.callback_port = oauth.callbackPort;
  if (oauth.callbackUrl) raw.callback_url = oauth.callbackUrl;
  if (oauth.scope) raw.scope = oauth.scope;
  if (oauth.clientName) raw.client_name = oauth.clientName;
  if (oauth.authServerMetadataUrl) raw.auth_server_metadata_url = oauth.authServerMetadataUrl;
  return Object.keys(raw).length > 0 ? raw : undefined;
}

/**
 * True when the input describes a stdio server.
 *
 * `command: ''` (what the WebUI leaves behind when the transport is switched)
 * counts as *not provided*: writing an empty `command` alongside `url` would
 * produce an entry the config loader rejects and silently skips on reload.
 */
function isStdio(input: McpServerInput): input is McpServerInput & { command: string } {
  return input.command !== undefined && input.command !== '';
}

/**
 * Build the `config.yaml` entry for one server from an API input.
 *
 * `config.yaml` is snake_case while `McpServerInput` is camelCase, and
 * `jsConfigToYaml()` explicitly skips `mcp` (writing the camelCase shape there
 * would produce keys the loader cannot read back) — so this module owns the
 * mapping, and it only ever touches the one entry being written.
 *
 * @param input Validated request body.
 * @param stored The entry currently in `config.yaml`, used to keep masked
 *   secrets.
 */
function toRawServerYaml(input: McpServerInput, stored: RawServerYaml | undefined): RawServerYaml {
  const raw: RawServerYaml = {
    enabled: input.enabled ?? true,
    exposure: input.exposure ?? 'deferred',
  };
  if (input.description) raw.description = input.description;
  if (input.toolExposure && Object.keys(input.toolExposure).length > 0) {
    raw.tool_exposure = input.toolExposure;
  }
  if (input.timeoutSec !== undefined) raw.timeout_sec = input.timeoutSec;

  if (isStdio(input)) {
    raw.command = input.command;
    if (input.args && input.args.length > 0) raw.args = input.args;
    const env = mergeSecretRecord(input.env, stringRecord(stored?.env));
    if (env) raw.env = env;
    if (input.cwd) raw.cwd = input.cwd;
  } else {
    raw.url = input.url;
    const headers = mergeSecretRecord(input.headers, stringRecord(stored?.headers));
    if (headers) raw.headers = headers;
  }

  const oauth = toRawOAuth(input.oauth, stringRecord(stored?.oauth));
  if (oauth) raw.oauth = oauth;
  return raw;
}

/**
 * Endpoint validation shared by `POST`, `PUT` and the dry connect (§5.2):
 * exactly one of `command` (stdio) / `url` (http), and no legacy `/sse`
 * endpoint, which upstream pi-mcp cannot talk to. Returns a `fail()` key.
 */
function endpointIssue(input: McpServerInput): string | undefined {
  const hasCommand = isStdio(input);
  const hasUrl = input.url !== undefined && input.url !== '';
  if (hasCommand && hasUrl) return 'error.endpointBoth';
  if (!hasCommand && !hasUrl) return 'error.endpointRequired';
  if (hasUrl && /\/sse\/?$/i.test(input.url ?? '')) return 'error.sseUnsupported';
  return undefined;
}

/** Normalised config for the dry connect — the same translation the loader does. */
function toProbeConfig(input: McpServerInput): McpServerConfig {
  const base = {
    name: input.name,
    enabled: true,
    exposure: input.exposure ?? ('deferred' as McpExposure),
    toolExposure: input.toolExposure ?? {},
    description: input.description ?? '',
    ...(input.timeoutSec !== undefined ? { timeoutSec: input.timeoutSec } : {}),
  };
  if (isStdio(input)) {
    return {
      ...base,
      transport: 'stdio',
      command: input.command,
      args: input.args ?? [],
      env: input.env ?? {},
      cwd: input.cwd ?? '',
    };
  }
  return { ...base, transport: 'http', url: input.url ?? '', headers: input.headers ?? {} };
}

// ─── Dry connect (§13.3, decision 19-9) ───

/** The probe must not register anything anywhere. */
const NOOP_TOOL_REGISTRY: McpToolRegistryLike = {
  registerDefinition: () => {},
  unregister: () => {},
  has: () => false,
};

/**
 * Connect a server that is not (yet) in `config.yaml` and report what happened.
 *
 * This is the "test connection" step of §13.3 and the visible window for the
 * first `npx -y` pull (decision 19-9). It runs a throwaway `McpManager` over
 * the real transports — reusing the manager is what makes the probe honest —
 * with a no-op registry, so nothing is registered or persisted.
 */
async function probeServer(
  server: McpServerConfig,
  logger: McpManagerLogger,
): Promise<McpProbeResult> {
  const manager = createMcpManager({
    config: { ...DEFAULT_MCP_SECTION, servers: { [server.name]: server } },
    logger,
    toolRegistry: NOOP_TOOL_REGISTRY,
    // Never written to: the probe only connects and lists tools.
    offloadStore: new OffloadStore(tmpdir()),
  });

  try {
    await manager.ready();
    const state = manager.getServerState(server.name);
    const stderrTail = state?.stderrTail;
    if (state?.state !== 'connected') {
      return {
        ok: false,
        error:
          state?.error ?? message('error.connectFailed', { message: state?.state ?? 'unknown' }),
        ...(stderrTail ? { stderrTail } : {}),
      };
    }
    return {
      ok: true,
      serverInfo: {
        name: state.serverName,
        version: state.serverVersion,
        protocolVersion: state.protocolVersion,
      },
      tools: manager.listTools(server.name).map((tool) => ({
        name: tool.name,
        description: tool.description,
      })),
    };
  } finally {
    await manager.stop();
  }
}

// ─── Log tail (§13.6 "logs", §13.12) ───

/**
 * Mirror of `resolveLogDir()` in `src/app/logger.ts`, which keeps it private
 * and is outside this change's file list. Keep the two in step.
 */
function resolveLogDir(): string {
  if (process.env.OHMYAGENT_LOG_DIR) return process.env.OHMYAGENT_LOG_DIR;
  if (process.env.OHMYAGENT_HOME) return join(process.env.OHMYAGENT_HOME, 'logs');
  return join(homedir(), '.ohmyagent', 'logs');
}

/**
 * Last `lines` non-empty lines of `filePath`, or `undefined` when it does not
 * exist yet. Reads a bounded chunk from the end rather than the whole file
 * (§13.12); the first returned line may be the truncated tail of a longer one.
 */
function readLogTail(filePath: string, lines: number): string[] | undefined {
  let fd: number | undefined;
  try {
    const stats = statSync(filePath);
    if (!stats.isFile() || stats.size === 0) return undefined;

    const length = Math.min(stats.size, LOG_TAIL_MAX_BYTES);
    const buffer = Buffer.alloc(length);
    fd = openSync(filePath, 'r');
    readSync(fd, buffer, 0, length, stats.size - length);

    return buffer
      .toString('utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .slice(-lines);
  } catch {
    // A missing or unreadable log file is normal (the server never started).
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function parseLines(query: unknown): number {
  const raw = isRecord(query) ? query.lines : undefined;
  if (raw === undefined) return DEFAULT_LOG_LINES;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_LOG_LINES;
  return Math.min(parsed, MAX_LOG_LINES);
}

/**
 * Register the MCP API routes.
 *
 * @param app Fastify instance — must already carry `webuiAuthHook` (see the
 *   file header).
 * @param deps Config/database/manager access plus the dry-connect seam.
 */
export function registerMcpRoutes(app: FastifyInstance, deps: McpRouteDeps): void {
  const manager = (): McpManager | undefined => deps.getManager();
  const installed = (): McpServerConfig[] => Object.values(deps.getConfig().mcp?.servers ?? {});
  const findServer = (name: string): McpServerConfig | undefined =>
    deps.getConfig().mcp?.servers[name];

  /** `my-server` and `my_server` are the same server (§5.2). */
  const canonical = (name: string): string => name.replace(/-/g, '_');

  /** The conflicting stored name, if any — checked with the same normalisation as the loader. */
  const findNameConflict = (name: string): string | undefined =>
    installed()
      .map((server) => server.name)
      .find((other) => canonical(other) === canonical(name));

  const toServerView = (server: McpServerConfig): McpServerView => {
    const live = manager();
    const state = live?.getServerState(server.name);

    // `env` / `headers` values never travel through these endpoints — only key
    // names do (§13.7). Masking the record keeps the invariant local, so a field
    // that later carries values carries masked ones.
    const view: McpServerView = {
      name: server.name,
      enabled: server.enabled,
      transport: server.transport,
      exposure: server.exposure,
      description: server.description,
      state: resolveConnectionState(server, state?.state, live !== undefined),
      toolCount: live?.listTools(server.name).length ?? 0,
      oauth: hasMcpOAuthCredentials(deps.db, server.name),
      authRequired: state?.authRequired === true,
      toolExposure: { ...server.toolExposure },
      errorCount: state?.errorCount ?? 0,
    };
    if (state?.error) view.error = state.error;
    if (state?.connectedAt !== undefined) view.connectedAt = state.connectedAt;
    if (server.transport === 'stdio') {
      view.command = server.command;
      view.args = [...server.args];
      if (server.cwd) view.cwd = server.cwd;
      view.envKeys = Object.keys(maskRecord(server.env) ?? {});
    } else {
      view.url = server.url;
      view.headerKeys = Object.keys(maskRecord(server.headers) ?? {});
    }
    if (server.timeoutSec !== undefined) view.timeoutSec = server.timeoutSec;
    return view;
  };

  /**
   * Re-read the config after a write and let the manager act on it.
   *
   * The reload is deliberately not awaited: `reload()` awaits the (re)connect of
   * every changed server, and a cold `npx -y` pull routinely outlives the
   * WebUI's 10s request budget — a slow first download must not be reported as a
   * failed config change. The manager reports progress through its own state,
   * which the card polls, and `bootstrap.ts` already maps
   * `onToolsChanged` → `agentService.invalidateRuntimes()` (§13.9).
   */
  const afterConfigWrite = (): void => {
    if (deps.onConfigSaved) {
      try {
        deps.onConfigSaved(loadConfig());
      } catch (err) {
        app.log.warn({ err }, '[mcp] hot reload after a config write failed');
      }
    }
    const live = manager();
    if (!live) return;
    live.reload().catch((err: unknown) => {
      app.log.warn({ err }, '[mcp] reload after a config write failed');
    });
  };

  /** Serialised write of one `mcp.servers.<name>` entry (decision 19-11). */
  const writeServer = async (
    name: string,
    build: (stored: RawServerYaml | undefined) => RawServerYaml | undefined,
  ): Promise<void> => {
    await mutateConfigYaml((doc) => {
      const root = readConfigObject(doc);
      const mcpSection = isRecord(root.mcp) ? root.mcp : {};
      const servers = isRecord(mcpSection.servers) ? mcpSection.servers : {};
      const stored = isRecord(servers[name]) ? (servers[name] as RawServerYaml) : undefined;

      const next = build(stored);
      if (next === undefined) delete servers[name];
      else servers[name] = next;

      mcpSection.servers = servers;
      root.mcp = mcpSection;
      applyConfigObject(doc, root);
    });
  };

  // ── §13.7 endpoint table ──

  /** GET /api/mcp/status — the counts behind the page's status bar. */
  app.get('/api/mcp/status', async (_request, reply) => {
    const servers = installed();
    const live = manager();
    let connected = 0;
    let authRequired = 0;
    let errorCount = 0;

    for (const server of servers) {
      const state = live?.getServerState(server.name);
      if (state?.state === 'connected') connected += 1;
      if (state?.authRequired) authRequired += 1;
      if (state?.state === 'error') errorCount += 1;
    }

    return reply.send({
      installed: servers.length,
      enabled: servers.filter((server) => server.enabled).length,
      connected,
      authRequired,
      errorCount,
    });
  });

  /** GET /api/mcp/servers — installed servers merged with live state. */
  app.get('/api/mcp/servers', async (_request, reply) => {
    return reply.send(installed().map(toServerView));
  });

  /** GET /api/mcp/presets — the static catalogue of §13.3(a). */
  app.get('/api/mcp/presets', async (_request, reply) => {
    return reply.send(listMcpPresets());
  });

  /** POST /api/mcp/servers — install (§13.3 pipeline). */
  app.post('/api/mcp/servers', async (request, reply) => {
    const parsed = serverInputSchema.safeParse(request.body);
    if (!parsed.success) return badBody(reply, parsed.error);
    const input: McpServerInput = parsed.data;

    const conflict = findNameConflict(input.name);
    if (conflict) return fail(reply, 400, 'error.nameTaken', { name: conflict });

    const issue = endpointIssue(input);
    if (issue) return fail(reply, 400, issue);

    try {
      await writeServer(input.name, () => toRawServerYaml(input, undefined));
    } catch (err) {
      app.log.warn({ err, server: input.name }, '[mcp] install could not write config.yaml');
      return fail(reply, 500, 'error.configWriteFailed', { message: errText(err) });
    }

    afterConfigWrite();
    const server = findServer(input.name);
    if (!server) return fail(reply, 500, 'error.configWriteFailed', { message: 'entry missing' });
    return reply.send({ ok: true, server: toServerView(server) });
  });

  /** PUT /api/mcp/servers/:name — update (rename is not supported, §13.7). */
  app.put('/api/mcp/servers/:name', async (request, reply) => {
    const { name } = request.params as { name: string };
    const parsed = serverInputSchema.safeParse(request.body);
    if (!parsed.success) return badBody(reply, parsed.error);
    const input: McpServerInput = parsed.data;

    const server = findServer(name);
    if (!server) return fail(reply, 404, 'error.serverNotFound', { name });

    if (input.name !== name) {
      return fail(reply, 400, 'error.renameUnsupported', { name });
    }

    const issue = endpointIssue(input);
    if (issue) return fail(reply, 400, issue);

    try {
      await writeServer(name, (stored) => toRawServerYaml(input, stored));
    } catch (err) {
      app.log.warn({ err, server: name }, '[mcp] update could not write config.yaml');
      return fail(reply, 500, 'error.configWriteFailed', { message: errText(err) });
    }

    afterConfigWrite();
    const updated = findServer(name);
    if (!updated) return fail(reply, 500, 'error.configWriteFailed', { message: 'entry missing' });
    return reply.send({ ok: true, server: toServerView(updated) });
  });

  /** PATCH /api/mcp/servers/:name — enable/disable, exposure, description (§13.5). */
  app.patch('/api/mcp/servers/:name', async (request, reply) => {
    const { name } = request.params as { name: string };
    const parsed = patchInputSchema.safeParse(request.body);
    if (!parsed.success) return badBody(reply, parsed.error);
    const patch = parsed.data;

    const server = findServer(name);
    if (!server) return fail(reply, 404, 'error.serverNotFound', { name });

    try {
      // Existing fields (env, headers, args, oauth) must survive a patch, so the
      // raw entry is edited in place instead of being rebuilt from the input.
      await writeServer(name, (stored) => {
        if (!stored) return undefined;
        const next: RawServerYaml = { ...stored };
        if (patch.enabled !== undefined) next.enabled = patch.enabled;
        if (patch.exposure !== undefined) next.exposure = patch.exposure;
        if (patch.description !== undefined) next.description = patch.description;
        if (patch.tool_exposure !== undefined) next.tool_exposure = patch.tool_exposure;
        return next;
      });
    } catch (err) {
      app.log.warn({ err, server: name }, '[mcp] patch could not write config.yaml');
      return fail(reply, 500, 'error.configWriteFailed', { message: errText(err) });
    }

    afterConfigWrite();
    const updated = findServer(name);
    if (!updated) return fail(reply, 404, 'error.serverNotFound', { name });
    return reply.send({ ok: true, server: toServerView(updated) });
  });

  /** DELETE /api/mcp/servers/:name?purge_credentials=true|false — uninstall (§13.4). */
  app.delete('/api/mcp/servers/:name', async (request, reply) => {
    const { name } = request.params as { name: string };
    const rawPurge = (request.query as Record<string, unknown> | undefined)?.purge_credentials;
    const purge = purgeQuerySchema.safeParse(rawPurge ?? 'false');
    if (!purge.success) {
      return badBody(reply, purge.error);
    }

    const server = findServer(name);
    if (!server) return fail(reply, 404, 'error.serverNotFound', { name });

    // Count before the removal: the card's toast reports how many tools went away.
    const removedTools = manager()?.listTools(name).length ?? 0;

    try {
      await writeServer(name, () => undefined);
    } catch (err) {
      app.log.warn({ err, server: name }, '[mcp] uninstall could not write config.yaml');
      return fail(reply, 500, 'error.configWriteFailed', { message: errText(err) });
    }

    if (purge.data === 'true') {
      // Every credential row of this name: the URL may have changed since login.
      deleteMcpOAuthCredentials(deps.db, name);
    }

    afterConfigWrite();
    return reply.send({ ok: true, removedTools });
  });

  /** POST /api/mcp/servers/:name/reconnect — force a reconnect now (§9.2). */
  app.post('/api/mcp/servers/:name/reconnect', async (request, reply) => {
    const { name } = request.params as { name: string };
    if (!findServer(name)) return fail(reply, 404, 'error.serverNotFound', { name });
    const live = manager();
    if (!live) {
      return fail(reply, 503, 'error.managerUnavailable');
    }

    // `reconnect()` resolves with the resulting state, including failures; a
    // failed reconnect must reach the WebUI as an error, not as a silent 200.
    const state = await live.reconnect(name);
    if (state.state !== 'connected') {
      return fail(reply, 502, 'error.connectFailed', {
        message: state.error ?? state.state,
      });
    }
    return reply.send({ ok: true, state: state.state, tools: listToolsFor(name) });
  });

  /** POST /api/mcp/servers/:name/login — begin the OAuth flow (§10.1). */
  app.post('/api/mcp/servers/:name/login', async (request, reply) => {
    const { name } = request.params as { name: string };
    if (!findServer(name)) return fail(reply, 404, 'error.serverNotFound', { name });
    const live = manager();
    if (!live) {
      return fail(reply, 503, 'error.managerUnavailable');
    }

    try {
      const result = await live.login(name);
      return reply.send({
        ok: true,
        authorizationUrl: result.authorizationUrl,
        manual: result.manual,
      });
    } catch (err) {
      app.log.warn({ err, server: name }, '[mcp] login failed');
      return fail(reply, 502, 'error.loginFailed', { message: errText(err) });
    }
  });

  /** POST /api/mcp/servers/:name/login/callback — headless manual paste (§10.1). */
  app.post('/api/mcp/servers/:name/login/callback', async (request, reply) => {
    const { name } = request.params as { name: string };
    const parsed = loginCallbackSchema.safeParse(request.body);
    if (!parsed.success) return badBody(reply, parsed.error);
    if (!findServer(name)) return fail(reply, 404, 'error.serverNotFound', { name });
    const live = manager();
    if (!live) {
      return fail(reply, 503, 'error.managerUnavailable');
    }

    try {
      await live.submitCallback(name, parsed.data.callbackUrl);
      return reply.send({ ok: true });
    } catch (err) {
      app.log.warn({ err, server: name }, '[mcp] OAuth callback failed');
      return fail(reply, 502, 'error.loginFailed', { message: errText(err) });
    }
  });

  /** POST /api/mcp/servers/:name/logout — drop stored credentials (§10.3). */
  app.post('/api/mcp/servers/:name/logout', async (request, reply) => {
    const { name } = request.params as { name: string };
    if (!findServer(name)) return fail(reply, 404, 'error.serverNotFound', { name });
    const live = manager();
    if (!live) {
      return fail(reply, 503, 'error.managerUnavailable');
    }

    try {
      await live.logout(name);
      return reply.send({ ok: true });
    } catch (err) {
      app.log.warn({ err, server: name }, '[mcp] logout failed');
      return fail(reply, 502, 'error.actionFailed', { message: errText(err) });
    }
  });

  /** GET /api/mcp/servers/:name/tools — the manager's cached list (§13.7). */
  app.get('/api/mcp/servers/:name/tools', async (request, reply) => {
    const { name } = request.params as { name: string };
    if (!findServer(name)) return fail(reply, 404, 'error.serverNotFound', { name });
    return reply.send(listToolsFor(name));
  });

  /** GET /api/mcp/servers/:name/logs?lines=200 — tail of the server's log (§13.12). */
  app.get('/api/mcp/servers/:name/logs', async (request, reply) => {
    const { name } = request.params as { name: string };
    if (!findServer(name)) return fail(reply, 404, 'error.serverNotFound', { name });

    const lines = readLogTail(join(resolveLogDir(), `mcp-${name}.log`), parseLines(request.query));
    if (lines) return reply.send({ lines });

    // No log file yet (the manager keeps its stderr tail in memory until the
    // dedicated file sink lands) — show what is actually available rather than
    // an empty pane.
    const stderrTail = manager()?.getServerState(name)?.stderrTail;
    return reply.send({
      lines: stderrTail ? stderrTail.split('\n').filter((line) => line.trim().length > 0) : [],
    });
  });

  /** POST /api/mcp/test — dry connect, nothing is persisted (§13.3, decision 19-9). */
  app.post('/api/mcp/test', async (request, reply) => {
    const parsed = serverInputSchema.safeParse(request.body);
    if (!parsed.success) return badBody(reply, parsed.error);
    const input: McpServerInput = parsed.data;

    const issue = endpointIssue(input);
    if (issue) return fail(reply, 400, issue);

    const probe = deps.probe ?? ((server: McpServerConfig) => probeServer(server, app.log));
    try {
      return reply.send(await probe(toProbeConfig(input)));
    } catch (err) {
      app.log.warn({ err, server: input.name }, '[mcp] dry connect failed unexpectedly');
      return reply.send({
        ok: false,
        error: message('error.connectFailed', { message: errText(err) }),
      });
    }
  });

  /**
   * Tool view for one server, read from `manager.listTools()`.
   *
   * The manager cache — never the tool registry: `hidden` exposure tools are
   * never registered, so a registry read would make them invisible in the UI and
   * therefore impossible to switch back to visible (§13.7).
   *
   * The registered name is recomputed with `createMcpToolName()`; the only case
   * where that can differ from the live registration is a collision between two
   * MCP tools, which `rawName` (the field every action is keyed on) does not
   * depend on.
   */
  function listToolsFor(name: string): McpToolView[] {
    const server = findServer(name);
    if (!server) return [];
    const tools = manager()?.listTools(name) ?? [];
    return tools.map((tool) => ({
      name: createMcpToolName(name, tool.name),
      rawName: tool.name,
      title: tool.title,
      description: tool.description,
      exposure: resolveMcpExposure(server, tool.name),
      ...mcpAnnotationFlags(tool.annotations),
    }));
  }
}

/**
 * Connection state shown for one server.
 *
 * `enabled: false` wins outright (§13.1: a disabled server is not connected at
 * all), and a server the manager holds no runtime for is not connected either —
 * reporting `connecting` there would promise a connect that nothing is doing.
 * The one remap is an enabled server whose runtime is still marked `disabled`:
 * that is the window between a §13.5 toggle and the manager's reconcile, which
 * this module has just kicked off.
 */
function resolveConnectionState(
  server: McpServerConfig,
  state: McpConnectionState | undefined,
  managerPresent: boolean,
): McpConnectionState {
  if (!server.enabled) return 'disabled';
  if (!managerPresent || state === undefined) return 'disconnected';
  return state === 'disabled' ? 'connecting' : state;
}
