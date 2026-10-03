// ---------------------------------------------------------------------------
// MCP integration — built-in preset server catalogue
// ---------------------------------------------------------------------------
//
// See MyDocs/MCP_INTEGRATION_DESIGN.md §13.3 (install flow) and §19-9 (no
// dependency pre-download).
//
// Data only: no side effects, no network, no filesystem. The WebUI's preset
// list renders this catalogue, prefills the install form from one entry, and
// the ordinary install pipeline (`POST /api/mcp/servers`) does the rest. Nothing
// is downloaded ahead of time — the package is pulled when the server first
// connects, which is exactly what the "test connection" step makes visible.
//
// Package choices are deliberate: `npx -y` where the official server publishes
// to npm, `uvx` where the official reference server is Python-only (names that
// look like an npm equivalent exist only as unpublished `0.0.1-security`
// placeholders, which must not be suggested).

import type { McpTransportKind, McpExposure } from './types.js';

/** One environment variable a preset may need, with the hint shown in the form. */
export interface McpPresetEnvVar {
  /** Variable name written to `mcp.servers.<name>.env`. */
  key: string;
  /** One-line human-readable hint rendered next to the input. */
  hint: string;
  /** The server refuses to start without it. */
  required: boolean;
  /** Mask the value in the install form and never echo it back through the API. */
  secret?: boolean;
}

/** One installable server in the built-in catalogue. */
export interface McpPreset {
  /** Stable identifier; also the suggested `mcp.servers` key. */
  id: string;
  /** Display name for the preset list. */
  name: string;
  /** One-line description. */
  description: string;
  transport: McpTransportKind;
  /** Executable to spawn (stdio only) — a single binary, never a shell string. */
  command?: string;
  args?: string[];
  /** Endpoint (http only). */
  url?: string;
  /** Suggested exposure for every tool of this server (§7.1). */
  exposure: McpExposure;
  /** Environment variables to offer; empty when the server needs none. */
  env: McpPresetEnvVar[];
  /** Upstream documentation for this server. */
  docsUrl: string;
}

const SERVER_DOCS = 'https://github.com/modelcontextprotocol/servers/tree/main/src';

/**
 * Built-in catalogue. Every entry is `deferred`: MCP tools are discovered
 * through `tool_search` unless the user opts a server into `direct` (§7.0).
 *
 * Read-only to callers — the entries and the array are frozen, so a mutation
 * attempt fails loudly instead of changing what the next install receives.
 */
const CATALOGUE: McpPreset[] = [
  {
    id: 'filesystem',
    name: 'Filesystem',
    description:
      'Read, write and search local files under the directories listed after the package name — edit the trailing path before installing.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
    exposure: 'deferred',
    env: [],
    docsUrl: `${SERVER_DOCS}/filesystem`,
  },
  {
    id: 'git',
    name: 'Git',
    description:
      'Inspect a local git repository: status, diffs, log, branches — requires uv/uvx (Python).',
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-git', '--repository', '.'],
    exposure: 'deferred',
    env: [],
    docsUrl: `${SERVER_DOCS}/git`,
  },
  {
    id: 'fetch',
    name: 'Fetch',
    description:
      'Fetch a URL and return its content converted to markdown — requires uv/uvx (Python).',
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-fetch'],
    exposure: 'deferred',
    env: [],
    docsUrl: `${SERVER_DOCS}/fetch`,
  },
  {
    id: 'github',
    name: 'GitHub',
    description:
      'Issues, pull requests, commits and code search on GitHub via a personal access token.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    exposure: 'deferred',
    env: [
      {
        key: 'GITHUB_PERSONAL_ACCESS_TOKEN',
        hint: 'Personal access token with the repository scopes you need.',
        required: true,
        secret: true,
      },
      {
        key: 'GITHUB_API_URL',
        hint: 'API base URL — set only for GitHub Enterprise (defaults to https://api.github.com).',
        required: false,
      },
    ],
    docsUrl: `${SERVER_DOCS}/github`,
  },
  {
    id: 'memory',
    name: 'Memory',
    description: 'A persistent knowledge graph the model can write entities and relations into.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    exposure: 'deferred',
    env: [
      {
        key: 'MEMORY_FILE_PATH',
        hint: 'File to persist the graph in — defaults to memory.json in the server working directory.',
        required: false,
      },
    ],
    docsUrl: `${SERVER_DOCS}/memory`,
  },
  {
    id: 'sequential_thinking',
    name: 'Sequential Thinking',
    description: 'A structured step-by-step reasoning scratchpad for multi-step problems.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    exposure: 'deferred',
    env: [],
    docsUrl: `${SERVER_DOCS}/sequentialthinking`,
  },
  {
    id: 'time',
    name: 'Time',
    description: 'Current time and timezone conversion helpers — requires uv/uvx (Python).',
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-time'],
    exposure: 'deferred',
    env: [],
    docsUrl: `${SERVER_DOCS}/time`,
  },
];

/**
 * Deep-frozen view of {@link CATALOGUE}. Read-only for callers: a mutation
 * attempt fails loudly instead of changing what the next install receives.
 */
export const MCP_PRESETS: readonly McpPreset[] = Object.freeze(CATALOGUE.map(frozenPreset));

function frozenPreset(preset: McpPreset): McpPreset {
  for (const variable of preset.env) Object.freeze(variable);
  Object.freeze(preset.env);
  if (preset.args) Object.freeze(preset.args);
  return Object.freeze(preset);
}

/** The catalogue, as a fresh array so callers cannot reorder the module constant. */
export function listMcpPresets(): McpPreset[] {
  return [...MCP_PRESETS];
}

/** Look up one preset by its {@link McpPreset.id}. */
export function getMcpPreset(id: string): McpPreset | undefined {
  return MCP_PRESETS.find((preset) => preset.id === id);
}
