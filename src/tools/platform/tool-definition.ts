// ---------------------------------------------------------------------------
// v4 Tool Platform — ToolDefinition canonical type
// ---------------------------------------------------------------------------

import type { ToolCapabilityDescriptor } from './tool-capabilities.js';
import type { ToolExecutionContext } from './tool-context.js';
import type { ToolExecutionResult } from './tool-result.js';

// ---------------------------------------------------------------------------
// ToolCategory
// ---------------------------------------------------------------------------

export type ToolCategory =
  | 'shell'
  | 'file'
  | 'web'
  | 'multimodal'
  | 'memory'
  | 'task'
  | 'agent'
  | 'config'
  | 'session'
  | 'cron'
  | 'computer_use';

// ---------------------------------------------------------------------------
// ToolDefinition
// ---------------------------------------------------------------------------

export interface ToolDefinition<TArgs = unknown> {
  name: string;
  label: string;
  description: string;
  category: ToolCategory;
  parametersSchema: unknown;
  capability: ToolCapabilityDescriptor;
  /**
   * Whether this tool may be deferred (loaded on-demand via Tool Search).
   * - `true` — explicitly deferrable (MCP/plugin tools)
   * - `false` — explicitly non-deferrable (force core)
   * - `undefined` — auto-classified by name against CORE_TOOL_NAMES
   */
  deferrable?: boolean;
  execute(args: TArgs, ctx: ToolExecutionContext): Promise<ToolExecutionResult>;
}

/** Tool metadata for registry introspection (no execute/schema). */
export interface ToolMeta {
  name: string;
  label: string;
  category: ToolCategory;
  capability: ToolCapabilityDescriptor;
}

/** Extract metadata from a ToolDefinition. */
export function toToolMeta(def: ToolDefinition): ToolMeta {
  return { name: def.name, label: def.label, category: def.category, capability: def.capability };
}
