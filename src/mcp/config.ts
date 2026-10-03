// ---------------------------------------------------------------------------
// MCP integration — `mcp:` config section normalisation
// ---------------------------------------------------------------------------
//
// See MyDocs/MCP_INTEGRATION_DESIGN.md §5.1 (YAML shape) and §5.2 (validation).
//
// `config.yaml` is the single source of truth for MCP servers. Normalisation
// lives here instead of in the top-level zod schema because the two failure
// classes are handled differently:
//
//   SECTION-level — fail fast at startup. Reported through `onScalarError`,
//     which `config-loader.ts` folds into its aggregate `Invalid config.yaml`
//     error (the same treatment every other key gets), or thrown directly as a
//     `ConfigError` for duplicate names. There is no unambiguous winner to pick.
//
//   SERVER-level — report through `onServerError` and skip that server.
//     Startup continues: one unusable server must not stop the gateway from
//     booting, mirroring `McpManager.ready()`, which never rejects.
//
// `${ENV}` interpolation has already run in `loadYamlFile()`, so this module
// only ever sees interpolated strings. There is no `!command` syntax.

import { z } from 'zod';
import { ConfigError } from '../shared/errors.js';
import type { McpExposure, McpOAuthConfig, McpSectionConfig, McpServerConfig } from './types.js';
import type { McpVisibilityConfig } from '../policy/mcp-visibility.js';

/** Exposure keywords accepted in `config.yaml`, including the upstream alias. */
export const MCP_EXPOSURE_VALUES = ['direct', 'deferred', 'codemode', 'hidden'] as const;

/** Exposure keyword as written by the user, before `codemode` is aliased away. */
export type McpRawExposure = (typeof MCP_EXPOSURE_VALUES)[number];

/** Server names double as the tool-name segment `mcp__<server>__<tool>` (§6.1). */
export const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Defaults for a `mcp:` section that exists but omits keys, and the template
 * every normalised section starts from. An *absent* `mcp:` section leaves
 * `AppConfig.mcp` undefined instead, so nothing here runs.
 *
 * Treat as read-only — `normaliseMcpSection()` always builds a fresh object.
 */
export const DEFAULT_MCP_SECTION: McpSectionConfig = {
  enabled: true,
  connectTimeoutSec: 15,
  requestTimeoutSec: 60,
  maxOutputBytes: 20480,
  maxConcurrentConnects: 4,
  injectSystemPrompt: true,
  allowServers: [],
  denyServers: [],
  servers: {},
};

/**
 * Fatal-scalar reporter, mirroring `config-loader.ts`'s internal
 * `recordIssue(key, expected, value)` contract: the loader aggregates every
 * report into one startup error naming each offending `config.yaml` key.
 */
export type McpScalarIssueReporter = (key: string, expected: string, value: unknown) => void;

export interface NormaliseMcpSectionOptions {
  /**
   * Called for every type-invalid scalar inside the section (`enabled: "yes"`).
   * The normaliser stays pure — it reports and falls back to the default; the
   * caller decides whether that fails startup.
   */
  onScalarError?: McpScalarIssueReporter;
  /** Called for every server that was dropped. Defaults to reporting nothing. */
  onServerError?: (serverName: string, message: string) => void;
}

// ─── Raw YAML value coercion ───

/** A scalar YAML value that is safely stringified (`args: [8080]`). */
const yamlString = z.union([z.string(), z.number(), z.boolean()]).transform((v) => String(v));

/**
 * Numbers stay lenient about numeric strings: `${ENV}` interpolation always
 * yields strings, and `timeout_sec: "60"` is unambiguous.
 */
const yamlNumber = z.union([z.number(), z.string()]).transform((v, ctx) => {
  if (typeof v === 'number') return v;
  const trimmed = v.trim();
  const parsed = trimmed === '' ? Number.NaN : Number(trimmed);
  if (Number.isNaN(parsed)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `expected a number, got "${v}"` });
    return z.NEVER;
  }
  return parsed;
});

// ─── Raw per-server schema (§5.2) ───
//
// `.strict()` is load-bearing: zod's default is to *strip* unknown keys, which
// would silently swallow the unsupported legacy `sse` field and let a server
// that upstream pi-mcp cannot talk to look valid.

const rawMcpOAuthSchema = z
  .object({
    client_id: yamlString.optional(),
    client_secret: yamlString.optional(),
    callback_port: yamlNumber.optional(),
    callback_url: yamlString.optional(),
    scope: yamlString.optional(),
    client_name: yamlString.optional(),
    auth_server_metadata_url: yamlString.optional(),
  })
  .strict();

export const rawMcpServerSchema = z
  .object({
    // `command` XOR `url` — enforced in the superRefine below.
    command: yamlString.optional(),
    args: z.array(yamlString).default([]),
    env: z.record(yamlString).default({}),
    cwd: yamlString.default(''),
    url: yamlString.optional(),
    headers: z.record(yamlString).default({}),
    /** Optional transport hint; `streamable-http` normalises to `http`. */
    type: z.enum(['stdio', 'http', 'streamable-http']).optional(),
    exposure: z.enum(MCP_EXPOSURE_VALUES).default('deferred'),
    tool_exposure: z.record(z.enum(MCP_EXPOSURE_VALUES)).default({}),
    timeout_sec: yamlNumber.optional(),
    enabled: z.boolean().default(true),
    description: yamlString.default(''),
    oauth: rawMcpOAuthSchema.optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const hasCommand = v.command !== undefined;
    const hasUrl = v.url !== undefined;

    if (hasCommand && hasUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['command'],
        message: '`command` and `url` are mutually exclusive',
      });
      return;
    }
    if (!hasCommand && !hasUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['command'],
        message: 'either `command` (stdio) or `url` (http) is required',
      });
      return;
    }
    if (hasCommand && v.command === '') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['command'],
        message: '`command` must not be empty',
      });
    }
    if (hasUrl && v.url === '') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['url'],
        message: '`url` must not be empty',
      });
    }

    // A `type:` that contradicts the transport the transport keys imply would
    // otherwise be silently ignored.
    if (v.type !== undefined) {
      const declared = v.type === 'streamable-http' ? 'http' : v.type;
      const implied = hasCommand ? 'stdio' : 'http';
      if (declared !== implied) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['type'],
          message: `\`type: ${v.type}\` contradicts the configured ${
            hasCommand ? '`command` (stdio)' : '`url` (http)'
          }`,
        });
      }
    }
  });

/** One entry of `mcp.servers` exactly as written in `config.yaml`. */
export type RawMcpServerConfig = z.infer<typeof rawMcpServerSchema>;

// ─── Normalisation ───

/** `codemode` is upstream's default and has no equivalent here (§2.3). */
function normaliseExposure(exposure: McpRawExposure): McpExposure {
  return exposure === 'codemode' ? 'deferred' : exposure;
}

function toOAuthConfig(raw: z.infer<typeof rawMcpOAuthSchema>): McpOAuthConfig {
  return {
    clientId: raw.client_id ?? '',
    clientSecret: raw.client_secret ?? '',
    // 0 would let the OS pick a port; a stable port is needed to build the
    // redirect URL shown to the user (§10.1).
    callbackPort: raw.callback_port ?? 8765,
    callbackUrl: raw.callback_url ?? '',
    scope: raw.scope ?? '',
    // Some servers only accept known client names (§10.3).
    clientName: raw.client_name ?? 'OhMyAgent',
    authServerMetadataUrl: raw.auth_server_metadata_url ?? '',
  };
}

function toServerConfig(name: string, raw: RawMcpServerConfig): McpServerConfig {
  const toolExposure: Record<string, McpExposure> = {};
  for (const [pattern, exposure] of Object.entries(raw.tool_exposure)) {
    toolExposure[pattern] = normaliseExposure(exposure);
  }

  const base = {
    name,
    enabled: raw.enabled,
    exposure: normaliseExposure(raw.exposure),
    toolExposure,
    description: raw.description,
    ...(raw.oauth ? { oauth: toOAuthConfig(raw.oauth) } : {}),
    ...(raw.timeout_sec !== undefined ? { timeoutSec: raw.timeout_sec } : {}),
  };

  // `superRefine` guarantees exactly one of the two, so the assertions hold.
  if (raw.command !== undefined) {
    return {
      ...base,
      transport: 'stdio',
      command: raw.command,
      args: raw.args,
      env: raw.env,
      cwd: raw.cwd,
    };
  }
  return {
    ...base,
    transport: 'http',
    url: raw.url!,
    headers: raw.headers,
  };
}

/** `my-server` and `my_server` are the same server (§5.2). */
function canonicalServerName(name: string): string {
  return name.replace(/-/g, '_');
}

function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) =>
      issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message,
    )
    .join('; ');
}

interface ScalarReader {
  bool(key: string, fallback: boolean): boolean;
  positiveInt(key: string, fallback: number): number;
  stringList(key: string, fallback: readonly string[]): string[];
}

/**
 * Strict readers for the section-level scalars, so `enabled: "yes"` is a
 * startup error rather than a silent `true` (config-loader.ts's contract).
 */
function createScalarReader(
  section: Record<string, unknown>,
  report: McpScalarIssueReporter,
): ScalarReader {
  return {
    bool(key, fallback) {
      const value = section[key];
      if (value === undefined || value === null) return fallback;
      if (typeof value === 'boolean') return value;
      if (value === 'true' || value === '1') return true;
      if (value === 'false' || value === '0') return false;
      report(`mcp.${key}`, 'a boolean', value);
      return fallback;
    },

    positiveInt(key, fallback) {
      const value = section[key];
      if (value === undefined || value === null) return fallback;
      const parsed =
        typeof value === 'number'
          ? value
          : typeof value === 'string' && value.trim() !== ''
            ? Number(value)
            : Number.NaN;
      if (!Number.isNaN(parsed) && Number.isInteger(parsed) && parsed > 0) return parsed;
      report(`mcp.${key}`, 'a positive integer', value);
      return fallback;
    },

    stringList(key, fallback) {
      const value = section[key];
      if (value === undefined || value === null) return [...fallback];
      if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
      if (typeof value === 'string') {
        return value
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
      }
      report(`mcp.${key}`, 'a string or list of strings', value);
      return [...fallback];
    },
  };
}

/**
 * Turn the raw `mcp:` YAML node into a fully-defaulted {@link McpSectionConfig}.
 *
 * Pure: every outcome is reported through `options` callbacks and returned in
 * the result — no logging, no file access. Throws only when the section itself
 * is unusable, i.e. two server names that differ only in `-` vs `_` (§5.2).
 *
 * @param raw - The `mcp:` node as parsed from `config.yaml` (already
 *   `${ENV}`-interpolated), or `undefined` for an absent section.
 * @param options - Optional reporters for invalid scalars and skipped servers.
 */
export function normaliseMcpSection(
  raw: unknown,
  options: NormaliseMcpSectionOptions = {},
): McpSectionConfig {
  const reportScalar = options.onScalarError ?? (() => {});
  const reportServer = options.onServerError ?? (() => {});

  const emptySection = (): McpSectionConfig => ({
    ...DEFAULT_MCP_SECTION,
    allowServers: [],
    denyServers: [],
    servers: {},
  });

  if (raw === undefined || raw === null) return emptySection();
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    reportScalar('mcp', 'a mapping', raw);
    return emptySection();
  }

  const section = raw as Record<string, unknown>;
  const reader = createScalarReader(section, reportScalar);

  const servers: Record<string, McpServerConfig> = {};
  const canonicalNames = new Map<string, string>();
  const rawServers = section.servers;

  if (rawServers !== undefined && rawServers !== null) {
    if (typeof rawServers !== 'object' || Array.isArray(rawServers)) {
      reportScalar('mcp.servers', 'a mapping', rawServers);
    } else {
      for (const [name, value] of Object.entries(rawServers as Record<string, unknown>)) {
        const canonical = canonicalServerName(name);
        const previous = canonicalNames.get(canonical);
        if (previous !== undefined) {
          throw new ConfigError(
            `Invalid config.yaml: mcp.servers contains both "${previous}" and "${name}" — ` +
              'server names differing only in "-" vs "_" are the same name. Rename one of them.',
          );
        }
        canonicalNames.set(canonical, name);

        if (!MCP_SERVER_NAME_PATTERN.test(name)) {
          reportServer(name, 'server name may only contain [A-Za-z0-9_-]');
          continue;
        }

        const parsed = rawMcpServerSchema.safeParse(value);
        if (!parsed.success) {
          reportServer(name, formatZodIssues(parsed.error));
          continue;
        }
        servers[name] = toServerConfig(name, parsed.data);
      }
    }
  }

  return {
    enabled: reader.bool('enabled', DEFAULT_MCP_SECTION.enabled),
    connectTimeoutSec: reader.positiveInt(
      'connect_timeout_sec',
      DEFAULT_MCP_SECTION.connectTimeoutSec,
    ),
    requestTimeoutSec: reader.positiveInt(
      'request_timeout_sec',
      DEFAULT_MCP_SECTION.requestTimeoutSec,
    ),
    maxOutputBytes: reader.positiveInt('max_output_bytes', DEFAULT_MCP_SECTION.maxOutputBytes),
    maxConcurrentConnects: reader.positiveInt(
      'max_concurrent_connects',
      DEFAULT_MCP_SECTION.maxConcurrentConnects,
    ),
    injectSystemPrompt: reader.bool('inject_system_prompt', DEFAULT_MCP_SECTION.injectSystemPrompt),
    allowServers: reader.stringList('allow_servers', DEFAULT_MCP_SECTION.allowServers),
    denyServers: reader.stringList('deny_servers', DEFAULT_MCP_SECTION.denyServers),
    servers,
  };
}

/**
 * Build the {@link McpVisibilityConfig} consumed by
 * `src/policy/mcp-visibility.ts`. An unconfigured (or disabled) section yields
 * empty lists, which that module reads as "no restriction".
 */
export function toMcpVisibilityConfig(
  section: McpSectionConfig | undefined | null,
): McpVisibilityConfig {
  return {
    allowServers: section?.allowServers ?? [],
    denyServers: section?.denyServers ?? [],
  };
}
