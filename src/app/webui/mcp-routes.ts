/**
 * MCP API routes — the 16 endpoints of MyDocs/MCP_INTEGRATION_DESIGN.md §13.7
 * (the 14 of the design plus `GET /api/mcp/servers/:name/resources` and
 * `GET /api/mcp/servers/:name/raw`; `PATCH /api/mcp/servers/:name` also gained
 * the `tool_enabled` field).
 *
 * See also §13.1 (the four orthogonal states), §13.4 (uninstall order),
 * §13.5 (enable/disable), §13.6 (the detail drawer's resources / raw-config
 * panes), §13.8 (persistence) and §13.11 (server strings).
 *
 * Deviation from §13.7 worth stating once, because the table is not explicit:
 * a duplicate server name is **400** with `mcp.error.nameTaken` — never 409.
 * "Already exists" is a request-level conflict here, not a resource state the
 * client could resolve, and the WebUI branches on the machine-readable code.
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
 *      (`config-routes.ts`) and agent CRUD (`config-persist.ts`). *Reads that
 *      have to keep `${ENV}` placeholders intact* come from the raw file
 *      (`readRawConfigFile()`), because `AppConfig.mcp` is already
 *      interpolated, camelCase and default-filled: serving that back to the
 *      edit form turns a placeholder into its expansion the moment the user
 *      saves (§13.7 security rules). *State* reads come from `AppConfig.mcp`.
 *
 *   2. Secrets never travel back. `env` / `headers` values are not part of
 *      `McpServerView` at all (only `envKeys` / `headerKeys`, §13.7); the raw
 *      config fragment (`GET /api/mcp/servers/:name/raw`) masks every
 *      `isSecretKey()` name except a *pure* `${VAR}` placeholder, which is not
 *      a secret and is preserved verbatim. A value the client echoes back that
 *      `isMaskedValue()` recognises is read as "leave the stored secret alone"
 *      — never written as the literal mask.
 *
 * Every response shape is taken from `src/mcp/types.ts`, the contract the
 * already-built WebUI (`ui/src/components/settings/mcp/`) consumes field by
 * field. Do not rename a field on one side only.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import type Database from 'better-sqlite3';
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isMap, stringify as stringifyYaml, type YAMLMap } from 'yaml';
import { z } from 'zod';

import { DEFAULT_MCP_SECTION, MCP_SERVER_NAME_PATTERN } from '../../mcp/config.js';
import { mcpAnnotationFlags } from '../../mcp/capability.js';
import {
  containsMaskedSecret,
  isMaskedValue,
  isSecretKey,
  maskRecord,
  MASKED_SECRET,
  maskUrl,
  maskUrlInText,
  resolveMaskedUrl,
} from '../../mcp/masking.js';
import {
  createMcpManager,
  mcpLogFilePath,
  type McpManagerLogger,
  type McpToolRegistryLike,
} from '../../mcp/mcp-manager.js';
import { deleteMcpOAuthCredentials, hasMcpOAuthCredentials } from '../../mcp/oauth-store.js';
import { listMcpPresets } from '../../mcp/presets.js';
import { createMcpToolName, resolveMcpExposure } from '../../mcp/tool-adapter.js';
import type {
  ListResourceTemplatesResult,
  ListResourcesResult,
  McpConnectionState,
  McpExposure,
  McpManager,
  McpOAuthConfig,
  McpResourceView,
  McpServerConfig,
  McpServerInfo,
  McpServerInput,
  McpSectionConfig,
  McpServerState,
  McpServerView,
  McpToolView,
} from '../../mcp/types.js';
import { approvalRiskForTool } from '../../policy/tool-capability-registry.js';
import { canonicalMcpServerName } from '../../policy/mcp-visibility.js';
import { OffloadStore } from '../../runtime-artifacts/offload-store.js';
import { i18n } from '../../i18n/index.js';
import { loadConfig } from '../config.js';
import { interpolateEnv } from '../config-loader.js';
import type { AppConfig } from '../types.js';
import { mutateConfigYaml, readRawConfigFile, readConfigObject } from './yaml-mutation.js';

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
 * `GET /api/mcp/servers/:name/resources` — the §13.6/§13.7 envelope.
 *
 * Not a bare array: "the server declares no resources" and "it is declared but
 * not connected right now" are normal states, not client errors, and the WebUI
 * has to tell them apart without guessing. Concrete resources and templates
 * share `resources`, with `template: true` on the template entries.
 */
export interface McpResourcesView {
  /** The server declared the `resources` capability in its `initialize` result. */
  supported: boolean;
  /** Its transport is up right now, i.e. a listing was actually possible. */
  connected: boolean;
  resources: McpResourceView[];
}

/**
 * `GET /api/mcp/servers/:name/raw` — the server's `config.yaml` block (§13.6).
 *
 * `yaml: null` means the name is configured but has nothing to show as a
 * fragment (its raw value is not a mapping) — reported as a state, not as a 404.
 */
export type McpRawConfigView = { yaml: string } | { yaml: null; reason: 'notPresentInRawConfig' };

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
    toolEnabled: z.record(z.string(), z.boolean()).optional(),
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
 * snake_case here (`tool_exposure`, `tool_enabled`) unlike `McpServerInput`'s
 * camelCase. The already-built WebUI sends exactly these (`McpSettings.tsx`), so
 * the spelling is part of the contract, not a style choice.
 *
 * `tool_enabled` merges per key and is keyed by the *raw* server tool name —
 * the same key as `tool_exposure` and `McpToolView.serverToolName`. `false`
 * switches a tool off, `true` switches it on, `null` drops the override (back
 * to the default: enabled).
 */
const patchInputSchema = z
  .object({
    enabled: z.boolean().optional(),
    exposure: exposureSchema.optional(),
    description: z.string().optional(),
    tool_exposure: z.record(z.string(), exposureSchema).optional(),
    tool_enabled: z.record(z.string(), z.boolean().nullable()).optional(),
  })
  .strict();

const loginCallbackSchema = z.object({ callbackUrl: z.string().min(1) }).strict();

const purgeQuerySchema = z.enum(['true', 'false']);

/** Raw per-server entry exactly as it is written to `config.yaml` (snake_case). */
type RawServerYaml = Record<string, unknown>;

/**
 * Authoritative canonical-duplicate failure, thrown from inside the write queue.
 *
 * `config.yaml` cannot boot with two `mcp.servers` entries of the same name
 * modulo `-`/`_`, so the check has to run in the serialised mutator — outside
 * it, two concurrent installs can both pass and both write, leaving a file the
 * next start refuses to load (§5.2). Callers map it to a 400
 * `mcp.error.nameTaken`.
 */
class McpNameConflictError extends Error {
  constructor(readonly conflictingName: string) {
    super(`canonical duplicate server name: ${conflictingName}`);
    this.name = 'McpNameConflictError';
  }
}

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

// ─── Raw `config.yaml` access (§13.6) ───
//
// The `:name` routes validate against the RAW `mcp.servers` map, not against
// `AppConfig.mcp`: the loader *skips* an entry it cannot normalise (unknown key,
// `command` together with `url`, bad exposure), and an invisible entry cannot be
// inspected, edited or deleted. Worse, an invisible entry does not block a new
// server differing only by `-`/`_`, which leaves a `config.yaml` the next boot
// refuses to load.

/**
 * Raw `mcp.servers` map of `config.yaml`, or `undefined` when the file cannot be
 * read. `{}` and `undefined` are deliberately different answers: "no servers
 * configured" versus "cannot tell".
 *
 * @throws Whatever `readRawConfigFile()` throws (a scrubbed parse error).
 */
export function readRawMcpServers(): Record<string, unknown> | undefined {
  const root = readRawConfigFile();
  const mcp = root.mcp;
  if (!isRecord(mcp)) return {};
  return isRecord(mcp.servers) ? mcp.servers : {};
}

/** A pure `${VAR}` / `${VAR:-default}` placeholder — a reference, never a secret. */
const ENV_PLACEHOLDER = /^\$\{[^{}]*\}$/;

/** Mask one scalar by its key name, leaving pure `${ENV}` placeholders intact. */
function maskRawValue(key: string, value: unknown): unknown {
  if (isRecord(value)) {
    const nested: Record<string, unknown> = {};
    for (const [nestedKey, nestedValue] of Object.entries(value)) {
      nested[nestedKey] = maskRawValue(nestedKey, nestedValue);
    }
    return nested;
  }
  if (typeof value === 'string' && !ENV_PLACEHOLDER.test(value)) {
    // A URL can carry credentials the key-based rule never sees (userinfo or a
    // secret query parameter), and the raw fragment is served as-is — so every
    // `url:` value goes through maskUrl() like the loaded views do. A pure
    // `${VAR}` placeholder was already left verbatim above: a reference, not a
    // secret.
    if (key === 'url') return maskUrl(value);
    return isSecretKey(key) ? MASKED_SECRET : value;
  }
  return value;
}

/**
 * Mask the secret values of one raw `config.yaml` server entry (§13.6).
 *
 * The fragment is the caller's own file, so a value that is a *pure* `${VAR}`
 * placeholder is emitted verbatim even under a secret-named key: it is a
 * reference, not a secret, and echoing it back is exactly what keeps a save from
 * baking an expanded value into `config.yaml`. Every other `isSecretKey()` name
 * is replaced by the mask, and each `url:` value has its embedded credentials
 * masked (see `maskUrl()`). Values are never interpolated — the input is the raw
 * file, so no effective value can leak through this path.
 *
 * The echoed fragment is what the edit form submits back on save, so the write
 * side recognises a masked URL and resolves it to the stored one
 * (`resolveMaskedUrl()`); writing the literal mask would brick the entry.
 *
 * @param entry Raw `mcp.servers.<name>` entry.
 */
export function maskRawServerEntry(entry: Record<string, unknown>): Record<string, unknown> {
  const masked: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) masked[key] = maskRawValue(key, value);
  return masked;
}

/**
 * Serialise one masked server entry as the `config.yaml` fragment it came from:
 * the name at column 0 with its body indented two spaces, exactly as the file
 * holds it.
 *
 * @param name Server name (the YAML key of `mcp.servers`).
 * @param entry Masked raw entry.
 */
export function serialiseServerFragment(name: string, entry: Record<string, unknown>): string {
  return stringifyYaml({ [name]: entry }, { indent: 2, lineWidth: 120 });
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
  if (input.toolEnabled && Object.keys(input.toolEnabled).length > 0) {
    raw.tool_enabled = input.toolEnabled;
  }
  if (input.timeoutSec !== undefined) raw.timeout_sec = input.timeoutSec;

  if (isStdio(input)) {
    raw.command = input.command;
    if (input.args && input.args.length > 0) raw.args = input.args;
    const env = mergeSecretRecord(input.env, stringRecord(stored?.env));
    if (env) raw.env = env;
    if (input.cwd) raw.cwd = input.cwd;
  } else {
    // An echoed masked URL stands for the stored URL verbatim (any `${VAR}`
    // placeholder inside it is preserved) — writing the literal mask would
    // brick the entry. A mask with nothing behind it has already been rejected
    // by the route handler, so it never reaches this mapping.
    const storedUrl = stored?.url;
    const url =
      input.url === undefined
        ? undefined
        : resolveMaskedUrl(input.url, typeof storedUrl === 'string' ? storedUrl : undefined);
    if (url !== undefined) raw.url = url;
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

/**
 * Normalised config for the dry connect — the same translation the loader does.
 *
 * That includes `${ENV}` interpolation: the edit form hands back the raw values
 * it loaded (§13.6), so a placeholder such as `Authorization: ${API_TOKEN}`
 * must be resolved here exactly as the running gateway would resolve it —
 * otherwise the probe sends the literal `${API_TOKEN}` and reports a working
 * config as broken.
 */
function toProbeConfig(input: McpServerInput): McpServerConfig {
  const base = {
    name: input.name,
    enabled: true,
    exposure: input.exposure ?? ('deferred' as McpExposure),
    toolExposure: input.toolExposure ?? {},
    toolEnabled: input.toolEnabled ?? {},
    description: input.description ?? '',
    ...(input.timeoutSec !== undefined ? { timeoutSec: input.timeoutSec } : {}),
  };
  const config: McpServerConfig = isStdio(input)
    ? {
        ...base,
        transport: 'stdio',
        command: input.command,
        args: input.args ?? [],
        env: input.env ?? {},
        cwd: input.cwd ?? '',
      }
    : { ...base, transport: 'http', url: input.url ?? '', headers: input.headers ?? {} };
  return interpolateEnv(config) as McpServerConfig;
}

/**
 * Replace the mask with the value it stands for before probing (§13.3).
 *
 * The edit form submits what it loaded, so an untouched secret-named field
 * arrives as `••••••`; probing with that literal fails and tells the user a
 * working config is broken. Masked values are therefore resolved against the
 * entry stored in `config.yaml` — the same rule the write path applies — and a
 * mask with nothing behind it is dropped rather than probed as a literal.
 *
 * An echoed masked `url` resolves the same way when the raw entry stores one.
 *
 * Only `env` / `headers` are resolved: the throwaway probe manager is built
 * without OAuth dependencies, so an inline `oauth:` block is inert there (it
 * never reaches `authProviderFor()`), and the tokens the real gateway uses live
 * in the OAuth store, not in the request body.
 */
function resolveMaskedInput(
  input: McpServerInput,
  stored: RawServerYaml | undefined,
): McpServerInput {
  const resolved: McpServerInput = { ...input };
  if (isStdio(input)) {
    const env = mergeSecretRecord(input.env, stringRecord(stored?.env));
    if (env) resolved.env = env;
  } else {
    const headers = mergeSecretRecord(input.headers, stringRecord(stored?.headers));
    if (headers) resolved.headers = headers;
    // The stored URL is likewise echoed masked (`maskUrl()` on the way out);
    // probing the literal mask would fail a working config, so it resolves
    // exactly like the masked secret fields above.
    const storedUrl = stored?.url;
    if (
      input.url !== undefined &&
      typeof storedUrl === 'string' &&
      containsMaskedSecret(input.url)
    ) {
      resolved.url = storedUrl;
    }
  }
  return resolved;
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
 *
 * `tunables` inherits the running gateway's connection tunables (currently
 * `connectTimeoutSec`): a probe of a slow-starting server (a cold `npx` pull,
 * a large self-contained binary) must honour the operator's configured
 * connect timeout instead of silently falling back to the default 15 s —
 * otherwise raising `mcp.connect_timeout_sec` has no effect on "Test
 * Connection" and the probe fails precisely when it is needed.
 */
async function probeServer(
  server: McpServerConfig,
  logger: McpManagerLogger,
  tunables?: Pick<McpSectionConfig, 'connectTimeoutSec'>,
): Promise<McpProbeResult> {
  const manager = createMcpManager({
    config: {
      ...DEFAULT_MCP_SECTION,
      ...(tunables ? { connectTimeoutSec: tunables.connectTimeoutSec } : {}),
      servers: { [server.name]: server },
    },
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
        error: maskUrlInText(
          state?.error ?? message('error.connectFailed', { message: state?.state ?? 'unknown' }),
        ),
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

  /**
   * Raw `mcp.servers` entries, or `undefined` when config.yaml cannot be parsed.
   *
   * A broken file already fails every write, so degrading the checks to the
   * loaded config is better than turning every read into a 500 — but the reason
   * is logged, never swallowed.
   */
  const rawServers = (): Record<string, unknown> | undefined => {
    try {
      return readRawMcpServers();
    } catch (err) {
      app.log.warn({ err }, '[mcp] config.yaml is unreadable; using the loaded server list');
      return undefined;
    }
  };

  /**
   * True when `name` is configured — including an entry the loader *skipped*.
   *
   * `hasOwnProperty` rather than truthiness: plain property access lets
   * `__proto__` and `toString` resolve through the prototype chain, which made
   * DELETE/PATCH answer 200 for a server that does not exist.
   */
  const serverExists = (name: string): boolean => {
    const raw = rawServers();
    if (raw) return Object.prototype.hasOwnProperty.call(raw, name);
    return Object.prototype.hasOwnProperty.call(deps.getConfig().mcp?.servers ?? {}, name);
  };

  /** The raw entry of one server, or `undefined` when it has none. */
  const rawEntry = (name: string): RawServerYaml | undefined => {
    const raw = rawServers();
    if (!raw || !Object.prototype.hasOwnProperty.call(raw, name)) return undefined;
    const entry = raw[name];
    return isRecord(entry) ? entry : undefined;
  };

  /** Loaded (interpolated, normalised) config of one server, if it loads at all. */
  const findServer = (name: string): McpServerConfig | undefined => {
    const servers = deps.getConfig().mcp?.servers;
    if (!servers || !Object.prototype.hasOwnProperty.call(servers, name)) return undefined;
    return servers[name];
  };

  /**
   * The conflicting stored name, if any — checked with the same normalisation
   * as the loader (`canonicalMcpServerName`, shared with the loader itself).
   *
   * This is only a fast path; the authoritative check runs inside the write
   * queue's mutator (`writeServer`), where two concurrent installs construct.
   *
   * Read from the raw map so a *skipped* entry still blocks a duplicate:
   * installing `my_server` next to an unloadable `my-server` would leave a
   * `config.yaml` the next boot refuses to load (the canonical duplicate check
   * throws there).
   */
  const findNameConflict = (name: string): string | undefined => {
    const raw = rawServers();
    const names = raw ? Object.keys(raw) : Object.keys(deps.getConfig().mcp?.servers ?? {});
    return names.find((other) => canonicalMcpServerName(other) === canonicalMcpServerName(name));
  };

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
      hasCredentials: hasMcpOAuthCredentials(deps.db, server.name),
      authRequired: state?.authRequired === true,
      // Every server in this list comes from config.yaml (decision D2).
      installed: true,
      source: 'config.yaml',
      toolExposure: { ...server.toolExposure },
      errorCount: state?.errorCount ?? 0,
    };
    if (state?.error) view.error = maskUrlInText(state.error);
    if (state?.connectedAt !== undefined) view.connectedAt = state.connectedAt;
    const serverInfo = toServerInfo(state);
    if (serverInfo) view.serverInfo = serverInfo;
    if (state?.instructionsSummary) view.instructionsSummary = state.instructionsSummary;
    if (state?.lastError)
      view.lastError = { ...state.lastError, message: maskUrlInText(state.lastError.message) };
    if (server.transport === 'stdio') {
      view.command = server.command;
      view.args = [...server.args];
      if (server.cwd) view.cwd = server.cwd;
      view.envKeys = Object.keys(maskRecord(server.env) ?? {});
    } else {
      // The URL can carry credentials the header list never shows (userinfo or
      // a secret query parameter) — the view is display-only, so it is masked
      // exactly like the raw fragment and `GET /api/config`.
      view.url = maskUrl(server.url);
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

  /**
   * Serialised write of one `mcp.servers.<name>` entry (decision 19-11).
   *
   * The edit is made with Document node operations so only the target key is
   * replaced: rebuilding the whole `mcp:` subtree used to destroy every sibling
   * entry's comments and quoting (values survived, comments did not). Missing
   * `mcp:` / `servers:` parents are created as fresh nodes.
   *
   * @param name Server name (the YAML key of `mcp.servers`).
   * @param build Produces the next raw entry, or `undefined` to remove it.
   * @param creating True for an install (`POST`): the canonical-duplicate check
   *   then rejects any stored name that matches modulo `-`/`_`, including the
   *   exact name itself. Updates are exempt — they can only "conflict" with
   *   their own key.
   * @throws `McpNameConflictError` when `creating` and a duplicate exists — the
   *   authoritative check, run inside the write queue so two concurrent
   *   installs cannot both pass the outside fast path and both write a
   *   `config.yaml` the loader refuses to boot. Callers map it to a 400
   *   `error.nameTaken`.
   */
  const writeServer = async (
    name: string,
    build: (stored: RawServerYaml | undefined) => RawServerYaml | undefined,
    creating = false,
  ): Promise<void> => {
    await mutateConfigYaml((doc) => {
      const root = readConfigObject(doc);
      const mcpSection = isRecord(root.mcp) ? root.mcp : {};
      const servers = isRecord(mcpSection.servers) ? mcpSection.servers : {};

      if (creating) {
        for (const other of Object.keys(servers)) {
          if (canonicalMcpServerName(other) === canonicalMcpServerName(name)) {
            throw new McpNameConflictError(other);
          }
        }
      }

      // Own keys only: `servers['toString']` would otherwise resolve through the
      // prototype chain and let a mutation read someone else's entry.
      const stored =
        Object.prototype.hasOwnProperty.call(servers, name) && isRecord(servers[name])
          ? (servers[name] as RawServerYaml)
          : undefined;

      const next = build(stored);

      // ── Node-level edit: replace only the target key ──
      // Values are converted through `doc.createNode()` before they are stored:
      // `YAMLMap.set()` wraps a plain object in a Pair verbatim, so the freshly
      // created parents would come back as plain objects with no node methods.
      // The `yaml` typings type `get(key, true)` as `Scalar` even when the value
      // is a collection node, so the node values are narrowed through
      // `isMap()` instead of direct casts.
      const rootNode = doc.contents as YAMLMap;
      if (!rootNode.has('mcp')) rootNode.set('mcp', doc.createNode({ servers: {} }));
      let mcpNode: unknown = rootNode.get('mcp', true);
      if (!isMap(mcpNode)) {
        // `mcp:` is not a mapping — replacing it is the only way forward (and
        // matches what the previous whole-section rebuild did).
        rootNode.set('mcp', doc.createNode({ servers: {} }));
        mcpNode = rootNode.get('mcp', true);
      }
      if (!isMap(mcpNode)) throw new Error('Cannot update MCP servers: mcp is not a YAML mapping');
      if (!mcpNode.has('servers')) mcpNode.set('servers', doc.createNode({}));
      let serversNode: unknown = mcpNode.get('servers', true);
      if (!isMap(serversNode)) {
        mcpNode.set('servers', doc.createNode({}));
        serversNode = mcpNode.get('servers', true);
      }
      if (!isMap(serversNode))
        throw new Error('Cannot update MCP servers: mcp.servers is not a YAML mapping');
      if (next === undefined) serversNode.delete(name);
      // The fresh node touches only this key; sibling entries keep their
      // original nodes — comments and quoting alike.
      else serversNode.set(name, doc.createNode(next));
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

    // A masked URL echoed with no stored value behind it has nothing to resolve
    // to — a 400 beats writing the literal mask into `config.yaml`. The
    // authoritative resolution against the stored value happens inside the
    // write queue (§13.7).
    const maskedUrlIssue =
      input.url !== undefined &&
      containsMaskedSecret(input.url) &&
      typeof rawEntry(input.name)?.url !== 'string';
    if (maskedUrlIssue) {
      return fail(reply, 400, 'error.invalidBody', {
        detail: 'url: masked URL has no stored value to resolve to',
      });
    }

    const conflict = findNameConflict(input.name);
    if (conflict) return fail(reply, 400, 'error.nameTaken', { name: conflict });

    const issue = endpointIssue(input);
    if (issue) return fail(reply, 400, issue);

    try {
      await writeServer(input.name, () => toRawServerYaml(input, undefined), true);
    } catch (err) {
      if (err instanceof McpNameConflictError) {
        return fail(reply, 400, 'error.nameTaken', { name: err.conflictingName });
      }
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

    // Existence is a raw-config question: an entry the loader skipped must still
    // be updatable, otherwise it can never be fixed from the WebUI.
    if (!serverExists(name)) return fail(reply, 404, 'error.serverNotFound', { name });

    if (input.name !== name) {
      return fail(reply, 400, 'error.renameUnsupported', { name });
    }

    // Same guard as the install route: an echoed masked URL with nothing
    // stored behind it is rejected rather than written as the literal mask.
    const maskedUrlIssue =
      input.url !== undefined &&
      containsMaskedSecret(input.url) &&
      typeof rawEntry(name)?.url !== 'string';
    if (maskedUrlIssue) {
      return fail(reply, 400, 'error.invalidBody', {
        detail: 'url: masked URL has no stored value to resolve to',
      });
    }

    const issue = endpointIssue(input);
    if (issue) return fail(reply, 400, issue);

    try {
      await writeServer(name, (stored) => toRawServerYaml(input, stored));
    } catch (err) {
      if (err instanceof McpNameConflictError) {
        return fail(reply, 400, 'error.nameTaken', { name: err.conflictingName });
      }
      app.log.warn({ err, server: name }, '[mcp] update could not write config.yaml');
      return fail(reply, 500, 'error.configWriteFailed', { message: errText(err) });
    }

    afterConfigWrite();
    return reply.send(renderWriteResult(name));
  });

  /** PATCH /api/mcp/servers/:name — enable/disable, exposure, description (§13.5). */
  app.patch('/api/mcp/servers/:name', async (request, reply) => {
    const { name } = request.params as { name: string };
    const parsed = patchInputSchema.safeParse(request.body);
    if (!parsed.success) return badBody(reply, parsed.error);
    const patch = parsed.data;

    if (!serverExists(name)) return fail(reply, 404, 'error.serverNotFound', { name });

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
        if (patch.tool_enabled !== undefined) applyToolEnabledPatch(next, patch.tool_enabled);
        return next;
      });
    } catch (err) {
      app.log.warn({ err, server: name }, '[mcp] patch could not write config.yaml');
      return fail(reply, 500, 'error.configWriteFailed', { message: errText(err) });
    }

    afterConfigWrite();
    return reply.send(renderWriteResult(name));
  });

  /** DELETE /api/mcp/servers/:name?purge_credentials=true|false — uninstall (§13.4). */
  app.delete('/api/mcp/servers/:name', async (request, reply) => {
    const { name } = request.params as { name: string };
    const rawPurge = (request.query as Record<string, unknown> | undefined)?.purge_credentials;
    const purge = purgeQuerySchema.safeParse(rawPurge ?? 'false');
    if (!purge.success) {
      return badBody(reply, purge.error);
    }

    if (!serverExists(name)) return fail(reply, 404, 'error.serverNotFound', { name });

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
    if (!serverExists(name)) return fail(reply, 404, 'error.serverNotFound', { name });
    const live = manager();
    if (!live) {
      return fail(reply, 503, 'error.managerUnavailable');
    }

    // `reconnect()` resolves with the resulting state, including failures; a
    // failed reconnect must reach the WebUI as an error, not as a silent 200.
    const state = await live.reconnect(name);
    if (state.state !== 'connected') {
      // Transport errors can embed the failed URL — credentials and all — so
      // every error string is masked before it reaches a response body.
      return fail(reply, 502, 'error.connectFailed', {
        message: maskUrlInText(state.error ?? state.state),
      });
    }
    return reply.send({ ok: true, state: state.state, tools: listToolsFor(name) });
  });

  /** POST /api/mcp/servers/:name/login — begin the OAuth flow (§10.1). */
  app.post('/api/mcp/servers/:name/login', async (request, reply) => {
    const { name } = request.params as { name: string };
    if (!serverExists(name)) return fail(reply, 404, 'error.serverNotFound', { name });
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
      return fail(reply, 502, 'error.loginFailed', { message: maskUrlInText(errText(err)) });
    }
  });

  /** POST /api/mcp/servers/:name/login/callback — headless manual paste (§10.1). */
  app.post('/api/mcp/servers/:name/login/callback', async (request, reply) => {
    const { name } = request.params as { name: string };
    const parsed = loginCallbackSchema.safeParse(request.body);
    if (!parsed.success) return badBody(reply, parsed.error);
    if (!serverExists(name)) return fail(reply, 404, 'error.serverNotFound', { name });
    const live = manager();
    if (!live) {
      return fail(reply, 503, 'error.managerUnavailable');
    }

    try {
      await live.submitCallback(name, parsed.data.callbackUrl);
      return reply.send({ ok: true });
    } catch (err) {
      app.log.warn({ err, server: name }, '[mcp] OAuth callback failed');
      return fail(reply, 502, 'error.loginFailed', { message: maskUrlInText(errText(err)) });
    }
  });

  /** POST /api/mcp/servers/:name/logout — drop stored credentials (§10.3). */
  app.post('/api/mcp/servers/:name/logout', async (request, reply) => {
    const { name } = request.params as { name: string };
    if (!serverExists(name)) return fail(reply, 404, 'error.serverNotFound', { name });
    const live = manager();
    if (!live) {
      return fail(reply, 503, 'error.managerUnavailable');
    }

    try {
      await live.logout(name);
      return reply.send({ ok: true });
    } catch (err) {
      app.log.warn({ err, server: name }, '[mcp] logout failed');
      return fail(reply, 502, 'error.actionFailed', { message: maskUrlInText(errText(err)) });
    }
  });

  /** GET /api/mcp/servers/:name/tools — the manager's cached list (§13.7). */
  app.get('/api/mcp/servers/:name/tools', async (request, reply) => {
    const { name } = request.params as { name: string };
    if (!serverExists(name)) return fail(reply, 404, 'error.serverNotFound', { name });
    return reply.send(listToolsFor(name));
  });

  /**
   * GET /api/mcp/servers/:name/resources — resources and templates (§13.6).
   *
   * "Declares no resources" and "declared but not connected" are normal states,
   * reported as such with an empty list rather than as an error: the drawer has
   * to render a reason, and a 404/500 would leave it guessing. Only a failed
   * list against a *connected* server is an error (502).
   */
  app.get('/api/mcp/servers/:name/resources', async (request, reply) => {
    const { name } = request.params as { name: string };
    if (!serverExists(name)) return fail(reply, 404, 'error.serverNotFound', { name });

    const state = manager()?.getServerState(name);
    const connected = state?.state === 'connected';
    if (state?.supportsResources !== true) {
      return reply.send({ supported: false, connected, resources: [] } satisfies McpResourcesView);
    }
    const access = manager()?.resources;
    if (!connected || !access) {
      // No resource surface wired, or nothing is up to answer: the capability is
      // real but there is nothing to list yet.
      return reply.send({
        supported: true,
        connected: false,
        resources: [],
      } satisfies McpResourcesView);
    }

    try {
      // One page each: the WebUI lists what the server offers now, and a cursor
      // is a tool-level concern (`mcp__resources__list`).
      const [list, templates] = await Promise.all([
        access.listResources(name),
        access.listResourceTemplates(name),
      ]);
      const resources = [
        ...list.resources.map((resource) => toResourceView(name, resource)),
        ...templates.resourceTemplates.map((template) => toResourceTemplateView(name, template)),
      ];
      return reply.send({ supported: true, connected: true, resources } satisfies McpResourcesView);
    } catch (err) {
      app.log.warn({ err, server: name }, '[mcp] resource listing failed');
      return fail(reply, 502, 'error.resourceListFailed', {
        message: maskUrlInText(errText(err)),
      });
    }
  });

  /**
   * GET /api/mcp/servers/:name/raw — the server's `config.yaml` block (§13.6).
   *
   * A fragment of the *file*, not a JSON view of the loaded config: that is what
   * §13.6 promises the drawer, and a JSON object would force the WebUI to
   * re-implement YAML formatting while rendering camelCase defaults that are not
   * in the file. `GET /api/config` serves the same raw-masked entries to the edit
   * form, so both consumers share one source.
   */
  app.get('/api/mcp/servers/:name/raw', async (request, reply) => {
    const { name } = request.params as { name: string };
    if (!serverExists(name)) return fail(reply, 404, 'error.serverNotFound', { name });

    const entry = rawEntry(name);
    if (!entry) {
      // The name is configured but has no raw counterpart (empty value, or a
      // config.yaml that cannot be read right now).
      return reply.send({ yaml: null, reason: 'notPresentInRawConfig' } satisfies McpRawConfigView);
    }
    return reply.send({
      yaml: serialiseServerFragment(name, maskRawServerEntry(entry)),
    } satisfies McpRawConfigView);
  });

  /** GET /api/mcp/servers/:name/logs?lines=200 — tail of the server's log (§13.12). */
  app.get('/api/mcp/servers/:name/logs', async (request, reply) => {
    const { name } = request.params as { name: string };
    if (!serverExists(name)) return fail(reply, 404, 'error.serverNotFound', { name });

    const lines = parseLines(request.query);
    const fileTail = readLogTail(mcpLogFilePath(name), lines);
    if (fileTail) return reply.send({ lines: fileTail });

    // No log file yet (the server has not produced any output) — show what is
    // actually available rather than an empty pane. `?lines` applies here too,
    // exactly as it does on the file path above.
    const stderrTail = manager()?.getServerState(name)?.stderrTail;
    return reply.send({
      lines: stderrTail
        ? stderrTail
            .split('\n')
            .filter((line) => line.trim().length > 0)
            .slice(-lines)
        : [],
    });
  });

  /** POST /api/mcp/test — dry connect, nothing is persisted (§13.3, decision 19-9). */
  app.post('/api/mcp/test', async (request, reply) => {
    const parsed = serverInputSchema.safeParse(request.body);
    if (!parsed.success) return badBody(reply, parsed.error);
    const input: McpServerInput = parsed.data;

    const issue = endpointIssue(input);
    if (issue) return fail(reply, 400, issue);

    // The edit form submits the values it loaded, so an untouched secret arrives
    // as the mask; probing with that literal would fail a working config (§13.3).
    const probeInput = resolveMaskedInput(input, rawEntry(input.name));
    const probe =
      deps.probe ??
      ((server: McpServerConfig) =>
        probeServer(server, app.log, {
          connectTimeoutSec:
            deps.getConfig().mcp?.connectTimeoutSec ?? DEFAULT_MCP_SECTION.connectTimeoutSec,
        }));
    try {
      return reply.send(await probe(toProbeConfig(probeInput)));
    } catch (err) {
      app.log.warn({ err, server: input.name }, '[mcp] dry connect failed unexpectedly');
      return reply.send({
        ok: false,
        error: message('error.connectFailed', { message: maskUrlInText(errText(err)) }),
      });
    }
  });

  /**
   * Body of a successful write on one server.
   *
   * The entry is written either way, but it only renders as a view when the
   * loader accepts it: a name that exists only in the raw map (an entry the
   * loader skips) is still a successful write. Reporting `entry missing` there
   * would be a lie, and reporting a fabricated view would be worse.
   */
  function renderWriteResult(name: string): { ok: true; server?: McpServerView } {
    const updated = findServer(name);
    if (updated) return { ok: true, server: toServerView(updated) };
    app.log.warn(
      { server: name },
      '[mcp] entry written but not loadable; the config loader skips it',
    );
    return { ok: true };
  }

  /**
   * Tool view for one server, read from `manager.listTools()`.
   *
   * The manager cache — never the tool registry: `hidden` exposure tools are
   * never registered, so a registry read would make them invisible in the UI and
   * therefore impossible to switch back to visible (§13.7).
   *
   * The registered name is recomputed with `createMcpToolName()`; the only case
   * where that can differ from the live registration is a collision between two
   * MCP tools, which `serverToolName` (the field every action is keyed on) does
   * not depend on.
   */
  function listToolsFor(name: string): McpToolView[] {
    const server = findServer(name);
    if (!server) return [];
    const tools = manager()?.listTools(name) ?? [];
    return tools.map((tool) => {
      const registeredName = createMcpToolName(name, tool.name);
      return {
        name: registeredName,
        serverToolName: tool.name,
        title: tool.title,
        description: tool.description,
        exposure: resolveMcpExposure(server, tool.name),
        // Absent means enabled: only an explicit `false` switches a tool off
        // (§13.6). A switched-off tool stays listed — the UI has to be able to
        // switch it back on — but the manager never registers it.
        enabled: server.toolEnabled?.[tool.name] !== false,
        // Derived from the capability registered for the *registered* name: the
        // manager keys its annotation-derived descriptor by exactly this name
        // (`capabilityFromAnnotations`, §8.2). A tool that is not registered
        // (server down) falls back to the fail-closed `medium`.
        approvalRisk: approvalRiskForTool(registeredName, undefined),
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
        ...mcpAnnotationFlags(tool.annotations),
      };
    });
  }
}

/**
 * `initialize` identity for the §13.7 `serverInfo` field, or `undefined` when
 * nothing was reported (never a partially-filled object the UI would render as
 * empty strings).
 */
function toServerInfo(state: McpServerState | undefined): McpServerInfo | undefined {
  if (!state) return undefined;
  const info: McpServerInfo = {};
  if (state.protocolVersion) info.protocolVersion = state.protocolVersion;
  if (state.serverName) info.name = state.serverName;
  if (state.serverVersion) info.version = state.serverVersion;
  return Object.keys(info).length > 0 ? info : undefined;
}

/** One concrete resource as a §13.7 view. */
function toResourceView(
  server: string,
  resource: ListResourcesResult['resources'][number],
): McpResourceView {
  const view: McpResourceView = { server, template: false, uri: resource.uri };
  if (resource.name) view.name = resource.name;
  if (resource.title) view.title = resource.title;
  if (resource.description) view.description = resource.description;
  if (resource.mimeType) view.mimeType = resource.mimeType;
  return view;
}

/** One URI template as a §13.7 view — `uriTemplate` instead of `uri`, `template: true`. */
function toResourceTemplateView(
  server: string,
  template: ListResourceTemplatesResult['resourceTemplates'][number],
): McpResourceView {
  const view: McpResourceView = { server, template: true, uriTemplate: template.uriTemplate };
  if (template.name) view.name = template.name;
  if (template.title) view.title = template.title;
  if (template.description) view.description = template.description;
  if (template.mimeType) view.mimeType = template.mimeType;
  return view;
}

/**
 * Merge a `tool_enabled` patch into a raw server entry.
 *
 * Per key, never a replacement: the WebUI toggles one tool at a time and a full
 * replacement would drop the other overrides. `null` drops the key, i.e. back to
 * the default (enabled); an empty map leaves the entry's map alone, so sending
 * no key at all and sending `{}` mean the same thing.
 *
 * @param entry Raw `mcp.servers.<name>` entry, mutated in place.
 * @param patch Validated `tool_enabled` map; keys are raw server tool names.
 */
function applyToolEnabledPatch(entry: RawServerYaml, patch: Record<string, boolean | null>): void {
  const current: Record<string, boolean> = {};
  const stored = entry.tool_enabled;
  if (isRecord(stored)) {
    for (const [tool, value] of Object.entries(stored)) {
      if (typeof value === 'boolean') current[tool] = value;
    }
  }
  for (const [tool, value] of Object.entries(patch)) {
    if (value === null) delete current[tool];
    else current[tool] = value;
  }
  if (Object.keys(current).length > 0) entry.tool_enabled = current;
  else delete entry.tool_enabled;
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
