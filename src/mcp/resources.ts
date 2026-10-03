// ---------------------------------------------------------------------------
// MCP integration — the three read-only resource tools
// ---------------------------------------------------------------------------
//
// See MyDocs/MCP_INTEGRATION_DESIGN.md §11 (resources) and §12.3 (visibility).
//
// The `mcp__` prefix on every name is load-bearing: it is what routes these
// tools through the `isMcpToolVisible()` branch of the profile policy. The
// `resources` segment is the reserved pseudo-server (`MCP_RESERVED_SERVER`) —
// exempt from `mcp.allow_servers`, blockable via `mcp.deny_servers`, invisible
// under the `restricted` profile. That predicate already encodes all of it, so
// nothing here special-cases the name.
//
// BINARY CONTENT: upstream `toLlmContent()` is lossy — it degrades audio to a
// text placeholder and binary resources to `[binary resource … omitted]`. These
// tools therefore never round-trip through it: they read the resource with
// `readResource()` and map the `ReadResourceResult` themselves — text to a text
// block, `image/*` to an image block, anything else spilled to disk with its
// path returned.
//
// RETRIES: resource reads are idempotent, so a 408/429/5xx is retried exactly
// once. Tool calls must never retry (the server may already have executed the
// side effect) — that rule lives in `McpManager.callTool()`.
//
// MCP Apps (`ui://` resources, `text/html;profile=mcp-app`) are out of scope:
// they are filtered out of listings and refused on read.

import { McpHttpError } from '@earendil-works/pi-mcp';
import { Type } from 'typebox';
import { MCP_RESERVED_SERVER, MCP_TOOL_PREFIX } from '../policy/mcp-visibility.js';
import type { OffloadStore } from '../runtime-artifacts/offload-store.js';
import type { ToolCapabilityDescriptor } from '../tools/platform/tool-capabilities.js';
import type { ToolExecutionContext } from '../tools/platform/tool-context.js';
import type { ToolDefinition } from '../tools/platform/tool-definition.js';
import type { ToolExecutionResult, ToolResultContent } from '../tools/platform/tool-result.js';
import { errorResult, textResult } from '../tools/platform/tool-result.js';
import type {
  ListResourceTemplatesResult,
  ListResourcesResult,
  McpCallOptions,
  McpManager,
  McpResourceAccess,
  McpServerState,
  ReadResourceResult,
} from './types.js';

/**
 * The tool names are composed from the frozen visibility constants rather than
 * spelled out, so a rename of the reserved server cannot silently drop them out
 * of the `isMcpToolVisible()` branch.
 */
const RESOURCE_TOOL_PREFIX = `${MCP_TOOL_PREFIX}${MCP_RESERVED_SERVER}__`;

/** Tool name for `resources/list` across one or all resource-capable servers. */
export const MCP_RESOURCES_LIST_TOOL_NAME = `${RESOURCE_TOOL_PREFIX}list`;
/** Tool name for `resources/templates/list`. */
export const MCP_RESOURCES_LIST_TEMPLATES_TOOL_NAME = `${RESOURCE_TOOL_PREFIX}list_templates`;
/** Tool name for `resources/read`. */
export const MCP_RESOURCES_READ_TOOL_NAME = `${RESOURCE_TOOL_PREFIX}read`;

/** Every resource tool name, in registration order. */
export const MCP_RESOURCE_TOOL_NAMES = [
  MCP_RESOURCES_LIST_TOOL_NAME,
  MCP_RESOURCES_LIST_TEMPLATES_TOOL_NAME,
  MCP_RESOURCES_READ_TOOL_NAME,
] as const;

/** Resource tools are read-only and never require approval. */
export const mcpResourceToolCapability: ToolCapabilityDescriptor = {
  category: 'mcp',
  readOnly: true,
  readsFiles: false,
  writesFiles: false,
  usesShell: false,
  usesNetwork: true,
  usesComputerUse: false,
  pathAccess: 'none',
  approvalDefault: 'none',
};

/** MIME type of an MCP App resource — not rendered by this gateway. */
const MCP_APP_MIME = 'text/html;profile=mcp-app';

/** HTTP statuses worth one retry: throttling and transient server failures. */
const RETRYABLE_HTTP_STATUSES = [408, 429];

export interface McpResourceToolDeps {
  /** Server states: which servers exist, are usable, and declare `resources`. */
  manager: McpManager;
  /**
   * Per-server resource access — the concrete manager's `resources` surface
   * (§11). Injected rather than read off the manager so these tools can be
   * unit-tested against a stub without a live server.
   */
  resources: McpResourceAccess;
  /**
   * Spill store for binary payloads (§19-14). The manager owns its own
   * `OffloadStore` instance, independent of `memory.offloading.enabled`.
   */
  offload: Pick<OffloadStore, 'writeSpill'>;
}

/** One server's failure inside an aggregate listing. */
export interface McpResourceToolError {
  server: string;
  error: string;
}

/** A listed resource, tagged with the server it came from. */
export type McpResourceListItem = ListResourcesResult['resources'][number] & { server: string };

/** A listed URI template, tagged with the server it came from. */
export type McpResourceTemplateItem = ListResourceTemplatesResult['resourceTemplates'][number] & {
  server: string;
};

/** `mcp__resources__list` payload. */
export interface McpResourceListView {
  /** Present only when the call pinned one server. */
  server?: string;
  resources: McpResourceListItem[];
  /** Present only for a single-server call; see `truncatedServers` otherwise. */
  nextCursor?: string;
  /** Servers whose listing had more pages — re-query them with `server`. */
  truncatedServers?: string[];
  errors?: McpResourceToolError[];
}

/** `mcp__resources__list_templates` payload. */
export interface McpResourceTemplateListView {
  server?: string;
  resourceTemplates: McpResourceTemplateItem[];
  nextCursor?: string;
  truncatedServers?: string[];
  errors?: McpResourceToolError[];
}

const ListParams = Type.Object({
  server: Type.Optional(
    Type.String({
      description:
        'Server name from mcp__resources__list. Omit to list every connected server that provides resources.',
    }),
  ),
  cursor: Type.Optional(
    Type.String({
      description:
        'Pagination cursor returned as nextCursor by a previous call. Requires `server`.',
    }),
  ),
});

const ReadParams = Type.Object({
  server: Type.String({
    description: 'Server that owns the resource, as reported by mcp__resources__list.',
  }),
  uri: Type.String({
    description: 'Resource URI to read, exactly as reported by mcp__resources__list.',
  }),
});

interface ResourceListArgs {
  server?: string;
  cursor?: string;
}

interface ResourceReadArgs {
  server: string;
  uri: string;
}

/**
 * True when the resource tools should exist at all: at least one *connected*
 * server declares the `resources` capability. The wiring layer calls this on
 * every tool-set reconciliation and registers or unregisters accordingly.
 */
export function shouldRegisterResourceTools(manager: McpManager): boolean {
  return manager
    .listServers()
    .some((server) => server.supportsResources && server.state === 'connected');
}

/**
 * Build the three resource tool definitions. Register them via the tool
 * registry and register {@link mcpResourceToolCapability} for each of
 * {@link MCP_RESOURCE_TOOL_NAMES} through `registerToolCapability()`, so
 * approval gating does not fall back to the fail-closed default.
 */
export function createResourceToolDefinitions(
  deps: McpResourceToolDeps,
): [
  ToolDefinition<ResourceListArgs>,
  ToolDefinition<ResourceListArgs>,
  ToolDefinition<ResourceReadArgs>,
] {
  return [
    {
      name: MCP_RESOURCES_LIST_TOOL_NAME,
      label: 'MCP Resources',
      description:
        'List resources exposed by connected MCP servers. Pass `server` to list one server; omit it to list all of them. Cursors are per server: pass `server` together with `cursor` to page.',
      category: 'mcp',
      parametersSchema: ListParams,
      capability: mcpResourceToolCapability,
      deferrable: true,
      execute: (args, ctx) => listResources(args, ctx, deps),
    },
    {
      name: MCP_RESOURCES_LIST_TEMPLATES_TOOL_NAME,
      label: 'MCP Resource Templates',
      description:
        'List URI templates of resources exposed by connected MCP servers. Use mcp__resources__read with a filled-in URI to read one.',
      category: 'mcp',
      parametersSchema: ListParams,
      capability: mcpResourceToolCapability,
      deferrable: true,
      execute: (args, ctx) => listResourceTemplates(args, ctx, deps),
    },
    {
      name: MCP_RESOURCES_READ_TOOL_NAME,
      label: 'MCP Resource Read',
      description:
        'Read one MCP resource by URI. Text comes back as text, images as images, other binary content is saved to a file whose path is returned.',
      category: 'mcp',
      parametersSchema: ReadParams,
      capability: mcpResourceToolCapability,
      deferrable: true,
      execute: (args, ctx) => readResource(args, ctx, deps),
    },
  ];
}

// ─── Listing ───

/**
 * Forward the abort signal only when the caller actually supplied one, so an
 * un-cancellable call keeps the two-argument call shape.
 */
function callOpts(ctx: ToolExecutionContext): McpCallOptions | undefined {
  return ctx.signal ? { signal: ctx.signal } : undefined;
}

async function listResources(
  args: ResourceListArgs,
  ctx: ToolExecutionContext,
  deps: McpResourceToolDeps,
): Promise<ToolExecutionResult> {
  const targets = resolveTargetServers(deps.manager, args);
  if ('error' in targets) return errorResult(targets.error);

  const resources: McpResourceListItem[] = [];
  const errors: McpResourceToolError[] = [];
  const truncated: string[] = [];
  let nextCursor: string | undefined;

  for (const server of targets.servers) {
    try {
      const page = await withResourceRetry(() =>
        deps.resources.listResources(server.name, args.cursor, callOpts(ctx)),
      );
      for (const resource of page.resources) {
        if (isMcpAppResource(resource.uri, resource.mimeType)) continue;
        resources.push({ ...resource, server: server.name });
      }
      if (page.nextCursor !== undefined) {
        if (targets.servers.length === 1) nextCursor = page.nextCursor;
        else truncated.push(server.name);
      }
    } catch (err) {
      errors.push({ server: server.name, error: errorMessage(err) });
    }
  }

  return listingResult(
    {
      server: args.server,
      resources,
      ...presentOnly({ nextCursor, truncatedServers: truncated, errors }),
    },
    errors,
    targets.servers.length,
  );
}

async function listResourceTemplates(
  args: ResourceListArgs,
  ctx: ToolExecutionContext,
  deps: McpResourceToolDeps,
): Promise<ToolExecutionResult> {
  const targets = resolveTargetServers(deps.manager, args);
  if ('error' in targets) return errorResult(targets.error);

  const resourceTemplates: McpResourceTemplateItem[] = [];
  const errors: McpResourceToolError[] = [];
  const truncated: string[] = [];
  let nextCursor: string | undefined;

  for (const server of targets.servers) {
    try {
      const page = await withResourceRetry(() =>
        deps.resources.listResourceTemplates(server.name, args.cursor, callOpts(ctx)),
      );
      for (const template of page.resourceTemplates) {
        // A template has no mimeType until it is instantiated; only the
        // `ui://` scheme identifies an MCP App at this stage.
        if (isMcpAppUri(template.uriTemplate)) continue;
        resourceTemplates.push({ ...template, server: server.name });
      }
      if (page.nextCursor !== undefined) {
        if (targets.servers.length === 1) nextCursor = page.nextCursor;
        else truncated.push(server.name);
      }
    } catch (err) {
      errors.push({ server: server.name, error: errorMessage(err) });
    }
  }

  return listingResult(
    {
      server: args.server,
      resourceTemplates: resourceTemplates,
      ...presentOnly({ nextCursor, truncatedServers: truncated, errors }),
    },
    errors,
    targets.servers.length,
  );
}

// ─── Reading ───

async function readResource(
  args: ResourceReadArgs,
  ctx: ToolExecutionContext,
  deps: McpResourceToolDeps,
): Promise<ToolExecutionResult> {
  const serverName = args.server?.trim();
  const uri = args.uri?.trim();
  if (!serverName) {
    return errorResult('`server` is required — find it with mcp__resources__list.');
  }
  if (!uri) return errorResult('`uri` is required.');
  if (isMcpAppUri(uri)) return errorResult(mcpAppMessage(uri));

  const server = checkServer(deps.manager, serverName);
  if ('error' in server) return errorResult(server.error);

  let result: ReadResourceResult;
  try {
    result = await withResourceRetry(() =>
      deps.resources.readResource(serverName, uri, callOpts(ctx)),
    );
  } catch (err) {
    return errorResult(
      `Failed to read resource "${uri}" from MCP server "${serverName}": ${errorMessage(err)}`,
    );
  }

  const content: ToolResultContent[] = [
    { type: 'text', text: `Resource "${uri}" from "${serverName}":` },
  ];
  let skippedApps = 0;
  let spilled = 0;

  for (const item of result.contents) {
    if (isMcpAppMime(item.mimeType)) {
      skippedApps++;
      continue;
    }
    if ('text' in item) {
      content.push({ type: 'text', text: item.text });
      continue;
    }
    if (item.mimeType?.startsWith('image/')) {
      content.push({ type: 'image', data: item.blob, mimeType: item.mimeType });
      continue;
    }

    // Everything else (pdf, audio, octet-stream, …) is spilled as base64: the
    // file must stay byte-exact, and `writeSpill()` writes text verbatim.
    const spilledFile = deps.offload.writeSpill(
      sessionKey(ctx),
      MCP_RESOURCES_READ_TOOL_NAME,
      item.blob,
    );
    spilled++;
    content.push({
      type: 'text',
      text:
        `Binary resource "${item.uri}" (${item.mimeType ?? 'unknown type'}, ` +
        `${base64ByteLength(item.blob)} bytes) saved base64-encoded to ${spilledFile.absPath}`,
    });
  }

  if (content.length === 1) {
    if (skippedApps > 0) return errorResult(mcpAppMessage(uri));
    return textResult(`Resource "${uri}" from "${serverName}" returned no content.`);
  }

  return {
    content,
    metadata: {
      server: serverName,
      uri,
      spilledContents: spilled,
      contents: result.contents.length,
    },
  };
}

// ─── Server selection ───

/**
 * The servers a listing call covers. A pinned `server` must exist, be enabled
 * and declare `resources`; otherwise the caller gets an explanation instead of
 * an empty list that looks like "this server has no resources".
 */
function resolveTargetServers(
  manager: McpManager,
  args: ResourceListArgs,
): { servers: McpServerState[] } | { error: string } {
  const requested = args.server?.trim();
  if (!requested) {
    if (args.cursor) {
      return { error: '`cursor` requires `server`: pagination is per server.' };
    }
    const servers = manager
      .listServers()
      .filter((server) => server.supportsResources && server.state !== 'disabled');
    if (servers.length === 0) return { error: noResourceServerMessage(manager) };
    return { servers };
  }
  const server = checkServer(manager, requested);
  if ('error' in server) return { error: server.error };
  return { servers: [server.server] };
}

function checkServer(
  manager: McpManager,
  serverName: string,
): { server: McpServerState } | { error: string } {
  const server = manager.getServerState(serverName);
  if (!server)
    return { error: `Unknown MCP server "${serverName}". ${noResourceServerMessage(manager)}` };
  if (!server.supportsResources) {
    return { error: `MCP server "${serverName}" does not declare the resources capability.` };
  }
  if (server.state === 'disabled') return { error: `MCP server "${serverName}" is disabled.` };
  return { server };
}

function noResourceServerMessage(manager: McpManager): string {
  const names = manager
    .listServers()
    .filter((server) => server.supportsResources && server.state !== 'disabled')
    .map((server) => server.name);
  return names.length > 0
    ? `MCP servers providing resources: ${names.join(', ')}.`
    : 'No connected MCP server declares the resources capability.';
}

// ─── Result shaping ───

function listingResult(
  payload: McpResourceListView | McpResourceTemplateListView,
  errors: McpResourceToolError[],
  serverCount: number,
): ToolExecutionResult {
  const listed =
    'resources' in payload ? payload.resources.length : payload.resourceTemplates.length;
  // Every server failed: surface it as a failure so the agent loop's
  // failure-streak guard sees it. A partial listing stays a success.
  if (listed === 0 && errors.length > 0 && errors.length === serverCount) {
    return errorResult(errors.map((e) => `MCP server "${e.server}": ${e.error}`).join('\n'));
  }
  return textResult(JSON.stringify(payload), { errors: errors.length });
}

/** Drop absent and empty members so optional payload keys stay out of the JSON. */
function presentOnly<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(
      ([, v]) => v !== undefined && !(Array.isArray(v) && v.length === 0),
    ),
  ) as Partial<T>;
}

/** Spill bucket when a call arrives without a session (rare; agent runs set one). */
const FALLBACK_SESSION_KEY = 'mcp-resources';

function sessionKey(ctx: ToolExecutionContext): string {
  return ctx.sessionId ?? FALLBACK_SESSION_KEY;
}

// ─── MCP Apps filtering ───

function isMcpAppUri(uri: string): boolean {
  return uri.startsWith('ui://');
}

function isMcpAppMime(mimeType: string | undefined): boolean {
  if (!mimeType) return false;
  return mimeType.replace(/\s+/g, '').toLowerCase() === MCP_APP_MIME;
}

function isMcpAppResource(uri: string, mimeType: string | undefined): boolean {
  return isMcpAppUri(uri) || isMcpAppMime(mimeType);
}

function mcpAppMessage(uri: string): string {
  return `"${uri}" is an MCP App resource (${MCP_APP_MIME}), which this gateway does not render.`;
}

// ─── Retry ───

/** One retry on 408/429/5xx; everything else propagates immediately. */
async function withResourceRetry<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (err) {
    if (!isRetryable(err)) throw err;
    return operation();
  }
}

function isRetryable(err: unknown): boolean {
  if (!(err instanceof McpHttpError)) return false;
  return RETRYABLE_HTTP_STATUSES.includes(err.status) || err.status >= 500;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Decoded size of a base64 payload, without allocating the buffer. */
function base64ByteLength(data: string): number {
  if (data.length === 0) return 0;
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - padding;
}
