// ---------------------------------------------------------------------------
// v4 Policy — MCP tool visibility across tool profiles
// ---------------------------------------------------------------------------
//
// See MyDocs/MCP_INTEGRATION_DESIGN.md §12.3.
//
// `PROFILE_TOOLS` is an explicit allow-list, so dynamically named MCP tools are
// filtered out of `standard`/`restricted` unless something lets them through.
// There are FOUR consumers of that policy and only two of them are functional:
//
//   1. src/agent/agent-manager.ts    filterByProfile()      (functional)
//   2. src/agent/tool-pipeline.ts    Stage 3                (functional)
//   3. src/agent/agent-factory.ts    catalog display mirror (cosmetic)
//   4. src/policy/tool-visibility.ts isVisible()            (policy layer)
//
// All four must call `isMcpToolVisible` rather than re-deriving the rule, or a
// tool can be visible in one layer and invisible in another.

import type { ToolProfileId } from './types.js';

/** Every MCP tool name starts with this prefix. */
export const MCP_TOOL_PREFIX = 'mcp__';

/**
 * Reserved pseudo-server for the three resource tools (§11). It is exempt from
 * the `allow_servers` allow-list — otherwise `allow_servers: [filesystem]`
 * would silently switch resource reading off — but can still be blocked by
 * `deny_servers: ['resources']`.
 */
export const MCP_RESERVED_SERVER = 'resources';

export interface McpVisibilityScope {
  toolsProfile: ToolProfileId;
  allowServers: readonly string[];
  denyServers: readonly string[];
}

/** The subset of `config.mcp` that visibility depends on. */
export interface McpVisibilityConfig {
  allowServers?: readonly string[];
  denyServers?: readonly string[];
}

/** True when the name is an MCP tool name. */
export function isMcpToolName(toolName: string): boolean {
  return toolName.startsWith(MCP_TOOL_PREFIX);
}

/**
 * Extract the server segment from `mcp__<server>__<tool>`.
 * Returns `null` for non-MCP names or malformed ones (missing tool segment).
 */
export function serverNameOfMcpTool(toolName: string): string | null {
  if (!isMcpToolName(toolName)) return null;
  const rest = toolName.slice(MCP_TOOL_PREFIX.length);
  const sep = rest.indexOf('__');
  if (sep <= 0) return null;
  const server = rest.slice(0, sep);
  const tool = rest.slice(sep + 2);
  if (!server || !tool) return null;
  return server;
}

/** Normalise raw config into a visibility scope. */
export function toMcpVisibilityScope(
  toolsProfile: ToolProfileId,
  mcp: McpVisibilityConfig | undefined | null,
): McpVisibilityScope {
  return {
    toolsProfile,
    allowServers: mcp?.allowServers ?? [],
    denyServers: mcp?.denyServers ?? [],
  };
}

/**
 * Decide whether an MCP tool is visible under the current profile.
 *
 * Returns `undefined` when the name is not an MCP tool, which tells the caller
 * to fall back to its own profile logic. Returning a boolean here instead would
 * make every consumer re-check the prefix.
 */
export function isMcpToolVisible(toolName: string, scope: McpVisibilityScope): boolean | undefined {
  const server = serverNameOfMcpTool(toolName);
  if (server === null) return undefined;

  // `restricted` is a structural read-only boundary — tool absence beats policy
  // patches, so MCP tools never appear there regardless of allow_servers.
  if (scope.toolsProfile === 'restricted') return false;

  if (scope.denyServers.includes(server)) return false;

  if (server === MCP_RESERVED_SERVER) return true;

  // An empty allow-list means "all servers", matching the convention used by
  // other allow-lists in this codebase.
  if (scope.allowServers.length > 0) return scope.allowServers.includes(server);

  return true;
}
