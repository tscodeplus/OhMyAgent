// ---------------------------------------------------------------------------
// v4 PolicyCenter — concrete implementation
// ---------------------------------------------------------------------------

import type {
  PolicyCenter,
  ToolPolicyInput,
  ToolPolicyDecision,
  ShellPolicyInput,
  ShellPolicyDecision,
  PathPolicyInput,
  PathPolicyDecision,
  AgentPolicyScope,
  ChildAgentPolicyRequest,
  ApprovalDecisionRecord,
} from './types.js';
import type { ToolVisibilityPolicy } from './tool-visibility.js';
import type { PathAccessPolicy } from './path-policy.js';
import type { ShellExecutionPolicy } from './shell/evaluator.js';
import type { ApprovalResolutionPolicy } from './approval/resolution.js';
import type { AgentInheritancePolicy } from './inheritance/scope-merge.js';
import {
  computerUseApprovalSubject,
  computerUseApprovalSubjectCandidates,
} from '../computer-use/app-approval-subject.js';

export { type PolicyCenter } from './types.js';

// ─── Dependencies ───────────────────────────────────────────────────────────

export interface PolicyCenterDeps {
  toolVisibility: ToolVisibilityPolicy;
  pathAccess: PathAccessPolicy;
  shellExecution: ShellExecutionPolicy;
  approvalResolution: ApprovalResolutionPolicy;
  agentInheritance: AgentInheritancePolicy;
}

// ─── Implementation ─────────────────────────────────────────────────────────

export class PolicyCenterImpl implements PolicyCenter {
  private toolVisibility: ToolVisibilityPolicy;
  private pathAccess: PathAccessPolicy;
  private shellExecution: ShellExecutionPolicy;
  private approvalResolution: ApprovalResolutionPolicy;
  private agentInheritance: AgentInheritancePolicy;

  constructor(deps: PolicyCenterDeps) {
    this.toolVisibility = deps.toolVisibility;
    this.pathAccess = deps.pathAccess;
    this.shellExecution = deps.shellExecution;
    this.approvalResolution = deps.approvalResolution;
    this.agentInheritance = deps.agentInheritance;
  }

  // ── evaluateToolCall ────────────────────────────────────────────────────

  async evaluateToolCall(input: ToolPolicyInput): Promise<ToolPolicyDecision> {
    let resolvedPath: string | undefined;

    // 1. Tool visibility check
    if (!this.toolVisibility.isVisible(input.toolName, input.policyScope)) {
      return {
        allowed: false,
        requiresApproval: false,
        reason: `Tool "${input.toolName}" is not available in profile "${input.policyScope.toolsProfile}"`,
      };
    }

    // 2. If tool uses shell, delegate to shell execution policy
    if (input.capability.usesShell) {
      const shellInput: ShellPolicyInput = {
        command: typeof (input.args as any)?.command === 'string'
          ? (input.args as any).command
          : '',
        sessionId: input.sessionId,
        agentId: input.agentId,
        scope: input.policyScope,
      };
      return this.evaluateShellCommand(shellInput);
    }

    // 3. If tool reads/writes files, check path access
    if (input.capability.pathAccess !== 'none') {
      const path = extractPathArgument(input.args);

      if (path) {
        const operations = input.capability.pathAccess === 'read_write'
          ? ['read', 'write'] as const
          : [input.capability.pathAccess] as const;

        for (const operation of operations) {
          const pathDecision = this.pathAccess.check({
            path,
            operation,
            sessionId: input.sessionId,
            agentId: input.agentId,
            scope: input.policyScope,
          });
          resolvedPath = pathDecision.resolvedPath ?? resolvedPath;

          if (!pathDecision.allowed) {
            if (input.sessionId) {
              const reuse = await this.approvalResolution.checkReuse(
                input.sessionId,
                'path',
                pathApprovalSubject(input.toolName, path),
              );
              if (reuse.canReuse && reuse.decision?.startsWith('approve')) {
                continue;
              }
            }
            return {
              allowed: false,
              requiresApproval: true,
              reason: pathDecision.reason ?? `Path access denied: ${path}`,
              approvalKind: 'path',
              resolvedPath,
            };
          }
        }
      }
    }

    // 4. Check approval reuse
    if (input.sessionId) {
      const subjects = approvalSubjects(input.toolName, input.args);
      for (const subject of subjects) {
        const reuse = await this.approvalResolution.checkReuse(
          input.sessionId,
          'tool',
          subject,
        );
        if (reuse.canReuse && reuse.decision?.startsWith('approve')) {
          return { allowed: true, requiresApproval: false, resolvedPath };
        }
      }
      // Skip generic tool-level approval reuse for computer_use: app-specific
      // subjects are generated above, and a blanket "computer_use" allow must
      // not bypass per-app approval checks.
      if (input.toolName !== 'computer_use' && !subjects.includes(input.toolName)) {
        const toolReuse = await this.approvalResolution.checkReuse(
          input.sessionId,
          'tool',
          input.toolName,
        );
        if (toolReuse.canReuse && toolReuse.decision?.startsWith('approve')) {
          return { allowed: true, requiresApproval: false, resolvedPath };
        }
      }
    }

    // 5. Default based on capability
    if (input.capability.approvalDefault === 'high_risk') {
      return {
        allowed: false,
        requiresApproval: true,
        approvalKind: input.capability.usesComputerUse ? 'computer_use_action' : 'tool',
        resolvedPath,
      };
    }

    if (input.capability.approvalDefault === 'mutating' && !input.capability.readOnly) {
      return {
        allowed: false,
        requiresApproval: true,
        approvalKind: 'tool',
        resolvedPath,
      };
    }

    return { allowed: true, requiresApproval: false, resolvedPath };
  }

  // ── evaluateShellCommand ────────────────────────────────────────────────

  async evaluateShellCommand(input: ShellPolicyInput): Promise<ShellPolicyDecision> {
    return this.shellExecution.evaluate(input);
  }

  // ── evaluatePathAccess ──────────────────────────────────────────────────

  evaluatePathAccess(input: PathPolicyInput): PathPolicyDecision {
    return this.pathAccess.check(input);
  }

  // ── inheritScope ────────────────────────────────────────────────────────

  inheritScope(parent: AgentPolicyScope, child: ChildAgentPolicyRequest): AgentPolicyScope {
    return this.agentInheritance.deriveChildScope(parent, child);
  }

  // ── recordApprovalDecision ─────────────────────────────────────────────

  async recordApprovalDecision(input: ApprovalDecisionRecord): Promise<void> {
    await this.approvalResolution.recordDecision(input);
  }
}

function extractPathArgument(args: unknown): string | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const record = args as Record<string, unknown>;
  for (const key of ['filePath', 'path', 'directory', 'imagePath', 'audioPath', 'cwd', 'outputPath', 'outputDir']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function approvalSubjects(toolName: string, args: unknown): string[] {
  if (toolName === 'computer_use' && args && typeof args === 'object') {
    const record = args as Record<string, unknown>;
    if (
      typeof record.action === 'string'
      && ['open_app', 'focus_app', 'close_app'].includes(record.action)
      && typeof record.target === 'string'
      && record.target.trim()
    ) {
      return computerUseApprovalSubjectCandidates(record.action, record.target);
    }
  }

  return [approvalSubject(toolName, args)];
}

function approvalSubject(toolName: string, args: unknown): string {
  if (toolName === 'computer_use' && args && typeof args === 'object') {
    const record = args as Record<string, unknown>;
    if (
      typeof record.action === 'string'
      && ['open_app', 'focus_app', 'close_app'].includes(record.action)
      && typeof record.target === 'string'
      && record.target.trim()
    ) {
      return computerUseApprovalSubject(record.action, record.target);
    }
  }

  const pathArg = extractPathArgument(args);
  if (pathArg) return `${toolName} ${pathArg}`;
  return `${toolName} ${JSON.stringify(args ?? {})}`;
}

function pathApprovalSubject(toolName: string, path: string): string {
  return `${toolName}:${path}`;
}
