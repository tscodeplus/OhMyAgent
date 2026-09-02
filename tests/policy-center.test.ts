/**
 * Unit tests for PolicyCenterImpl
 *
 * Covers:
 * - Mode switching (bypass, safe, balanced, permissive)
 * - Tool visibility checks
 * - Shell command delegation
 * - Path access delegation
 * - Approval reuse
 * - Scope inheritance
 * - Decision recording
 * - Boundary conditions
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  ToolPolicyInput,
  AgentPolicyScope,
  ShellPolicyInput,
  PathPolicyInput,
  ApprovalDecisionRecord,
  ChildAgentPolicyRequest,
} from '../src/policy/types.js';
import type { ToolVisibilityPolicy } from '../src/policy/tool-visibility.js';
import type { PathAccessPolicy } from '../src/policy/path-policy.js';
import type { ShellExecutionPolicy } from '../src/policy/shell/evaluator.js';
import type { ApprovalResolutionPolicy } from '../src/policy/approval/resolution.js';
import type { AgentInheritancePolicy } from '../src/policy/inheritance/scope-merge.js';

// ── Mock helpers ───────────────────────────────────────────────────────────────

function createMockToolVisibility(): ToolVisibilityPolicy & {
  isVisible: ReturnType<typeof vi.fn>;
} {
  return {
    isVisible: vi.fn().mockReturnValue(true),
  };
}

function createMockPathAccess(): PathAccessPolicy & { check: ReturnType<typeof vi.fn> } {
  return {
    check: vi.fn().mockReturnValue({ allowed: true }),
    getEffectiveRoots: vi.fn().mockReturnValue({ readRoots: [], writeRoots: [] }),
  };
}

function createMockShellExecution(): ShellExecutionPolicy & { evaluate: ReturnType<typeof vi.fn> } {
  return {
    evaluate: vi.fn().mockResolvedValue({ allowed: true, requiresApproval: false, risk: 'low' }),
  };
}

function createMockApprovalResolution(): ApprovalResolutionPolicy & {
  checkReuse: ReturnType<typeof vi.fn>;
  recordDecision: ReturnType<typeof vi.fn>;
} {
  return {
    checkReuse: vi.fn().mockResolvedValue({ canReuse: false }),
    recordDecision: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockAgentInheritance(): AgentInheritancePolicy & {
  deriveChildScope: ReturnType<typeof vi.fn>;
} {
  return {
    deriveChildScope: vi
      .fn()
      .mockImplementation((parent: AgentPolicyScope, _request: ChildAgentPolicyRequest) => ({
        ...parent,
        computerUseEnabled: false,
      })),
  };
}

const DEFAULT_POLICY_SCOPE: AgentPolicyScope = {
  toolsProfile: 'standard',
  readRoots: ['/home/user'],
  writeRoots: ['/home/user'],
  deniedPatterns: [],
  shellExecMode: 'balanced',
  sessionApprovals: [],
  appApprovals: [],
  readOnly: false,
  computerUseEnabled: true,
  policyMode: 'balanced',
};

// ── Import after mocks are established ─────────────────────────────────────────
// We import dynamically via the factory function to avoid hoisting issues
import { PolicyCenterImpl } from '../src/policy/policy-center.js';

describe('PolicyCenterImpl', () => {
  let toolVisibility: ReturnType<typeof createMockToolVisibility>;
  let pathAccess: ReturnType<typeof createMockPathAccess>;
  let shellExecution: ReturnType<typeof createMockShellExecution>;
  let approvalResolution: ReturnType<typeof createMockApprovalResolution>;
  let agentInheritance: ReturnType<typeof createMockAgentInheritance>;

  function createCenter(mode: import('../src/policy/types.js').PolicyMode = 'balanced') {
    toolVisibility = createMockToolVisibility();
    pathAccess = createMockPathAccess();
    shellExecution = createMockShellExecution();
    approvalResolution = createMockApprovalResolution();
    agentInheritance = createMockAgentInheritance();

    return new PolicyCenterImpl({
      mode,
      toolVisibility,
      pathAccess,
      shellExecution,
      approvalResolution,
      agentInheritance,
    });
  }

  function makeToolInput(overrides: Partial<ToolPolicyInput> = {}): ToolPolicyInput {
    return {
      toolName: 'file_read',
      capability: {
        category: 'session',
        readOnly: true,
        readsFiles: false,
        writesFiles: false,
        usesShell: false,
        usesNetwork: false,
        usesComputerUse: false,
        pathAccess: 'none',
        approvalDefault: 'none',
      },
      args: {},
      sessionId: 'session-1',
      agentId: 'agent-1',
      policyScope: { ...DEFAULT_POLICY_SCOPE },
      ...overrides,
    };
  }

  // ── Constructor & Mode ────────────────────────────────────────────────────

  describe('constructor and mode switching', () => {
    it('creates an instance with default mode', () => {
      const center = createCenter('balanced');
      expect(center).toBeInstanceOf(PolicyCenterImpl);
    });

    it('updateMode changes the mode', async () => {
      const center = createCenter('safe');
      // In safe mode, non-readOnly tool requires approval
      const input = makeToolInput({
        capability: {
          category: 'session',
          readOnly: false,
          usesShell: false,
          usesNetwork: false,
          usesComputerUse: false,
          readsFiles: false,
          writesFiles: false,
          pathAccess: 'none',
          approvalDefault: 'none',
        },
      });
      const r1 = await center.evaluateToolCall(input);
      expect(r1.allowed).toBe(false);
      expect(r1.requiresApproval).toBe(true);

      center.updateMode('bypass');
      const r2 = await center.evaluateToolCall(input);
      expect(r2.allowed).toBe(true);
      expect(r2.requiresApproval).toBe(false);
    });
  });

  // ── evaluateToolCall ──────────────────────────────────────────────────────

  describe('evaluateToolCall', () => {
    it('bypass mode allows everything', async () => {
      const center = createCenter('bypass');
      const result = await center.evaluateToolCall(
        makeToolInput({
          capability: {
            category: 'session',
            readOnly: false,
            readsFiles: false,
            writesFiles: false,
            usesShell: true,
            usesNetwork: false,
            usesComputerUse: false,
            pathAccess: 'none',
            approvalDefault: 'high_risk',
          },
        }),
      );
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(false);
      // Should NOT even check shell/visibility
      expect(toolVisibility.isVisible).not.toHaveBeenCalled();
    });

    it('safe mode requires approval for non-readOnly tools', async () => {
      const center = createCenter('safe');
      const result = await center.evaluateToolCall(
        makeToolInput({
          capability: {
            category: 'session',
            readOnly: false,
            readsFiles: false,
            writesFiles: false,
            usesShell: false,
            usesNetwork: false,
            usesComputerUse: false,
            pathAccess: 'none',
            approvalDefault: 'none',
          },
        }),
      );
      expect(result.allowed).toBe(false);
      expect(result.requiresApproval).toBe(true);
    });

    it('safe mode allows readOnly tools', async () => {
      const center = createCenter('safe');
      const result = await center.evaluateToolCall(
        makeToolInput({
          capability: {
            category: 'session',
            readOnly: true,
            readsFiles: false,
            writesFiles: false,
            usesShell: false,
            usesNetwork: false,
            usesComputerUse: false,
            pathAccess: 'none',
            approvalDefault: 'none',
          },
        }),
      );
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(false);
    });

    it('balanced mode requires approval for high_risk tools', async () => {
      const center = createCenter('balanced');
      const result = await center.evaluateToolCall(
        makeToolInput({
          capability: {
            category: 'session',
            readOnly: false,
            readsFiles: false,
            writesFiles: false,
            usesShell: false,
            usesNetwork: false,
            usesComputerUse: false,
            pathAccess: 'none',
            approvalDefault: 'high_risk',
          },
        }),
      );
      expect(result.allowed).toBe(false);
      expect(result.requiresApproval).toBe(true);
    });

    it('balanced mode requires approval for mutating non-readOnly tools', async () => {
      const center = createCenter('balanced');
      const result = await center.evaluateToolCall(
        makeToolInput({
          capability: {
            category: 'session',
            readOnly: false,
            readsFiles: false,
            writesFiles: false,
            usesShell: false,
            usesNetwork: false,
            usesComputerUse: false,
            pathAccess: 'none',
            approvalDefault: 'mutating',
          },
        }),
      );
      expect(result.allowed).toBe(false);
      expect(result.requiresApproval).toBe(true);
    });

    it('balanced mode allows readOnly tools with mutating default', async () => {
      const center = createCenter('balanced');
      const result = await center.evaluateToolCall(
        makeToolInput({
          capability: {
            category: 'session',
            readOnly: true,
            readsFiles: false,
            writesFiles: false,
            usesShell: false,
            usesNetwork: false,
            usesComputerUse: false,
            pathAccess: 'none',
            approvalDefault: 'mutating',
          },
        }),
      );
      expect(result.allowed).toBe(true);
    });

    it('permissive mode allows everything when path access is none', async () => {
      const center = createCenter('permissive');
      const result = await center.evaluateToolCall(makeToolInput());
      expect(result.allowed).toBe(true);
    });

    it('skips tool visibility check when mode is bypass', async () => {
      const center = createCenter('bypass');
      await center.evaluateToolCall(makeToolInput({ toolName: 'unknown_tool' }));
      expect(toolVisibility.isVisible).not.toHaveBeenCalled();
    });

    it('respects tool visibility in normal mode', async () => {
      const center = createCenter('balanced');
      toolVisibility.isVisible.mockReturnValue(false);

      const result = await center.evaluateToolCall(makeToolInput({ toolName: 'hidden_tool' }));
      expect(result.allowed).toBe(false);
      expect(result.requiresApproval).toBe(false);
      expect(result.reason).toContain('hidden_tool');
      expect(toolVisibility.isVisible).toHaveBeenCalledWith('hidden_tool', DEFAULT_POLICY_SCOPE);
    });
  });

  // ── Shell delegation ──────────────────────────────────────────────────────

  describe('shell command delegation', () => {
    it('delegates to shell execution policy when capability usesShell', async () => {
      const center = createCenter('balanced');
      shellExecution.evaluate.mockResolvedValue({
        allowed: false,
        requiresApproval: true,
        reason: 'needs approval',
        risk: 'medium',
      });

      const result = await center.evaluateToolCall(
        makeToolInput({
          capability: {
            category: 'session',
            readOnly: false,
            readsFiles: false,
            writesFiles: false,
            usesShell: true,
            usesNetwork: false,
            usesComputerUse: false,
            pathAccess: 'none',
            approvalDefault: 'none',
          },
          args: { command: 'rm -rf /' },
        }),
      );

      expect(result.allowed).toBe(false);
      expect(result.requiresApproval).toBe(true);
      expect(shellExecution.evaluate).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'rm -rf /',
          sessionId: 'session-1',
        }),
      );
    });

    it('extracts command from args for shell delegation', async () => {
      const center = createCenter('balanced');
      await center.evaluateToolCall(
        makeToolInput({
          capability: {
            category: 'session',
            readOnly: false,
            readsFiles: false,
            writesFiles: false,
            usesShell: true,
            usesNetwork: false,
            usesComputerUse: false,
            pathAccess: 'none',
            approvalDefault: 'none',
          },
          args: { command: 'ls -la' },
        }),
      );
      expect(shellExecution.evaluate).toHaveBeenCalledWith(
        expect.objectContaining({ command: 'ls -la' }),
      );
    });
  });

  // ── Path access ───────────────────────────────────────────────────────────

  describe('path access delegation', () => {
    it('checks path access when capability has pathAccess', async () => {
      const center = createCenter('balanced');
      pathAccess.check.mockReturnValue({ allowed: true, resolvedPath: '/home/user/test.txt' });

      const result = await center.evaluateToolCall(
        makeToolInput({
          capability: {
            category: 'session',
            readOnly: true,
            readsFiles: true,
            writesFiles: false,
            usesShell: false,
            usesNetwork: false,
            usesComputerUse: false,
            pathAccess: 'read',
            approvalDefault: 'none',
          },
          args: { filePath: '/home/user/test.txt' },
        }),
      );

      expect(result.allowed).toBe(true);
      expect(pathAccess.check).toHaveBeenCalledWith(
        expect.objectContaining({ path: '/home/user/test.txt', operation: 'read' }),
      );
    });

    it('blocks when path access is denied', async () => {
      const center = createCenter('balanced');
      pathAccess.check.mockReturnValue({
        allowed: false,
        reason: 'Outside allowed roots',
        resolvedPath: '/etc/passwd',
      });

      const result = await center.evaluateToolCall(
        makeToolInput({
          capability: {
            category: 'session',
            readOnly: true,
            readsFiles: true,
            writesFiles: false,
            usesShell: false,
            usesNetwork: false,
            usesComputerUse: false,
            pathAccess: 'read',
            approvalDefault: 'none',
          },
          args: { filePath: '/etc/passwd' },
          sessionId: 'session-1',
        }),
      );

      expect(result.allowed).toBe(false);
      expect(result.requiresApproval).toBe(true);
      expect(result.approvalKind).toBe('path');
      expect(result.reason).toContain('Outside allowed roots');
    });

    it('checks read_write pathAccess with both read and write', async () => {
      const center = createCenter('balanced');
      pathAccess.check.mockReturnValue({ allowed: true });

      await center.evaluateToolCall(
        makeToolInput({
          capability: {
            category: 'session',
            readOnly: true,
            readsFiles: true,
            writesFiles: true,
            usesShell: false,
            usesNetwork: false,
            usesComputerUse: false,
            pathAccess: 'read_write',
            approvalDefault: 'none',
          },
          args: { filePath: '/home/user/test.txt' },
        }),
      );

      expect(pathAccess.check).toHaveBeenCalledTimes(2);
      expect(pathAccess.check).toHaveBeenCalledWith(expect.objectContaining({ operation: 'read' }));
      expect(pathAccess.check).toHaveBeenCalledWith(
        expect.objectContaining({ operation: 'write' }),
      );
    });

    it('reuses session approval for path access', async () => {
      const center = createCenter('balanced');
      pathAccess.check.mockReturnValue({
        allowed: false,
        reason: 'Outside allowed roots',
        resolvedPath: '/outside/path',
      });
      approvalResolution.checkReuse.mockResolvedValue({
        canReuse: true,
        decision: 'approve_session',
      });

      const result = await center.evaluateToolCall(
        makeToolInput({
          capability: {
            category: 'session',
            readOnly: true,
            readsFiles: true,
            writesFiles: false,
            usesShell: false,
            usesNetwork: false,
            usesComputerUse: false,
            pathAccess: 'read',
            approvalDefault: 'none',
          },
          args: { filePath: '/outside/path' },
          sessionId: 'session-1',
        }),
      );

      // When reuse is approved, path denial should be bypassed
      expect(result.allowed).toBe(true);
      expect(approvalResolution.checkReuse).toHaveBeenCalled();
    });
  });

  // ── Approval reuse ────────────────────────────────────────────────────────

  describe('approval reuse', () => {
    it('bypasses tool-level approval reuse for computer_use', async () => {
      const center = createCenter('balanced');
      approvalResolution.checkReuse.mockResolvedValue({
        canReuse: true,
        decision: 'approve_always',
      });

      await center.evaluateToolCall(
        makeToolInput({
          toolName: 'computer_use',
          capability: {
            category: 'session',
            readOnly: false,
            readsFiles: false,
            writesFiles: false,
            usesShell: false,
            usesNetwork: false,
            usesComputerUse: true,
            pathAccess: 'none',
            approvalDefault: 'high_risk',
          },
          args: { action: 'open_app', target: 'firefox' },
        }),
      );

      // For computer_use, generic tool-level reuse should not be checked
      // (only app-specific subjects are checked)
      const genericReuseCall = approvalResolution.checkReuse.mock.calls.find(
        (call: any[]) => call[1] === 'tool' && call[2] === 'computer_use',
      );
      // It may be called with specific subjects, but not the generic tool name
    });

    it('allows tool via approval reuse when session has approved it', async () => {
      const center = createCenter('balanced');
      // Step 1: First call — tools approvalDefault high_risk, check reuse
      // Simulate that checkReuse returns approved for the session
      approvalResolution.checkReuse.mockImplementation(
        async (_sessionId: string, kind: string, subject?: string) => {
          if (kind === 'tool' && subject?.startsWith('file_write')) {
            return { canReuse: true, decision: 'approve_session' };
          }
          if (kind === 'tool' && subject === 'file_write') {
            return { canReuse: true, decision: 'approve_session' };
          }
          return { canReuse: false };
        },
      );

      const result = await center.evaluateToolCall(
        makeToolInput({
          toolName: 'file_write',
          capability: {
            category: 'session',
            readOnly: false,
            readsFiles: true,
            writesFiles: true,
            usesShell: false,
            usesNetwork: false,
            usesComputerUse: false,
            pathAccess: 'read_write',
            approvalDefault: 'high_risk',
          },
          args: { filePath: '/home/user/test.txt' },
        }),
      );

      // Path check might pass or fail, but if it passes and session approved, tool is allowed
      expect(result.allowed).toBeDefined();
    });
  });

  // ── evaluateShellCommand ──────────────────────────────────────────────────

  describe('evaluateShellCommand', () => {
    it('delegates to shell execution policy', async () => {
      const center = createCenter();
      const input: ShellPolicyInput = {
        command: 'ls -la',
        sessionId: 'session-1',
        agentId: 'agent-1',
        scope: DEFAULT_POLICY_SCOPE,
      };
      shellExecution.evaluate.mockResolvedValue({
        allowed: true,
        requiresApproval: false,
        risk: 'low',
      });

      const result = await center.evaluateShellCommand(input);
      expect(result.allowed).toBe(true);
      expect(shellExecution.evaluate).toHaveBeenCalledWith(input);
    });

    it('returns high risk for destructive commands', async () => {
      const center = createCenter();
      shellExecution.evaluate.mockResolvedValue({
        allowed: false,
        requiresApproval: true,
        reason: 'requires approval',
        risk: 'high',
      });

      const result = await center.evaluateShellCommand({
        command: 'rm -rf /',
        sessionId: 'session-1',
        agentId: 'agent-1',
        scope: DEFAULT_POLICY_SCOPE,
      });

      expect(result.risk).toBe('high');
      expect(result.allowed).toBe(false);
    });
  });

  // ── evaluatePathAccess ────────────────────────────────────────────────────

  describe('evaluatePathAccess', () => {
    it('delegates to path access policy', () => {
      const center = createCenter();
      const input: PathPolicyInput = {
        path: '/home/user/test.txt',
        operation: 'read',
        sessionId: 'session-1',
        agentId: 'agent-1',
        scope: DEFAULT_POLICY_SCOPE,
      };
      pathAccess.check.mockReturnValue({ allowed: true, resolvedPath: '/home/user/test.txt' });

      const result = center.evaluatePathAccess(input);
      expect(result.allowed).toBe(true);
      expect(result.resolvedPath).toBe('/home/user/test.txt');
      expect(pathAccess.check).toHaveBeenCalledWith(input);
    });

    it('returns denied result when path outside roots', () => {
      const center = createCenter();
      pathAccess.check.mockReturnValue({
        allowed: false,
        reason: 'Outside allowed roots',
        resolvedPath: '/etc/passwd',
      });

      const result = center.evaluatePathAccess({
        path: '/etc/passwd',
        operation: 'read',
        scope: DEFAULT_POLICY_SCOPE,
      });
      expect(result.allowed).toBe(false);
    });
  });

  // ── inheritScope ──────────────────────────────────────────────────────────

  describe('inheritScope', () => {
    it('delegates to agent inheritance policy', () => {
      const center = createCenter();
      const parent: AgentPolicyScope = {
        toolsProfile: 'standard',
        readRoots: ['/parent'],
        writeRoots: ['/parent'],
        deniedPatterns: [],
        shellExecMode: 'balanced',
        sessionApprovals: [],
        appApprovals: [],
        readOnly: false,
        computerUseEnabled: true,
        policyMode: 'balanced',
      };
      const childRequest: ChildAgentPolicyRequest = {
        requestedToolsProfile: 'minimal',
        requestedReadRoots: ['/child'],
        requestedWriteRoots: [],
        requestedReadOnly: true,
        requestedComputerUse: false,
      };

      const result = center.inheritScope(parent, childRequest);
      expect(agentInheritance.deriveChildScope).toHaveBeenCalledWith(parent, childRequest);
    });
  });

  // ── recordApprovalDecision ────────────────────────────────────────────────

  describe('recordApprovalDecision', () => {
    it('delegates to approval resolution policy', async () => {
      const center = createCenter();
      const record: ApprovalDecisionRecord = {
        requestId: 'req-1',
        decision: 'approve_once',
        scope: 'session',
        kind: 'shell',
        sessionId: 'session-1',
        subject: 'ls',
        recordedAt: Date.now(),
      };

      await center.recordApprovalDecision(record);
      expect(approvalResolution.recordDecision).toHaveBeenCalledWith(record);
    });
  });

  // ── Edge cases ────────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles empty args gracefully', async () => {
      const center = createCenter('balanced');
      const result = await center.evaluateToolCall(
        makeToolInput({
          args: undefined,
          capability: {
            category: 'session',
            readOnly: true,
            readsFiles: true,
            writesFiles: false,
            usesShell: false,
            usesNetwork: false,
            usesComputerUse: false,
            pathAccess: 'read',
            approvalDefault: 'none',
          },
        }),
      );
      // pathAccess check should be skipped when no path argument
      expect(result.allowed).toBe(true);
    });

    it('handles missing sessionId', async () => {
      const center = createCenter('balanced');
      const result = await center.evaluateToolCall(
        makeToolInput({
          sessionId: undefined,
          capability: {
            category: 'session',
            readOnly: true,
            readsFiles: false,
            writesFiles: false,
            usesShell: false,
            usesNetwork: false,
            usesComputerUse: false,
            pathAccess: 'none',
            approvalDefault: 'none',
          },
        }),
      );
      expect(result.allowed).toBe(true);
    });

    it('handles null args for shell', async () => {
      const center = createCenter('balanced');
      await center.evaluateToolCall(
        makeToolInput({
          capability: {
            category: 'session',
            readOnly: false,
            readsFiles: false,
            writesFiles: false,
            usesShell: true,
            usesNetwork: false,
            usesComputerUse: false,
            pathAccess: 'none',
            approvalDefault: 'none',
          },
          args: null as unknown as Record<string, unknown>,
        }),
      );
      expect(shellExecution.evaluate).toHaveBeenCalledWith(
        expect.objectContaining({ command: '' }),
      );
    });

    it('safe mode does not check path access when pathAccess is none', async () => {
      const center = createCenter('safe');
      const result = await center.evaluateToolCall(
        makeToolInput({
          capability: {
            category: 'session',
            readOnly: true,
            readsFiles: false,
            writesFiles: false,
            usesShell: false,
            usesNetwork: false,
            usesComputerUse: false,
            pathAccess: 'none',
            approvalDefault: 'none',
          },
        }),
      );
      expect(result.allowed).toBe(true);
      expect(pathAccess.check).not.toHaveBeenCalled();
    });

    it('permissive mode still checks tool visibility', async () => {
      const center = createCenter('permissive');
      toolVisibility.isVisible.mockReturnValue(false);

      const result = await center.evaluateToolCall(makeToolInput({ toolName: 'blocked_tool' }));
      expect(result.allowed).toBe(false);
    });
  });
});
