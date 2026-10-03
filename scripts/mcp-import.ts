/**
 * `pnpm mcp:import` — convert a standard `mcp.json` into `config.yaml`.
 *
 * See MyDocs/MCP_INTEGRATION_DESIGN.md §5.3 and decision 19-2: this is an
 * **import command only**. `config.yaml` remains the single source of truth for
 * MCP servers; nothing reads `mcp.json` at startup and there is no two-source
 * merge, so there is also no priority question to answer at runtime.
 *
 *   pnpm mcp:import                 # reads ./mcp.json
 *   pnpm mcp:import path/to/mcp.json
 *   pnpm mcp:import --dry-run       # print the plan, write nothing
 *
 * Behaviour:
 *   - `{ "mcpServers": { "<name>": { … } } }` is the only accepted shape.
 *   - `command`/`args`/`env`/`cwd` become a stdio server, `url`/`headers` an
 *     HTTP server; `type: streamable-http` normalises to `http`, and
 *     `type: sse` is rejected outright (upstream pi-mcp dropped that transport).
 *   - Server names already present in `config.yaml` are **never overwritten**:
 *     identical entries are reported as unchanged, differing ones abort the
 *     whole import with a key-by-key diff.
 *   - Every translated server is validated through the same normaliser the
 *     config loader uses, so a successful import always yields a `config.yaml`
 *     that `loadConfig()` accepts.
 *   - The write goes through `mutateConfigYaml()`, which owns the process-wide
 *     serial queue and the atomic temp-file rename (`src/app/webui/yaml-mutation.ts`).
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { isMap, parseDocument, stringify } from 'yaml';
import { mutateConfigYaml } from '../src/app/webui/yaml-mutation.js';
import { normaliseMcpSection, rawMcpServerSchema } from '../src/mcp/config.js';

/** Default source file, matching the standard Claude Desktop / MCP layout. */
export const DEFAULT_MCP_JSON_PATH = './mcp.json';

/** Keys that already mean what they mean in `config.yaml` and pass through as-is. */
const PASSTHROUGH_KEYS = [
  'exposure',
  'tool_exposure',
  'timeout_sec',
  'enabled',
  'description',
  'oauth',
] as const;

/** Transport spelling → the pair of keys that actually decides stdio vs HTTP. */
const TRANSPORT_KEYS = ['command', 'args', 'env', 'cwd', 'url', 'headers', 'type'] as const;

/** Thrown for anything wrong with `mcp.json` itself (shape, `sse`, bad types). */
export class McpImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpImportError';
  }
}

/** One server that exists in both files with different values. */
export interface McpImportConflict {
  name: string;
  /** Human-readable per-key differences, e.g. `args: [a] -> [b]` or `+ description`. */
  diffs: string[];
}

/**
 * Thrown when an imported server name already exists in `config.yaml` with
 * different values. Carries the structured conflicts so callers can render them
 * without re-parsing the message.
 */
export class McpImportConflictError extends Error {
  constructor(
    readonly conflicts: readonly McpImportConflict[],
    message: string,
  ) {
    super(message);
    this.name = 'McpImportConflictError';
  }
}

/** A translated server, in the exact shape `config.yaml` expects. */
export interface TranslatedMcpServer {
  name: string;
  transport: 'stdio' | 'http';
  /** Raw `config.yaml` keys, ready to be written under `mcp.servers.<name>`. */
  entry: Record<string, unknown>;
  /** Keys present in `mcp.json` that the import dropped (reported, not applied). */
  ignoredKeys: string[];
}

export interface McpImportOptions {
  /** `mcp.json` to read; relative paths resolve against the working directory. */
  mcpJsonPath?: string;
  /** Print the plan without touching `config.yaml`. */
  dryRun?: boolean;
  /** Progress sink; defaults to `console.log`. */
  log?: (line: string) => void;
}

export interface McpImportResult {
  sourcePath: string;
  configPath: string;
  /** Servers that will be (or were) written. */
  added: TranslatedMcpServer[];
  /** Servers whose `mcp.json` entry already matches `config.yaml` byte-for-byte. */
  unchanged: string[];
  /** Keys dropped from imported entries, keyed by server name (never silent). */
  ignoredKeys: Record<string, string[]>;
}

// ─── Parsing ───

function describeValue(value: unknown): string {
  const rendered = JSON.stringify(value);
  return rendered === undefined ? String(value) : rendered;
}

function asScalarRecord(server: string, key: string, value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new McpImportError(
      `server "${server}": \`${key}\` must be an object of string values, got ${describeValue(value)}`,
    );
  }
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === null || typeof v === 'object') {
      throw new McpImportError(
        `server "${server}": \`${key}.${k}\` must be a string, got ${describeValue(v)}`,
      );
    }
    result[k] = String(v);
  }
  return result;
}

function asScalarArray(server: string, value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new McpImportError(
      `server "${server}": \`args\` must be an array, got ${describeValue(value)} ` +
        '(a single command string cannot be split safely — use one array element per argument)',
    );
  }
  return value.map((v, i) => {
    if (v === null || typeof v === 'object') {
      throw new McpImportError(
        `server "${server}": \`args[${i}]\` must be a string, got ${describeValue(v)}`,
      );
    }
    return String(v);
  });
}

function asString(server: string, key: string, value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  throw new McpImportError(
    `server "${server}": \`${key}\` must be a string, got ${describeValue(value)}`,
  );
}

/**
 * Parse the text of an `mcp.json` file.
 *
 * @param text - File contents.
 * @param sourcePath - Used in error messages only.
 * @returns The `mcpServers` mapping, unmodified.
 */
export function parseMcpJson(
  text: string,
  sourcePath = DEFAULT_MCP_JSON_PATH,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new McpImportError(`${sourcePath} is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new McpImportError(`${sourcePath}: expected a JSON object at the top level`);
  }
  const servers = (parsed as Record<string, unknown>).mcpServers;
  if (servers === undefined) {
    throw new McpImportError(
      `${sourcePath}: no "mcpServers" key — the standard shape is ` +
        '{ "mcpServers": { "<name>": { "command": "npx", "args": [] } } }',
    );
  }
  if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) {
    throw new McpImportError(`${sourcePath}: "mcpServers" must be an object`);
  }
  return servers as Record<string, unknown>;
}

// ─── Translation ───

/**
 * Translate one `mcpServers` entry into the `config.yaml` server shape (§5.1).
 *
 * The two spellings are near-identical, so the work here is validation rather
 * than renaming: reject `sse`, reject `command`+`url` together, reject a `type`
 * that contradicts the transport keys, and stringify scalars so
 * `"args": [8080]` does not become a YAML number.
 *
 * @param name - Server name as written in `mcp.json`.
 * @param raw - The entry's value.
 * @throws {McpImportError} When the entry cannot be represented in `config.yaml`.
 */
export function translateMcpServer(name: string, raw: unknown): TranslatedMcpServer {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new McpImportError(`server "${name}": expected an object, got ${describeValue(raw)}`);
  }
  const source = raw as Record<string, unknown>;

  // `sse` is a transport we deliberately do not support (§19 known limits), and
  // it is the one spelling that must never be silently rewritten.
  if (typeof source.type === 'string' && source.type.trim().toLowerCase() === 'sse') {
    throw new McpImportError(
      `server "${name}": transport "sse" is not supported — OhMyAgent speaks stdio and ` +
        'streamable HTTP only. Remove the server or point it at an HTTP endpoint ' +
        '(`"type": "http"` with `"url"`).',
    );
  }

  let declaredType: 'stdio' | 'http' | undefined;
  if (source.type !== undefined) {
    const declared = String(source.type).trim().toLowerCase();
    if (declared === 'stdio' || declared === 'http') {
      declaredType = declared;
    } else if (declared === 'streamable-http' || declared === 'streamable_http') {
      declaredType = 'http';
    } else {
      throw new McpImportError(
        `server "${name}": unknown \`type\` ${describeValue(source.type)} — accepted values are ` +
          'stdio, http and streamable-http',
      );
    }
  }

  const hasCommand = source.command !== undefined;
  const hasUrl = source.url !== undefined;
  if (hasCommand && hasUrl) {
    throw new McpImportError(
      `server "${name}": \`command\` and \`url\` are mutually exclusive — keep one of them`,
    );
  }
  if (!hasCommand && !hasUrl) {
    throw new McpImportError(
      `server "${name}": either \`command\` (stdio) or \`url\` (http) is required`,
    );
  }
  const transport: 'stdio' | 'http' = hasCommand ? 'stdio' : 'http';
  if (declaredType !== undefined && declaredType !== transport) {
    throw new McpImportError(
      `server "${name}": \`type: ${String(source.type)}\` contradicts the configured ` +
        `${hasCommand ? '`command` (stdio)' : '`url` (http)'}`,
    );
  }

  const entry: Record<string, unknown> = {};
  if (transport === 'stdio') {
    entry.command = asString(name, 'command', source.command);
    if (entry.command === '') throw new McpImportError(`server "${name}": \`command\` is empty`);
    const args = source.args === undefined ? [] : asScalarArray(name, source.args);
    if (args.length > 0) entry.args = args;
    const env = source.env === undefined ? {} : asScalarRecord(name, 'env', source.env);
    if (Object.keys(env).length > 0) entry.env = env;
    const cwd = source.cwd === undefined ? '' : asString(name, 'cwd', source.cwd);
    if (cwd !== '') entry.cwd = cwd;
  } else {
    entry.url = asString(name, 'url', source.url);
    if (entry.url === '') throw new McpImportError(`server "${name}": \`url\` is empty`);
    const headers =
      source.headers === undefined ? {} : asScalarRecord(name, 'headers', source.headers);
    if (Object.keys(headers).length > 0) entry.headers = headers;
  }

  // Keep the user's transport hint, normalised: `streamable-http` has no
  // separate meaning here, and dropping `type` entirely would hide the fact
  // that it was rewritten.
  if (source.type !== undefined) entry.type = transport;

  const ignoredKeys: string[] = [];
  for (const [key, value] of Object.entries(source)) {
    if ((TRANSPORT_KEYS as readonly string[]).includes(key)) continue;
    if ((PASSTHROUGH_KEYS as readonly string[]).includes(key)) {
      entry[key] = value;
      continue;
    }
    ignoredKeys.push(key);
  }

  // Validate against the authoritative schema so the import can never write a
  // server that `loadConfig()` would drop (e.g. a bad `exposure` value in a
  // file that also carries our own keys).
  const probe = normaliseMcpSection({ servers: { [name]: entry } });
  if (probe.servers[name] === undefined) {
    const parsed = rawMcpServerSchema.safeParse(entry);
    const detail = parsed.success
      ? 'server name is not valid'
      : parsed.error.issues
          .map((i) => `${i.path.join('.') || '(server)'}: ${i.message}`)
          .join('; ');
    throw new McpImportError(`server "${name}": ${detail}`);
  }

  return { name, transport, entry, ignoredKeys };
}

// ─── Planning ───

/** `-` and `_` are the same server (§5.2), so conflicts must compare canonically. */
function canonicalServerName(name: string): string {
  return name.replace(/-/g, '_');
}

function formatServerYaml(entry: Record<string, unknown>): string {
  return stringify(entry, { indent: 2, lineWidth: 100 })
    .trimEnd()
    .split('\n')
    .map((line) => `      ${line}`)
    .join('\n');
}

/** Per-key differences between the existing and the imported entry, both raw YAML shapes. */
function diffEntries(existing: unknown, imported: Record<string, unknown>): string[] {
  const diffs: string[] = [];
  const left =
    typeof existing === 'object' && existing !== null && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  if (!isDeepStrictEqual(existing, imported) && Object.keys(left).length === 0) {
    diffs.push(`existing entry is not a mapping: ${describeValue(existing)}`);
  }

  for (const key of new Set([...Object.keys(left), ...Object.keys(imported)])) {
    const hasLeft = Object.prototype.hasOwnProperty.call(left, key);
    const hasRight = Object.prototype.hasOwnProperty.call(imported, key);
    if (!hasRight) {
      diffs.push(`- ${key}` + (hasLeft ? `: ${describeValue(left[key])}` : ''));
    } else if (!hasLeft) {
      diffs.push(`+ ${key}: ${describeValue(imported[key])}`);
    } else if (!isDeepStrictEqual(left[key], imported[key])) {
      diffs.push(`${key}: ${describeValue(left[key])} -> ${describeValue(imported[key])}`);
    }
  }
  return diffs;
}

interface ImportPlan {
  added: TranslatedMcpServer[];
  unchanged: string[];
  conflicts: McpImportConflict[];
}

/**
 * Compare the imported servers against the ones already in `config.yaml`.
 *
 * Name comparison is canonical (`my-server` == `my_server`) because the config
 * loader treats those as one server and would otherwise refuse to start on a
 * duplicate it never saw written.
 */
export function planImport(
  imported: readonly TranslatedMcpServer[],
  existingServers: Record<string, unknown>,
): ImportPlan {
  const existingByCanonical = new Map<string, { name: string; value: unknown }>();
  for (const [name, value] of Object.entries(existingServers)) {
    existingByCanonical.set(canonicalServerName(name), { name, value });
  }

  const plan: ImportPlan = { added: [], unchanged: [], conflicts: [] };
  const seen = new Map<string, string>();

  for (const server of imported) {
    const canonical = canonicalServerName(server.name);
    const duplicate = seen.get(canonical);
    if (duplicate !== undefined) {
      throw new McpImportError(
        `mcp.json declares both "${duplicate}" and "${server.name}" — names differing only in ` +
          '"-" vs "_" are the same server. Rename one of them.',
      );
    }
    seen.set(canonical, server.name);

    const existing = existingByCanonical.get(canonical);
    if (existing === undefined) {
      plan.added.push(server);
      continue;
    }
    const diffs = diffEntries(existing.value, server.entry);
    if (diffs.length === 0) {
      plan.unchanged.push(server.name);
      continue;
    }
    plan.conflicts.push({ name: existing.name, diffs });
  }

  return plan;
}

function formatConflicts(conflicts: readonly McpImportConflict[]): string {
  const lines = conflicts.map((conflict) => {
    const body = conflict.diffs.map((d) => `      ${d}`).join('\n');
    return `  server "${conflict.name}" already exists in config.yaml with different values:\n${body}`;
  });
  return (
    `mcp:import: ${conflicts.length} conflict(s) — config.yaml was NOT modified.\n` +
    `${lines.join('\n')}\n` +
    '  Rename the server in mcp.json, or edit/remove the config.yaml entry, then re-run.\n' +
    '  Existing values are never overwritten: config.yaml is the single source of truth ' +
    '(design §19-2).'
  );
}

// ─── Config file access ───

/** Same resolution `yaml-mutation.ts` uses, so preview and write agree. */
function resolveConfigPath(): string {
  return resolve(process.env.CONFIG_FILE || './config.yaml');
}

/** Read `mcp.servers` out of the current `config.yaml` without validating the rest. */
function readExistingServers(configPath: string): Record<string, unknown> {
  if (!existsSync(configPath)) return {};
  const doc = parseDocument(readFileSync(configPath, 'utf-8'));
  if (doc.errors.length > 0) {
    throw new McpImportError(`${configPath} is not valid YAML: ${doc.errors[0].message}`);
  }

  const root = doc.toJS() as Record<string, unknown> | null;
  const mcp = root?.mcp;
  if (typeof mcp !== 'object' || mcp === null || Array.isArray(mcp)) return {};
  const servers = (mcp as Record<string, unknown>).servers;
  if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) return {};
  return servers as Record<string, unknown>;
}

// ─── Entry point ───

/**
 * Run the import: read `mcp.json`, translate, plan, and either print the plan
 * (`dryRun`) or write it through `mutateConfigYaml()`.
 *
 * @param options - Source path, dry-run flag and progress sink.
 * @throws {McpImportError | McpImportConflictError} Source problems and conflicts.
 */
export async function importMcpJson(options: McpImportOptions = {}): Promise<McpImportResult> {
  const log = options.log ?? ((line: string) => console.log(line));
  const sourcePath = resolve(options.mcpJsonPath ?? DEFAULT_MCP_JSON_PATH);
  const configPath = resolveConfigPath();

  if (!existsSync(sourcePath)) {
    throw new McpImportError(
      `${sourcePath} not found — pass a path (\`pnpm mcp:import path/to/mcp.json\`) or create ` +
        'the default ./mcp.json',
    );
  }

  const rawServers = parseMcpJson(readFileSync(sourcePath, 'utf-8'), sourcePath);
  if (Object.keys(rawServers).length === 0) {
    throw new McpImportError(`${sourcePath}: "mcpServers" is empty — nothing to import`);
  }

  const imported = Object.entries(rawServers).map(([name, entry]) =>
    translateMcpServer(name, entry),
  );

  // Preview read. The authoritative check happens again inside the mutator,
  // under the writer's serial queue, so a concurrent writer cannot be raced.
  const plan = planImport(imported, readExistingServers(configPath));
  if (plan.conflicts.length > 0) {
    throw new McpImportConflictError(plan.conflicts, formatConflicts(plan.conflicts));
  }

  log(`mcp:import`);
  log(`  source: ${sourcePath}`);
  log(`  config: ${configPath}`);
  for (const server of plan.added) {
    log(`  + ${server.name} (${server.transport})`);
    log(formatServerYaml(server.entry));
    if (server.ignoredKeys.length > 0) {
      log(`      (ignored mcp.json keys: ${server.ignoredKeys.join(', ')})`);
    }
  }
  for (const name of plan.unchanged) log(`  = ${name} (unchanged, already imported)`);

  const ignoredKeys: Record<string, string[]> = {};
  for (const server of imported) {
    if (server.ignoredKeys.length > 0) ignoredKeys[server.name] = server.ignoredKeys;
  }

  if (options.dryRun) {
    log('  --dry-run: nothing written');
    return { sourcePath, configPath, added: plan.added, unchanged: plan.unchanged, ignoredKeys };
  }

  if (plan.added.length === 0) {
    log('  nothing to do — config.yaml already contains every server in mcp.json');
    return { sourcePath, configPath, added: [], unchanged: plan.unchanged, ignoredKeys };
  }

  await mutateConfigYaml((doc) => {
    // Re-check under the queue: another writer may have added the same server
    // between the preview read and this operation.
    const currentPlan = planImport(imported, readExistingServers(configPath));
    if (currentPlan.conflicts.length > 0) {
      throw new McpImportConflictError(
        currentPlan.conflicts,
        formatConflicts(currentPlan.conflicts),
      );
    }

    const mcpNode = doc.get('mcp', true);
    if (mcpNode !== undefined && mcpNode !== null && !isMap(mcpNode)) {
      throw new McpImportError(
        'config.yaml: `mcp` must be a mapping (or absent) before servers can be imported',
      );
    }
    if (!isMap(mcpNode)) {
      // Absent or explicitly empty (`mcp:` with no value) — start the section.
      const servers: Record<string, unknown> = {};
      for (const server of currentPlan.added) servers[server.name] = server.entry;
      doc.set('mcp', { servers });
      return;
    }
    for (const server of currentPlan.added) {
      // Surgical setIn, not a whole-section replacement: comments and ordering
      // of the servers already in the section survive this import.
      doc.setIn(['mcp', 'servers', server.name], server.entry);
    }
  });

  log(`  wrote ${plan.added.length} server(s)`);
  return { sourcePath, configPath, added: plan.added, unchanged: plan.unchanged, ignoredKeys };
}

const HELP = `Usage: pnpm mcp:import [mcp.json] [--dry-run]

Import a standard MCP config file into the \`mcp.servers\` section of
config.yaml. Existing servers are never overwritten: a name clash aborts the
import and prints a key-by-key diff.

Options:
  --dry-run   Print the plan and the resulting YAML for each new server, write nothing
  -h, --help  Show this help

config.yaml is the only source of truth for MCP servers (design §19-2); this
command is a one-shot conversion, not a second config source.
`;

/** CLI wrapper. Returns the process exit code; never throws. */
export async function runMcpImport(
  argv: readonly string[],
  options: Pick<McpImportOptions, 'log'> = {},
): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP);
    return 0;
  }

  const dryRun = argv.includes('--dry-run');
  const positional = argv.filter((arg) => !arg.startsWith('-'));
  const unknownFlags = argv.filter(
    (arg) => arg.startsWith('-') && arg !== '--dry-run' && arg !== '--help' && arg !== '-h',
  );
  if (unknownFlags.length > 0) {
    console.error(`mcp:import: unknown option ${unknownFlags[0]}`);
    console.error(HELP);
    return 1;
  }
  if (positional.length > 1) {
    console.error(`mcp:import: expected at most one mcp.json path, got ${positional.length}`);
    return 1;
  }

  try {
    await importMcpJson({ mcpJsonPath: positional[0], dryRun, ...options });
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (options.log) options.log(message);
    else console.error(message);
    return 1;
  }
}

// Only run when invoked as a script; importing this module from a test must not
// touch the filesystem.
const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  runMcpImport(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      console.error(err instanceof Error ? err.stack : String(err));
      process.exitCode = 1;
    },
  );
}
