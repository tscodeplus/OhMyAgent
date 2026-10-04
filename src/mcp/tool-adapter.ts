// ---------------------------------------------------------------------------
// MCP integration — MCP `Tool` → v4 `ToolDefinition`
// ---------------------------------------------------------------------------
//
// See MyDocs/MCP_INTEGRATION_DESIGN.md §6.1-§6.5 and §7.1.
//
// Three responsibilities live here:
//
//   1. Naming. `mcp__<server>__<tool>` sanitised to `[A-Za-z0-9_]`, capped at 64
//      characters, with an 8-char hash suffix when the plain name is too long or
//      already taken *by another MCP tool*. Collisions with a non-MCP tool are
//      NOT resolved here — the manager refuses to register those (§6.1 layer 2),
//      because hashing a built-in's name away would silently shadow it.
//
//   2. Exposure resolution. `tool_exposure` overrides win over the server-level
//      default: exact tool name first, then the first matching trailing-`*`
//      pattern, then `server.exposure`.
//
//   3. The definition itself, including `execute()`: MCP reports tool failure
//      inside the result (`isError`), not by throwing, so that flag is mapped
//      onto `ToolExecutionResult.isError` where the agent loop's failure-streak
//      guard can see it.

import { createHash } from 'node:crypto';
import { toLlmContent, type CallToolResult, type Tool } from '@earendil-works/pi-mcp';
import { matchesToolPattern } from '../policy/tool-pattern.js';
import { errorResult } from '../tools/platform/tool-result.js';
import type { ToolDefinition } from '../tools/platform/tool-definition.js';
import type { OffloadStore } from '../runtime-artifacts/offload-store.js';
import { capabilityFromAnnotations } from './capability.js';
import { limitMcpOutput } from './offload.js';
import type { McpCallOptions, McpExposure, McpServerConfig } from './types.js';

/**
 * Provider tool-name ceiling. Names are cut to this length before the hash
 * suffix is appended, so the suffix is never the part that gets truncated away.
 */
export const MCP_TOOL_NAME_MAX_LENGTH = 64;

/** Build the registered tool name for one server tool (design §6.1). */
export function createMcpToolName(
  serverName: string,
  rawToolName: string,
  isTaken: (name: string) => boolean = () => false,
): string {
  const base = `mcp__${serverName}__${rawToolName}`.replace(/[^A-Za-z0-9_]/g, '_');
  if (base.length <= MCP_TOOL_NAME_MAX_LENGTH && !isTaken(base)) return base;

  const hash = createHash('sha256')
    .update(`${serverName}\0${rawToolName}`)
    .digest('hex')
    .slice(0, 8);
  return `${base.slice(0, MCP_TOOL_NAME_MAX_LENGTH - hash.length - 1)}_${hash}`;
}

/**
 * Effective exposure for one tool: exact override > first wildcard match >
 * server-level `exposure`.
 */
export function resolveMcpExposure(server: McpServerConfig, rawToolName: string): McpExposure {
  const overrides = server.toolExposure;

  const exact = overrides[rawToolName];
  if (exact !== undefined) return exact;

  for (const [pattern, exposure] of Object.entries(overrides)) {
    // Exact keys are handled above; only trailing-`*` patterns can match here.
    if (pattern === rawToolName || !pattern.endsWith('*')) continue;
    if (matchesToolPattern(pattern, rawToolName)) return exposure;
  }

  return server.exposure;
}

export interface McpToolDefinitionDeps {
  server: McpServerConfig;
  /** The tool exactly as the server declared it. */
  tool: Tool;
  /** Registered name (see {@link createMcpToolName}). */
  name: string;
  /** Effective exposure — decides `deferrable`. */
  exposure: McpExposure;
  /**
   * Forward to `McpManager.callTool()`. Transport failures reject; MCP-level
   * failures come back inside the result (§6.4).
   */
  callTool(
    rawToolName: string,
    args: Record<string, unknown>,
    opts?: McpCallOptions,
  ): Promise<CallToolResult>;
  /**
   * Spill target for oversized output (§6.6). `maxBytes` is read on every call
   * rather than captured at registration time, so a `mcp.max_output_bytes` edit
   * applies to tools that are already registered (R5).
   */
  offload: { store: OffloadStore; maxBytes: () => number };
}

/**
 * Build the v4 definition for one MCP tool.
 *
 * `deferrable` is `false` only for `exposure: 'direct'`, which the pipeline
 * implements through tool_search's `forceVisible` set (design §7.2/§7.3 — the
 * flag itself is not consumed by `classifyTools()` yet).
 */
export function toMcpToolDefinition(deps: McpToolDefinitionDeps): ToolDefinition {
  const { server, tool } = deps;

  return {
    name: deps.name,
    label: tool.title ?? tool.name,
    description: tool.description ?? tool.name,
    category: 'mcp',
    parametersSchema: normaliseInputSchema(tool.inputSchema),
    capability: capabilityFromAnnotations(tool.annotations, server),
    deferrable: deps.exposure !== 'direct',
    execute: async (rawArgs: unknown, ctx) => {
      let result: CallToolResult;
      try {
        result = await deps.callTool(tool.name, asToolArgs(rawArgs), {
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
      } catch (err) {
        // Transport/session failures reject. Surface the reason as the tool's
        // error text so the model can react (e.g. "server not connected")
        // instead of seeing a bare "unknown tool".
        return errorResult(
          `MCP tool "${deps.name}" on server "${server.name}" failed: ${errorMessage(err)}`,
        );
      }

      const limited = limitMcpOutput(toLlmContent(result), {
        store: deps.offload.store,
        maxBytes: deps.offload.maxBytes(),
        sessionKey: ctx.sessionId ?? 'default',
        toolName: deps.name,
      });

      return {
        content: limited.content,
        isError: result.isError === true,
        metadata: {
          mcpServer: server.name,
          mcpTool: tool.name,
          structuredContent: result.structuredContent,
          ...(limited.fullOutputPath ? { fullOutputPath: limited.fullOutputPath } : {}),
        },
      };
    },
  };
}

/**
 * MCP input schemas are JSON Schema, and some providers reject anything that is
 * not an object schema — or an object schema without `properties` (design §6.2).
 */
function normaliseInputSchema(
  inputSchema: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const schema = inputSchema ?? {};
  const properties = isPlainObject(schema['properties']) ? schema['properties'] : {};
  return { ...schema, type: 'object', properties };
}

/** Tool arguments are always an object; a malformed call must not reach the server. */
function asToolArgs(rawArgs: unknown): Record<string, unknown> {
  return isPlainObject(rawArgs) ? rawArgs : {};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
