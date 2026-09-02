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
  query: Type.String({
    description:
      'Keywords describing the capability you need (e.g. "create github issue", "persona rebuild", "cron job")',
  }),
  limit: Type.Optional(
    Type.Integer({ description: 'Maximum number of results to return. Default 5.' }),
  ),
  /** Set to true to invoke the best-matching tool directly. Provide arguments for the tool. */
  invoke: Type.Optional(
    Type.Boolean({
      description: 'Set to true to execute the best-matching tool. Provide arguments below.',
    }),
  ),
  arguments: Type.Optional(
    Type.Record(Type.String(), Type.Any(), {
      description: 'Arguments for the tool when invoke=true. Leave empty for no-arg tools.',
    }),
  ),
});
type ToolSearchArgs = Static<typeof ToolSearchParams>;

const ToolDescribeParams = Type.Object({
  name: Type.String({ description: 'Exact tool name (as returned by tool_search)' }),
});
type ToolDescribeArgs = Static<typeof ToolDescribeParams>;

const ToolCallParams = Type.Object({
  name: Type.String({ description: 'Exact tool name to invoke' }),
  arguments: Type.Record(Type.String(), Type.Any(), {
    description: 'Arguments for the tool, matching its schema',
  }),
});
type ToolCallArgs = Static<typeof ToolCallParams>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Known schema keys for tool_search — any other keys are treated as forwarded tool arguments. */
const TOOL_SEARCH_OWN_KEYS = new Set(['query', 'limit', 'invoke', 'arguments']);
/** Known schema keys for tool_call. */
const TOOL_CALL_OWN_KEYS = new Set(['name', 'arguments']);

/**
 * Resolve forwarded arguments from bridge parameters.
 * If `arguments` is non-empty, use it directly.
 * Otherwise, extract any keys that are NOT the bridge's own schema keys
 * and treat them as the target tool's arguments — this handles the common
 * LLM pattern of flattening tool args into the bridge call.
 */
function resolveForwardedArgs(
  rawParams: Record<string, unknown>,
  ownKeys: Set<string>,
): Record<string, unknown> {
  const explicitArgs = rawParams.arguments as Record<string, unknown> | undefined;
  if (explicitArgs && Object.keys(explicitArgs).length > 0) {
    return explicitArgs;
  }
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rawParams)) {
    if (!ownKeys.has(key) && value !== undefined) {
      extra[key] = value;
    }
  }
  return extra;
}

/** Check if a tool has any required (non-optional) parameters. */
function hasRequiredParams(tool: AgentTool): boolean {
  try {
    const props = (tool.parameters as any)?.properties;
    if (!props || typeof props !== 'object') return false;
    const required = (tool.parameters as any)?.required as string[] | undefined;
    return Array.isArray(required) && required.length > 0;
  } catch {
    return false;
  }
}

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

function createToolSearchTool(deps: BridgeToolDeps, unlockedNames: Set<string>): AgentTool {
  return {
    name: TOOL_SEARCH_NAME,
    label: 'Tool Search',
    // 动态描述:解锁前保持原字符串逐字节不变(不破坏 prompt 缓存);
    // 一旦有工具被 tool_search/tool_call 解锁,提示模型直接按名调用。
    // getter 每次被读(每轮请求序列化 tools 时)实时求值,见
    // createBridgeTools 中共享的 unlockedNames 闭包。
    get description(): string {
      if (!deps.activated) {
        return 'Search available tools by name using exact match, substring, or regex pattern.';
      }
      if (unlockedNames.size > 0) {
        const unlocked = Array.from(unlockedNames).join(', ');
        const remaining = Array.from(deps.deferredCatalog.keys()).filter(
          (n) => !unlockedNames.has(n),
        );
        const remainingList =
          remaining.length > 0 ? remaining.join(', ') : '(none — all on-demand tools are unlocked)';
        return (
          `**Unlocked — call directly, do not search**: ${unlocked}. ` +
          `These tools are already in your tools list with full schemas; ` +
          `call them by name instead of tool_search. ` +
          `Remaining on-demand tools: ${remainingList}. ` +
          `Search them with query=keywords, or invoke=true + arguments={...} ` +
          `to call the best match in one step.`
        );
      }
      return (
        `**Search BEFORE using generic tools** — a specialized tool may already exist ` +
        `for tasks like creating skills, generating images, etc. ` +
        `${deps.deferredCatalog.size} on-demand tools available: ` +
        `${Array.from(deps.deferredCatalog.keys()).join(', ')}. ` +
        `Use query=keywords to search, or invoke=true + arguments={...} ` +
        `to call the best match in one step. You can also call these tools ` +
        `directly by name once you know them.`
      );
    },
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
      const scopeTools = deps.activated ? Array.from(deps.deferredCatalog.values()) : deps.allTools;

      // Build catalog and search
      const entries = scopeTools.map((t) => {
        let paramNames = '';
        try {
          const props = (t.parameters as any)?.properties;
          if (props && typeof props === 'object') paramNames = Object.keys(props).join(' ');
        } catch {
          /* ignore */
        }
        return {
          name: t.name,
          label: t.label ?? t.name,
          description: t.description ?? '',
          category: '',
          paramNames,
        };
      });

      const catalog = buildCatalog(entries);
      const hits = searchCatalog(catalog, query, clampedLimit);

      // ── invoke mode: auto-execute the best match ──
      if (params.invoke && hits.length > 0) {
        const bestName = hits[0]!.name;
        const realTool = deps.deferredCatalog.get(bestName);
        if (realTool) {
          // 行为矫正(已解锁工具):拒绝继续走 tool_search 执行,强制模型
          // 直接按名调用。描述引导已被验证对 deepseek 无效(路径依赖 >
          // 提示词),错误反馈是确定性的:模型收到错误后只能换路直接调用。
          // 纯搜索(非 invoke)不受影响——模型仍可搜索其他未解锁工具。
          if (unlockedNames.has(bestName)) {
            return errorResult(
              `'${bestName}' is UNLOCKED — it is already in your tools list ` +
                `with its full schema. Call '${bestName}' directly by name; ` +
                `tool_search no longer serves it.`,
            );
          }
          // 动态解锁(即时生效):取消 deferred 标志,该工具随后立即进入
          // 主工具列表(compactToolsForPrompt 只过滤仍带标志的工具)。
          (realTool as any).deferred = false;
          // 登记解锁集合:tool_search 的 description 据此提示模型直接调用。
          unlockedNames.add(bestName);
          try {
            const forwardedArgs = resolveForwardedArgs(
              params as unknown as Record<string, unknown>,
              TOOL_SEARCH_OWN_KEYS,
            );
            const hasRequiredArgs = hasRequiredParams(realTool);
            if (hasRequiredArgs && Object.keys(forwardedArgs).length === 0) {
              return errorResult(
                `'${bestName}' requires arguments but none were provided. ` +
                  `Use tool_describe(name="${bestName}") to see the required parameters, ` +
                  `then call tool_call(name="${bestName}", arguments={...}) with the correct values.`,
              );
            }
            const result = await realTool.execute(toolCallId, forwardedArgs, signal, onUpdate);
            return {
              content: [{ type: 'text', text: `[invoked ${bestName}] ` }, ...result.content],
              details: result.details,
              // 动态解锁:命中后该工具完整 schema 将追加到后续 LLM 请求
              // (见 openai-completions getDeferredToolNames),模型可直接
              // 按名调用,无需再次 tool_search。调用失败也解锁——失败
              // 往往因模型没见过完整参数,解锁后下次直接调用更容易成功。
              addedToolNames: [bestName],
            };
          } catch (err) {
            return {
              ...errorResult(`${bestName} failed: ${(err as Error).message}`),
              addedToolNames: [bestName],
            };
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

function createToolDescribeTool(deps: BridgeToolDeps, unlockedNames: Set<string>): AgentTool {
  return {
    name: TOOL_DESCRIBE_NAME,
    label: 'Tool Describe',
    description:
      'Load the full JSON schema for one tool returned by tool_search. ' +
      "Required before tool_call if the tool's parameters are unknown.",
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

      // Already unlocked — the full schema is in the model-facing tools list.
      if (unlockedNames.has(name)) {
        const tool = deps.deferredCatalog.get(name);
        return jsonResult({
          name: tool?.name ?? name,
          description: tool?.description,
          parameters: tool?.parameters,
          note: `'${name}' is UNLOCKED — it is already in your tools list with its full schema. Call it directly by name instead of via tool_describe/tool_call.`,
        });
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
        return errorResult(`'${name}' is not currently available. Re-run tool_search to refresh.`);
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

function createToolCallTool(deps: BridgeToolDeps, unlockedNames: Set<string>): AgentTool {
  return {
    name: TOOL_CALL_NAME,
    label: 'Tool Call',
    description:
      'Invoke a deferred tool by name with the given arguments. Argument shape ' +
      "matches the tool's schema (see tool_describe). Policy, hooks, and " +
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
      // 动态解锁(即时生效):与 tool_search invoke 一致,直接调用过的
      // 延迟工具取消 deferred 标志,进入主工具列表。
      (realTool as any).deferred = false;
      // 登记解锁集合:tool_search 的 description 据此提示模型直接调用。
      unlockedNames.add(name);

      // Delegate to the real tool's execute.
      // The real tool was created via AgentToolAdapterImpl.toAgentTool(),
      // so its execute wrapper contains beforeExecute/afterExecute policy hooks.
      // Those hooks fire for the REAL tool name (not "tool_call").
      try {
        const forwardedArgs = resolveForwardedArgs(
          params as unknown as Record<string, unknown>,
          TOOL_CALL_OWN_KEYS,
        );
        const result = await realTool.execute(toolCallId, forwardedArgs, signal, onUpdate);
        // 动态解锁:与 tool_search invoke 一致,直接调用过的延迟工具
        // 后续保持完整 schema 可见,模型可直接按名调用。
        return { ...result, addedToolNames: [name] };
      } catch (err) {
        return {
          ...errorResult(`Error executing '${name}': ${(err as Error).message}`),
          addedToolNames: [name],
        };
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
  // 已解锁工具集合(三桥共享闭包):tool_search invoke / tool_call 命中后
  // 登记;tool_search 的 description getter 据此动态提示模型直接按名调用。
  const unlockedNames = new Set<string>();
  return [
    createToolSearchTool(deps, unlockedNames),
    createToolDescribeTool(deps, unlockedNames),
    createToolCallTool(deps, unlockedNames),
  ];
}
