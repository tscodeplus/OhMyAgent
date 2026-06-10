// ---------------------------------------------------------------------------
// v4 Policy Center — canonical type definitions
// ---------------------------------------------------------------------------

import type { ToolCapabilityDescriptor } from '../tools/platform/tool-capabilities.js';

// ---------------------------------------------------------------------------
// Agent policy scope
// ---------------------------------------------------------------------------

export type ToolProfileId = 'minimal' | 'standard' | 'advanced' | 'full';
export type ExecMode = 'safe' | 'balanced' | 'trusted';

export interface AgentPolicyScope {
  toolsProfile: ToolProfileId;
  readRoots: string[];
  writeRoots: string[];
  deniedPatterns: string[];
  shellExecMode: ExecMode;
  sessionApprovals: string[];
  appApprovals: string[];
  readOnly: boolean;
  computerUseEnabled: boolean;
}

export interface ChildAgentPolicyRequest {
  requestedToolsProfile?: ToolProfileId;
  requestedReadRoots?: string[];
  requestedWriteRoots?: string[];
  requestedReadOnly?: boolean;
  requestedComputerUse?: boolean;
}

/** Default runtime scope for tool-level hard checks when no per-agent scope is available. */
export const DEFAULT_POLICY_SCOPE: AgentPolicyScope = {
  toolsProfile: 'full',
  readRoots: [],
  writeRoots: [],
  deniedPatterns: [],
  shellExecMode: 'balanced',
  sessionApprovals: [],
  appApprovals: [],
  readOnly: false,
  computerUseEnabled: true,
};

// ---------------------------------------------------------------------------
// Tool policy
// ---------------------------------------------------------------------------

export interface ToolPolicyInput {
  toolName: string;
  capability: ToolCapabilityDescriptor;
  args: unknown;
  sessionId?: string;
  agentId?: string;
  skillId?: string;
  channel?: string;
  policyScope: AgentPolicyScope;
}

export type ApprovalKind = 'tool' | 'shell' | 'path' | 'computer_use_app' | 'computer_use_action';

export interface ToolPolicyDecision {
  allowed: boolean;
  requiresApproval: boolean;
  reason?: string;
  approvalKind?: ApprovalKind;
  resolvedPath?: string;
}

// ---------------------------------------------------------------------------
// Shell policy
// ---------------------------------------------------------------------------

export interface ShellPolicyInput {
  command: string;
  sessionId?: string;
  agentId?: string;
  scope: AgentPolicyScope;
}

export interface ShellPolicyDecision {
  allowed: boolean;
  requiresApproval: boolean;
  reason?: string;
  risk: 'low' | 'medium' | 'high';
}

// ---------------------------------------------------------------------------
// Path policy
// ---------------------------------------------------------------------------

export interface PathPolicyInput {
  path: string;
  operation: 'read' | 'write';
  sessionId?: string;
  agentId?: string;
  scope: AgentPolicyScope;
}

export interface PathPolicyDecision {
  allowed: boolean;
  reason?: string;
  resolvedPath?: string;
}

export interface PathPolicyConfig {
  readRoots: string[];
  writeRoots: string[];
  deniedPatterns: string[];
}

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------

import type { ApprovalDecisionType } from '../app/types.js';
export type { ApprovalDecisionType };

export interface ApprovalRequest {
  id: string;
  kind: ApprovalKind;
  subject: string;
  risk: 'low' | 'medium' | 'high';
  reason?: string;
  sessionId: string;
  agentId?: string;
  parentAgentId?: string;
}

export interface ApprovalDecisionRecord {
  requestId: string;
  decision: ApprovalDecisionType;
  scope: 'session' | 'agent' | 'global';
  kind: ApprovalKind;
  sessionId?: string;
  subject?: string;
  recordedAt: number;
  recordedBy?: string;
}

// ---------------------------------------------------------------------------
// Policy center interface
// ---------------------------------------------------------------------------

export interface PolicyCenter {
  evaluateToolCall(input: ToolPolicyInput): Promise<ToolPolicyDecision>;
  evaluateShellCommand(input: ShellPolicyInput): Promise<ShellPolicyDecision>;
  evaluatePathAccess(input: PathPolicyInput): PathPolicyDecision;
  inheritScope(parent: AgentPolicyScope, child: ChildAgentPolicyRequest): AgentPolicyScope;
  recordApprovalDecision(input: ApprovalDecisionRecord): Promise<void>;
}
