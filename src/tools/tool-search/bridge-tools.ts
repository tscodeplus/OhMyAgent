// ---------------------------------------------------------------------------
// Bridge tools for Tool Search
// ---------------------------------------------------------------------------
//
// Three synthetic AgentTool instances that replace deferred tools in the
// model-facing tools array:
//
//   tool_search   — BM25 search over the deferred-tool catalog
//   tool_describe — load the full parameter schema for one deferred tool
//   tool_call     — invoke a deferred tool (execute delegates transparently)
//
// When tool_call.execute is called, it looks up the real tool in the
// deferredCatalog (captured via closure) and delegates to realTool.execute().
// Because realTool was created by AgentToolAdapterImpl.toAgentTool(), its
// execute wrapper already contains beforeExecute/afterExecute policy hooks.
// Those hooks fire for the REAL tool name, not for "tool_call".

import { Type } from 'typebox';
import type { Static } from 'typebox';
import type { AgentTool, AgentToolResult } from '../../pi-mono/agent/types.js';
import type { ToolSearchConfig } from './config.js';
import { buildCatalog, searchCatalog } from './bm25.js';
import { isDeferrable } from './classifier.js';

// ---------------------------------------------------------------------------
// Tool names (must match classifier.ts BRIDGE_TOOL_NAMES)
// ---------------------------------------------------------------------------

export const TOOL_SEARCH_NAME = 'tool_search';
export const TOOL_DESCRIBE_NAME = 'tool_describe';
export const TOOL_CALL_NAME = 'tool_call';

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface BridgeToolDeps {
  /** Map of deferrable tool name → AgentTool. Populated by assembleTools. */
  deferredCatalog: Map<string, AgentTool>;
  /** All tools (used by tool_search when Tool Search is NOT activated). */
  allTools: AgentTool[];
  /** Resolved tool-search configuration. */
  config: ToolSearchConfig;
  /** Whether Tool Search assembly is active for this session. */
  activated: boolean;
}

// ---------------------------------------------------------------------------
// Tool parameters (TypeBox schemas)
// ---------------------------------------------------------------------------

const ToolSearchParams = Type.Object({
  query: Type.String({ description: 'Keywords describing the capability you need (e.g. "create github issue", "persona rebuild", "cron job")' }),
  limit: Type.Optional(Type.Integer({ description: 'Maximum number of results to return. Default 5.' })),
  /** Set to true to invoke the best-matching tool directly. Provide arguments for the tool. */
  invoke: Type.Optional(Type.Boolean({ description: 'Set to true to execute the best-matching tool. Provide arguments below.' })),
  arguments: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: 'Arguments for the tool when invoke=true. Leave empty for no-arg tools.' })),
});
type ToolSearchArgs = Static<typeof ToolSearchParams>;

const ToolDescribeParams = Type.Object({
  name: Type.String({ description: 'Exact tool name (as returned by tool_search)' }),
});
type ToolDescribeArgs = Static<typeof ToolDescribeParams>;

const ToolCallParams = Type.Object({
  name: Type.String({ description: 'Exact tool name to invoke' }),
  arguments: Type.Record(Type.String(), Type.Any(), { description: 'Arguments for the tool, matching its schema' }),
});
type ToolCallArgs = Static<typeof ToolCallParams>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textResult(text: string): AgentToolResult<unknown> {
  return { content: [{ type: 'text', text }], details: {} };
}

function errorResult(text: string): AgentToolResult<unknown> {
  return { content: [{ type: 'text', text: `[ERROR] ${text}` }], details: {} };
}

function jsonResult(obj: unknown): AgentToolResult<unknown> {
  return textResult(JSON.stringify(obj, null, 2));
}

/** Cap description so a chatty tool doesn't blow up the result. */
function capDescription(desc: string | undefined, max: number = 400): string {
  if (!desc) return '';
  return desc.length > max ? desc.slice(0, max - 3) + '...' : desc;
}

// ---------------------------------------------------------------------------
// tool_search
// ---------------------------------------------------------------------------

function createToolSearchTool(deps: BridgeToolDeps): AgentTool {
  return {
    name: TOOL_SEARCH_NAME,
    label: 'Tool Search',
    description: deps.activated
      ? `Discover on-demand capabilities NOT shown in your current tool list. ${deps.deferredCatalog.size} extra tools are available here: ${Array.from(deps.deferredCatalog.keys()).join(', ')}. When you need one of these tools, call tool_search with invoke=true and the exact tool name to run it in one step. You can also search by name substring or regex pattern (e.g. "image.*gen" matches image_generation). These tools can also be called directly by name once you know them.`
      : 'Search available tools by name using exact match, substring, or regex pattern.',
    parameters: ToolSearchParams,
    execute: async (toolCallId, rawParams, signal?, onUpdate?) => {
      const params = rawParams as ToolSearchArgs;
      const query = params.query?.trim() ?? '';
      if (!query) {
        return errorResult('query is required');
      }
      const limit = params.limit ?? deps.config.searchDefaultLimit;
      const clampedLimit = Math.max(1, Math.min(deps.config.maxSearchLimit, limit));

      // Determine search scope
      const scopeTools = deps.activated
        ? Array.from(deps.deferredCatalog.values())
        : deps.allTools;

      // Build catalog and search
      const entries = scopeTools.map((t) => {
        let paramNames = '';
        try {
          const props = (t.parameters as any)?.properties;
          if (props && typeof props === 'object') paramNames = Object.keys(props).join(' ');
        } catch { /* ignore */ }
        return { name: t.name, label: t.label ?? t.name, description: t.description ?? '', category: '', paramNames };
      });

      const catalog = buildCatalog(entries);
      const hits = searchCatalog(catalog, query, clampedLimit);

      // ── invoke mode: auto-execute the best match ──
      if (params.invoke && hits.length > 0) {
        const bestName = hits[0]!.name;
        const realTool = deps.deferredCatalog.get(bestName);
        if (realTool) {
          try {
            const result = await realTool.execute(toolCallId, params.arguments ?? {}, signal, onUpdate);
            return {
              content: [
                { type: 'text', text: `[invoked ${bestName}] ` },
                ...result.content,
              ],
              details: result.details,
            };
          } catch (err) {
            return errorResult(`${bestName} failed: ${(err as Error).message}`);
          }
        }
      }

      // ── search mode: return matches ──
      const matches = hits.map((h) => ({
        name: h.name,
        description: capDescription(h.description),
      }));

      return jsonResult({
        query,
        total_available: entries.length,
        matches,
        hint: 'To invoke a tool, call tool_search again with invoke=true, arguments={...}',
      });
    },
  };
}

// ---------------------------------------------------------------------------
// tool_describe
// ---------------------------------------------------------------------------

function createToolDescribeTool(deps: BridgeToolDeps): AgentTool {
  return {
    name: TOOL_DESCRIBE_NAME,
    label: 'Tool Describe',
    description:
      'Load the full JSON schema for one tool returned by tool_search. ' +
      'Required before tool_call if the tool\'s parameters are unknown.',
    parameters: ToolDescribeParams,
    execute: async (_toolCallId, rawParams, _signal?) => {
      const params = rawParams as ToolDescribeArgs;
      const name = params.name.trim();
      if (!name) {
        return errorResult('name is required');
      }

      if (!isDeferrable(name)) {
        return errorResult(
          `'${name}' is not a deferrable tool. If you see it in the tools list already, call it directly; otherwise check the spelling against tool_search.`,
        );
      }

      // Look up in the deferred catalog
      const tool = deps.deferredCatalog.get(name);
      if (!tool) {
        // Maybe it's a core tool the model is asking about — look in allTools
        const coreTool = deps.allTools.find((t) => t.name === name);
        if (coreTool) {
          return errorResult(
            `'${name}' is already available as a direct tool. Call it directly instead of via tool_describe/tool_call.`,
          );
        }
        return errorResult(
          `'${name}' is not currently available. Re-run tool_search to refresh.`,
        );
      }

      return jsonResult({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// tool_call
// ---------------------------------------------------------------------------

function createToolCallTool(deps: BridgeToolDeps): AgentTool {
  return {
    name: TOOL_CALL_NAME,
    label: 'Tool Call',
    description:
      'Invoke a deferred tool by name with the given arguments. Argument shape ' +
      'matches the tool\'s schema (see tool_describe). Policy, hooks, and ' +
      'approvals run exactly as for any directly-listed tool.',
    parameters: ToolCallParams,
    execute: async (toolCallId, rawParams, signal?, onUpdate?) => {
      const params = rawParams as ToolCallArgs;
      const name = params.name?.trim();
      if (!name) {
        return errorResult('tool_call requires a "name" argument');
      }

      if (name === TOOL_CALL_NAME) {
        return errorResult('tool_call cannot invoke itself (recursive bridge call)');
      }

      if (!isDeferrable(name)) {
        return errorResult(
          `'${name}' is not a deferrable tool. If it appears in the model-facing tools list already, call it directly instead of via tool_call.`,
        );
      }

      // Look up the real tool in the deferred catalog
      const realTool = deps.deferredCatalog.get(name);
      if (!realTool) {
        return errorResult(
          `'${name}' is not available in this session. Use tool_search to find tools you can call.`,
        );
      }

      // Delegate to the real tool's execute.
      // The real tool was created via AgentToolAdapterImpl.toAgentTool(),
      // so its execute wrapper contains beforeExecute/afterExecute policy hooks.
      // Those hooks fire for the REAL tool name (not "tool_call").
      try {
        const result = await realTool.execute(toolCallId, params.arguments ?? {}, signal, onUpdate);
        return result;
      } catch (err) {
        return errorResult(
          `Error executing '${name}': ${(err as Error).message}`,
        );
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the three bridge tools that replace deferred tools in the
 * model-facing tools array.
 *
 * The returned tools share the same deferredCatalog reference, so tool_call
 * can transparently delegate to the real tool at execution time.
 */
export function createBridgeTools(deps: BridgeToolDeps): AgentTool[] {
  return [
    createToolSearchTool(deps),
    createToolDescribeTool(deps),
    createToolCallTool(deps),
  ];
}
