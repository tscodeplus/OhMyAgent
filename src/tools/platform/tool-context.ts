// ---------------------------------------------------------------------------
// v4 Tool Platform — execution context passed to every tool invocation
// ---------------------------------------------------------------------------

import type { AgentPolicyScope } from '../../policy/types.js';
import type { AppServices } from '../../app/types.js';

import { DEFAULT_POLICY_SCOPE } from '../../policy/types.js';

export interface ToolExecutionContext {
  sessionId?: string;
  messageId?: string;
  /**
   * Abort signal of the current agent run (set by the pi-mono loop). Tools
   * that spawn long-running work (e.g. shell commands) should honor it so a
   * /stop abort kills the child process instead of letting it run to its
   * own timeout.
   */
  signal?: AbortSignal;
  agentId?: string;
  parentAgentId?: string;
  skillId?: string;
  channel?: string;
  chatId?: string;
  /** WebUI project context — set from the session's project_id for project-scope memory writes. */
  projectId?: string;
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
    callTool(
      tool: string,
      args: unknown,
      timeoutMs: number,
    ): Promise<{ ok: boolean; data?: unknown; error?: string }>;
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
 * A gateway running natively on Windows is the exception: Windows paths are on
 * its own disk, so they stay local (and a missing one is simply missing).
 *
 * Paths that always stay on the gateway:
 *   /data/*, /proc/*, /sys/*, /dev/*, /etc/*, /system/*, /tmp/*
 *   Relative paths, ~/ paths, $HOME paths
 */
export function shouldRouteToDesktopBridge(filePath: string | undefined): boolean {
  if (!filePath) return false;

  const isWindowsPath = /^[A-Za-z]:[/\\]/.test(filePath) || filePath.startsWith('\\\\');

  // A native Windows gateway owns the Windows filesystem: `C:\...` and UNC
  // paths are local, so a missing one is "File not found" — never a bridge
  // target. The heuristic below exists for a gateway on another machine (WSL /
  // Termux / mobile) reaching a Windows desktop, where the path is not on the
  // gateway's own disk.
  if (isWindowsPath && process.platform === 'win32') return false;

  // Windows drive letter / UNC path: C:\..., E:\..., \\server\share
  if (isWindowsPath) return true;
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
