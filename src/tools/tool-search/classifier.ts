// ---------------------------------------------------------------------------
// Tool classifier — core vs deferrable tool split
// ---------------------------------------------------------------------------
//
// Core tools are NEVER deferred regardless of config. This list is the
// single source of truth; any tool not listed here is eligible for deferral
// (provided it also passes isDeferrable's other gates).
//
// Design invariant:
//   Unknown/unresolvable tool names must NEVER be classified as deferrable.
//   Otherwise tools not in the registry get silently dropped.

import type { AgentTool } from '../../pi-mono/agent/types.js';

// ---------------------------------------------------------------------------
// Bridge tool names — reserved, never deferrable
// ---------------------------------------------------------------------------

export const TOOL_SEARCH_NAME = 'tool_search';
export const TOOL_DESCRIBE_NAME = 'tool_describe';
export const TOOL_CALL_NAME = 'tool_call';

export const BRIDGE_TOOL_NAMES: ReadonlySet<string> = new Set([
  TOOL_SEARCH_NAME,
  TOOL_DESCRIBE_NAME,
  TOOL_CALL_NAME,
]);

// ---------------------------------------------------------------------------
// Core tool whitelist — 23 tools that are never deferred
// ---------------------------------------------------------------------------

export const CORE_TOOL_NAMES: ReadonlySet<string> = new Set([
  // 文件系统 (6)
  'file_read', 'file_write', 'file_edit', 'file_search',
  'glob', 'grep',
  // Shell (2)
  'shell', 'sleep',
  // Web (1)
  'web_search',
  // 任务管理 (6)
  'task_create', 'task_get', 'task_list', 'task_update',
  'task_output', 'task_stop',
  // 记忆核心 (2)
  'memory-recall', 'memory-store',
  // 会话控制 (5)
  'todo_write', 'tool_search', 'ask_user_question',
  'send_message', 'feishu_send_media',
  // 配置 (1)
  'config',
]);

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Return true if a tool with the given name is eligible for deferral.
 *
 * A tool is deferrable iff:
 * 1. It is NOT in ``CORE_TOOL_NAMES`` (core tools never defer).
 * 2. It is NOT a bridge tool itself (recursive bridge is nonsense).
 */
export function isDeferrable(toolName: string): boolean {
  if (!toolName) return false;
  if (CORE_TOOL_NAMES.has(toolName)) return false;
  if (BRIDGE_TOOL_NAMES.has(toolName)) return false;
  // Any other tool is deferrable (MCP, plugin, or unknown).
  // Unknown tools reaching here is fine — classifyTools will keep
  // unknown tools in 'visible' because isDeferrable returning true
  // does not guarantee it will be deferred; the caller decides.
  return true;
}

/**
 * Split a tool list into (visible, deferrable) pairs.
 *
 * ``visible`` retains every tool that must stay in the model-facing array:
 * core tools and any tool we cannot classify. ``deferrable`` is the
 * candidate set for deferred loading.
 *
 * Bridge tools in the input are left in ``visible`` (they are non-deferrable
 * by definition). The caller (assembleTools) is responsible for stripping
 * them before classification.
 */
export function classifyTools(
  tools: AgentTool[],
): { visible: AgentTool[]; deferrable: AgentTool[] } {
  const visible: AgentTool[] = [];
  const deferrable: AgentTool[] = [];

  for (const t of tools) {
    if (isDeferrable(t.name)) {
      deferrable.push(t);
    } else {
      visible.push(t);
    }
  }

  return { visible, deferrable };
}
