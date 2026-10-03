/**
 * Tool capability registry — the single source of truth describing what each
 * built-in tool can do (file / network / shell access) and its default
 * approval level.
 *
 * Extracted from src/agent/before-tool-call.ts so the security-decision data
 * (approval risk levels, fail-closed defaults) can be unit-tested directly.
 * Consumers: before-tool-call hook (approval gating) and the approval risk
 * mapping shown on approval cards / used by the timeout guard.
 */
import type { ToolCapabilityDescriptor } from '../tools/platform/tool-capabilities.js';

/**
 * Capabilities registered at runtime (MCP tools and any other dynamic tool
 * source), keyed by exact tool name.
 *
 * Precedence inside {@link getCapabilityForTool} — first hit wins:
 *
 *   1. argument-dependent built-in rules (`send_message` external route,
 *      `cronjob remove`) — evaluated before any table lookup
 *   2. the static built-in table below
 *   3. this registry
 *   4. the fail-closed default (mutating / read_write)
 *
 * The static table deliberately keeps winning, so a runtime registration can
 * never silently weaken the approval requirements of a built-in tool —
 * registering a built-in name is a documented no-op.
 */
const registeredCapabilities = new Map<string, ToolCapabilityDescriptor>();

/**
 * Register (or replace) the capability of a dynamically provided tool — e.g. an
 * MCP tool whose server annotations were mapped to a descriptor.
 *
 * Idempotent: registering the same name twice keeps the last descriptor.
 * Precedence against the built-in table is documented in this module's header.
 */
export function registerToolCapability(
  toolName: string,
  capability: ToolCapabilityDescriptor,
): void {
  if (!toolName) throw new Error('registerToolCapability: toolName must be non-empty');
  registeredCapabilities.set(toolName, { ...capability });
}

/** Drop a runtime registration. Returns true when one existed (idempotent). */
export function unregisterToolCapability(toolName: string): boolean {
  return registeredCapabilities.delete(toolName);
}

/**
 * Read the runtime registration for a tool, ignoring built-ins.
 * Returns undefined when the tool was never registered dynamically.
 */
export function getRegisteredToolCapability(
  toolName: string,
): ToolCapabilityDescriptor | undefined {
  return registeredCapabilities.get(toolName);
}

/** Every runtime registration, for diagnostics and tests. */
export function listRegisteredToolCapabilities(): ReadonlyMap<string, ToolCapabilityDescriptor> {
  return registeredCapabilities;
}

export function getCapabilityForTool(toolName: string, args?: unknown): ToolCapabilityDescriptor {
  if (
    toolName === 'send_message' &&
    (args as { route?: string } | undefined)?.route === 'external'
  ) {
    return {
      category: 'task',
      readOnly: false,
      writesFiles: false,
      readsFiles: false,
      usesShell: false,
      usesNetwork: true,
      usesComputerUse: false,
      pathAccess: 'none',
      approvalDefault: 'high_risk',
    };
  }
  // cronjob remove action is destructive — requires approval
  if (toolName === 'cronjob' && (args as { action?: string } | undefined)?.action === 'remove') {
    return {
      category: 'cron',
      readOnly: false,
      writesFiles: false,
      readsFiles: false,
      usesShell: false,
      usesNetwork: false,
      usesComputerUse: false,
      pathAccess: 'none',
      approvalDefault: 'mutating',
    };
  }

  const map: Record<string, ToolCapabilityDescriptor> = {
    shell: {
      category: 'shell',
      readOnly: false,
      writesFiles: true,
      readsFiles: true,
      usesShell: true,
      usesNetwork: false,
      usesComputerUse: false,
      pathAccess: 'read_write',
      approvalDefault: 'mutating',
    },
    file_read: {
      category: 'file',
      readOnly: true,
      writesFiles: false,
      readsFiles: true,
      usesShell: false,
      usesNetwork: false,
      usesComputerUse: false,
      pathAccess: 'read',
      approvalDefault: 'none',
    },
    file_write: {
      category: 'file',
      readOnly: false,
      writesFiles: true,
      readsFiles: false,
      usesShell: false,
      usesNetwork: false,
      usesComputerUse: false,
      pathAccess: 'write',
      approvalDefault: 'mutating',
    },
    file_edit: {
      category: 'file',
      readOnly: false,
      writesFiles: true,
      readsFiles: true,
      usesShell: false,
      usesNetwork: false,
      usesComputerUse: false,
      pathAccess: 'read_write',
      approvalDefault: 'mutating',
    },
    file_search: {
      category: 'file',
      readOnly: true,
      writesFiles: false,
      readsFiles: true,
      usesShell: false,
      usesNetwork: false,
      usesComputerUse: false,
      pathAccess: 'read',
      approvalDefault: 'none',
    },
    memory_recall: {
      category: 'memory',
      readOnly: true,
      writesFiles: false,
      readsFiles: false,
      usesShell: false,
      usesNetwork: false,
      usesComputerUse: false,
      pathAccess: 'none',
      approvalDefault: 'none',
    },
    memory_store: {
      category: 'memory',
      readOnly: false,
      writesFiles: false,
      readsFiles: false,
      usesShell: false,
      usesNetwork: false,
      usesComputerUse: false,
      pathAccess: 'none',
      approvalDefault: 'mutating',
    },
    memory_list: {
      category: 'memory',
      readOnly: true,
      writesFiles: false,
      readsFiles: false,
      usesShell: false,
      usesNetwork: false,
      usesComputerUse: false,
      pathAccess: 'none',
      approvalDefault: 'none',
    },
    memory_delete: {
      category: 'memory',
      readOnly: false,
      writesFiles: false,
      readsFiles: false,
      usesShell: false,
      usesNetwork: false,
      usesComputerUse: false,
      pathAccess: 'none',
      approvalDefault: 'mutating',
    },
    memory_update: {
      category: 'memory',
      readOnly: false,
      writesFiles: false,
      readsFiles: false,
      usesShell: false,
      usesNetwork: false,
      usesComputerUse: false,
      pathAccess: 'none',
      approvalDefault: 'mutating',
    },
    session_summarize: {
      category: 'session',
      readOnly: true,
      writesFiles: false,
      readsFiles: false,
      usesShell: false,
      usesNetwork: false,
      usesComputerUse: false,
      pathAccess: 'none',
      approvalDefault: 'none',
    },
    web_fetch: {
      category: 'web',
      readOnly: true,
      writesFiles: false,
      readsFiles: false,
      usesShell: false,
      usesNetwork: true,
      usesComputerUse: false,
      pathAccess: 'none',
      approvalDefault: 'none',
    },
    web_search: {
      category: 'web',
      readOnly: true,
      writesFiles: false,
      readsFiles: false,
      usesShell: false,
      usesNetwork: true,
      usesComputerUse: false,
      pathAccess: 'none',
      approvalDefault: 'none',
    },
    image_to_text: {
      category: 'multimodal',
      readOnly: true,
      writesFiles: false,
      readsFiles: true,
      usesShell: false,
      usesNetwork: false,
      usesComputerUse: false,
      pathAccess: 'read',
      approvalDefault: 'none',
    },
    computer_use: {
      category: 'computer_use',
      readOnly: false,
      writesFiles: false,
      readsFiles: false,
      usesShell: false,
      usesNetwork: false,
      usesComputerUse: true,
      pathAccess: 'none',
      approvalDefault: 'high_risk',
    },
    spawn_agent: {
      category: 'agent',
      readOnly: false,
      writesFiles: false,
      readsFiles: false,
      usesShell: false,
      usesNetwork: false,
      usesComputerUse: false,
      pathAccess: 'none',
      approvalDefault: 'mutating',
    },
    cronjob: {
      category: 'cron',
      readOnly: false,
      writesFiles: false,
      readsFiles: false,
      usesShell: false,
      usesNetwork: false,
      usesComputerUse: false,
      pathAccess: 'none',
      approvalDefault: 'none',
    },
    ask_user_question: {
      category: 'session',
      readOnly: true,
      writesFiles: false,
      readsFiles: false,
      usesShell: false,
      usesNetwork: false,
      usesComputerUse: false,
      pathAccess: 'none',
      approvalDefault: 'none',
    },
    todo_write: {
      category: 'session',
      readOnly: false,
      writesFiles: false,
      readsFiles: false,
      usesShell: false,
      usesNetwork: false,
      usesComputerUse: false,
      pathAccess: 'none',
      approvalDefault: 'mutating',
    },
    task_create: {
      category: 'task',
      readOnly: false,
      writesFiles: false,
      readsFiles: false,
      usesShell: false,
      usesNetwork: false,
      usesComputerUse: false,
      pathAccess: 'none',
      approvalDefault: 'none',
    },
    task_get: {
      category: 'task',
      readOnly: true,
      writesFiles: false,
      readsFiles: false,
      usesShell: false,
      usesNetwork: false,
      usesComputerUse: false,
      pathAccess: 'none',
      approvalDefault: 'none',
    },
    task_list: {
      category: 'task',
      readOnly: true,
      writesFiles: false,
      readsFiles: false,
      usesShell: false,
      usesNetwork: false,
      usesComputerUse: false,
      pathAccess: 'none',
      approvalDefault: 'none',
    },
    task_stop: {
      category: 'task',
      readOnly: false,
      writesFiles: false,
      readsFiles: false,
      usesShell: false,
      usesNetwork: false,
      usesComputerUse: false,
      pathAccess: 'none',
      approvalDefault: 'none',
    },
    task_output: {
      category: 'task',
      readOnly: true,
      writesFiles: false,
      readsFiles: false,
      usesShell: false,
      usesNetwork: false,
      usesComputerUse: false,
      pathAccess: 'none',
      approvalDefault: 'none',
    },
    task_update: {
      category: 'task',
      readOnly: false,
      writesFiles: false,
      readsFiles: false,
      usesShell: false,
      usesNetwork: false,
      usesComputerUse: false,
      pathAccess: 'none',
      approvalDefault: 'none',
    },
    send_message: {
      category: 'task',
      readOnly: false,
      writesFiles: false,
      readsFiles: false,
      usesShell: false,
      usesNetwork: false,
      usesComputerUse: false,
      pathAccess: 'none',
      approvalDefault: 'none',
    },
    team_create: {
      category: 'task',
      readOnly: false,
      writesFiles: false,
      readsFiles: false,
      usesShell: false,
      usesNetwork: false,
      usesComputerUse: false,
      pathAccess: 'none',
      approvalDefault: 'mutating',
    },
    team_delete: {
      category: 'task',
      readOnly: false,
      writesFiles: false,
      readsFiles: false,
      usesShell: false,
      usesNetwork: false,
      usesComputerUse: false,
      pathAccess: 'none',
      approvalDefault: 'mutating',
    },
    enter_plan_mode: {
      category: 'session',
      readOnly: false,
      writesFiles: false,
      readsFiles: false,
      usesShell: false,
      usesNetwork: false,
      usesComputerUse: false,
      pathAccess: 'none',
      approvalDefault: 'none',
    },
    exit_plan_mode: {
      category: 'session',
      readOnly: false,
      writesFiles: false,
      readsFiles: false,
      usesShell: false,
      usesNetwork: false,
      usesComputerUse: false,
      pathAccess: 'none',
      approvalDefault: 'none',
    },
    enter_worktree: {
      category: 'session',
      readOnly: false,
      writesFiles: true,
      readsFiles: true,
      usesShell: true,
      usesNetwork: false,
      usesComputerUse: false,
      pathAccess: 'read_write',
      approvalDefault: 'mutating',
    },
    exit_worktree: {
      category: 'session',
      readOnly: false,
      writesFiles: true,
      readsFiles: true,
      usesShell: true,
      usesNetwork: false,
      usesComputerUse: false,
      pathAccess: 'read_write',
      approvalDefault: 'mutating',
    },
    // New v4 final tools
    notebook_edit: {
      category: 'file',
      readOnly: false,
      readsFiles: true,
      writesFiles: true,
      usesShell: false,
      usesNetwork: false,
      usesComputerUse: false,
      pathAccess: 'read_write',
      approvalDefault: 'mutating',
    },
    remote_trigger: {
      category: 'web',
      readOnly: false,
      writesFiles: false,
      readsFiles: false,
      usesShell: false,
      usesNetwork: true,
      usesComputerUse: false,
      pathAccess: 'none',
      approvalDefault: 'high_risk',
    },
    image_generation: {
      category: 'multimodal',
      readOnly: false,
      writesFiles: true,
      readsFiles: false,
      usesShell: false,
      usesNetwork: true,
      usesComputerUse: false,
      pathAccess: 'write',
      approvalDefault: 'mutating',
    },
    // Channel media tools
    feishu_send_media: {
      category: 'session',
      readOnly: false,
      writesFiles: false,
      readsFiles: true,
      usesShell: false,
      usesNetwork: true,
      usesComputerUse: false,
      pathAccess: 'read',
      approvalDefault: 'none',
    },
    wechat_send_media: {
      category: 'session',
      readOnly: false,
      writesFiles: false,
      readsFiles: true,
      usesShell: false,
      usesNetwork: true,
      usesComputerUse: false,
      pathAccess: 'read',
      approvalDefault: 'none',
    },
    qq_send_media: {
      category: 'session',
      readOnly: false,
      writesFiles: false,
      readsFiles: true,
      usesShell: false,
      usesNetwork: true,
      usesComputerUse: false,
      pathAccess: 'read',
      approvalDefault: 'none',
    },
    telegram_send_media: {
      category: 'session',
      readOnly: false,
      writesFiles: false,
      readsFiles: true,
      usesShell: false,
      usesNetwork: true,
      usesComputerUse: false,
      pathAccess: 'read',
      approvalDefault: 'none',
    },
    webui_send_media: {
      category: 'session',
      readOnly: true,
      writesFiles: false,
      readsFiles: true,
      usesShell: false,
      usesNetwork: false,
      usesComputerUse: false,
      pathAccess: 'read',
      approvalDefault: 'none',
    },
  };
  // Unknown tools default to mutating/approval-required (fail-closed):
  // new tools must be explicitly registered here before they run without approval.
  return (
    map[toolName] ??
    registeredCapabilities.get(toolName) ?? {
      category: 'session',
      readOnly: false,
      writesFiles: true,
      readsFiles: true,
      usesShell: false,
      usesNetwork: false,
      usesComputerUse: false,
      pathAccess: 'read_write',
      approvalDefault: 'mutating',
    }
  );
}
/**
 * Map a tool's declared capability onto the risk label shown on the approval
 * card and used by the timeout guard (only 'high' is protected from
 * `approval_timeout_action: allow`).
 */
export function approvalRiskForTool(toolName: string, args: unknown): 'low' | 'medium' | 'high' {
  const capability = getCapabilityForTool(toolName, args);
  if (capability.approvalDefault === 'high_risk' || capability.usesComputerUse) return 'high';
  if (capability.approvalDefault === 'mutating' || !capability.readOnly) return 'medium';
  return 'low';
}
