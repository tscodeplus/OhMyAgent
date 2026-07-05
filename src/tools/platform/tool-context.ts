// ---------------------------------------------------------------------------
// v4 Tool Platform — execution context passed to every tool invocation
// ---------------------------------------------------------------------------

import type { AgentPolicyScope } from '../../policy/types.js';
import type { AppServices } from '../../app/types.js';

import { DEFAULT_POLICY_SCOPE } from '../../policy/types.js';

export interface ToolExecutionContext {
  sessionId?: string;
  messageId?: string;
  agentId?: string;
  parentAgentId?: string;
  skillId?: string;
  channel?: string;
  chatId?: string;
  /**
   * Set by the Agent runtime when beforeToolCall approval handling is installed
   * for this invocation path. Tool adapters must not infer approval from the
   * mere presence of an ApprovalGate service.
   */
  approvalAlreadyHandled?: boolean;
  /** Canonical path approved by PolicyCenter for file tools. */
  resolvedPath?: string;
  cwd: string;
  policyScope: AgentPolicyScope;
  services: AppServices;
  /**
   * Desktop Bridge — when present, file_read / file_write / shell tools
   * should forward execution to the desktop machine via this bridge instead
   * of running locally on the gateway.
   */
  desktopBridge?: {
    callTool(tool: string, args: unknown, timeoutMs: number): Promise<{ ok: boolean; data?: unknown; error?: string }>;
  };
}

/**
 * Returns true when the given file path should be routed to the Desktop Bridge.
 *
 * Routing heuristics by platform:
 *   Windows desktop:  C:\\..., E:\\..., UNC paths
 *   macOS desktop:    /Users/...     (not present on Termux)
 *   Linux desktop:    /home/...      (Termux uses /data/data/com.termux/files/home)
 *
 * Paths that always stay on the gateway:
 *   /data/*, /proc/*, /sys/*, /dev/*, /etc/*, /system/*, /tmp/*
 *   Relative paths, ~/ paths, $HOME paths
 */
export function shouldRouteToDesktopBridge(filePath: string | undefined): boolean {
  if (!filePath) return false;
  // Windows drive letter: C:\..., E:\...
  if (/^[A-Za-z]:[/\\]/.test(filePath)) return true;
  // UNC path: \\server\share\...
  if (filePath.startsWith('\\\\')) return true;
  // macOS home directories
  if (filePath.startsWith('/Users/')) return true;
  // Linux desktop home directories (Termux home is under /data/, not /home/)
  if (filePath.startsWith('/home/')) return true;
  // All other absolute Linux paths likely belong to the gateway (Termux)
  // or are indistinguishable — execute locally.
  return false;
}

/** Build a minimal ToolExecutionContext from services + overrides. */
export function createToolContext(
  services: AppServices,
  overrides?: Partial<ToolExecutionContext>,
): ToolExecutionContext {
  return {
    cwd: process.cwd(),
    services,
    policyScope: DEFAULT_POLICY_SCOPE,
    ...overrides,
  };
}
