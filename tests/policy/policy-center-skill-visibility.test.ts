/**
 * Skill tool allow/deny lists must reach the runtime visibility check.
 *
 * Regression test: PolicyCenter.evaluateToolCall called
 * toolVisibility.isVisible(toolName, policyScope) and dropped the third
 * `skillOverrides` parameter, so a skill declaring deniedTools: [shell] never
 * lost shell and allowedTools never widened anything.
 */

import { describe, it, expect, vi } from 'vitest';
import { PolicyCenterImpl, type ToolPolicyInputWithSkill } from '../../src/policy/policy-center';
import { ToolVisibilityPolicyImpl } from '../../src/policy/tool-visibility';
import type { AgentPolicyScope, ToolPolicyInput } from '../../src/policy/types';
import type { ToolCapabilityDescriptor } from '../../src/tools/platform/tool-capabilities';

function scope(overrides: Partial<AgentPolicyScope> = {}): AgentPolicyScope {
  return {
    toolsProfile: 'full',
    readRoots: [],
    writeRoots: [],
    deniedPatterns: [],
    shellExecMode: 'balanced',
    sessionApprovals: [],
    appApprovals: [],
    readOnly: false,
    computerUseEnabled: false,
    policyMode: 'balanced',
    ...overrides,
  };
}

const shellCapability: ToolCapabilityDescriptor = {
  category: 'shell',
  readOnly: false,
  writesFiles: true,
  readsFiles: true,
  usesShell: true,
  usesNetwork: false,
  usesComputerUse: false,
  pathAccess: 'read_write',
  approvalDefault: 'mutating',
};

const webCapability: ToolCapabilityDescriptor = {
  category: 'web',
  readOnly: false,
  writesFiles: false,
  readsFiles: false,
  usesShell: false,
  usesNetwork: true,
  usesComputerUse: false,
  pathAccess: 'none',
  approvalDefault: 'high_risk',
};

function makeCenter(visibility = new ToolVisibilityPolicyImpl()) {
  const center = new PolicyCenterImpl({
    mode: 'balanced',
    toolVisibility: visibility,
    pathAccess: { check: vi.fn(() => ({ allowed: true })) },
    shellExecution: {
      evaluate: vi.fn(async () => ({ allowed: true, requiresApproval: false, risk: 'low' })),
    },
    approvalResolution: {
      checkReuse: vi.fn(async () => ({ canReuse: false })),
      recordDecision: vi.fn(async () => undefined),
    },
    agentInheritance: { deriveChildScope: vi.fn((parent: AgentPolicyScope) => parent) },
  });
  return { center, visibility };
}

function shellInput(policyScope: AgentPolicyScope): ToolPolicyInput {
  return {
    toolName: 'shell',
    capability: shellCapability,
    args: { command: 'ls -la' },
    sessionId: 'session-1',
    agentId: 'agent-1',
    policyScope,
  };
}

describe('PolicyCenterImpl skill tool visibility enforcement', () => {
  it('hides a tool the active skill denies', async () => {
    const { center } = makeCenter();
    const input: ToolPolicyInputWithSkill = {
      ...shellInput(scope()),
      skillToolOverrides: { allowedTools: [], deniedTools: ['shell'] },
    };

    const decision = await center.evaluateToolCall(input);

    expect(decision.allowed).toBe(false);
    expect(decision.requiresApproval).toBe(false);
    expect(decision.reason).toContain('denied by the active skill');
  });

  it('still forwards skill overrides to a custom visibility policy', async () => {
    const spy = { isVisible: vi.fn(() => false) };
    const { center } = makeCenter(spy);
    const overrides = { allowedTools: ['web_search'], deniedTools: ['shell'] };

    await center.evaluateToolCall({
      ...shellInput(scope()),
      skillToolOverrides: overrides,
    });

    expect(spy.isVisible).toHaveBeenCalledWith('shell', scope(), overrides);
  });

  it('behaves unchanged when no skill overrides are present', async () => {
    const { center } = makeCenter();

    const decision = await center.evaluateToolCall(shellInput(scope()));

    expect(decision.allowed).toBe(true);
  });

  it('a skill allow-list widens a narrow profile, a deny-list narrows it', async () => {
    const { center } = makeCenter();
    const restricted = scope({ toolsProfile: 'restricted' });

    // remote_trigger is not in the restricted profile.
    await expect(
      center.evaluateToolCall({
        toolName: 'remote_trigger',
        capability: webCapability,
        args: { route: 'deploy' },
        sessionId: 'session-1',
        agentId: 'agent-1',
        policyScope: restricted,
      }),
    ).resolves.toMatchObject({ allowed: false });

    const granted = await center.evaluateToolCall({
      toolName: 'remote_trigger',
      capability: webCapability,
      args: { route: 'deploy' },
      sessionId: 'session-1',
      agentId: 'agent-1',
      policyScope: restricted,
      skillToolOverrides: { allowedTools: ['remote_trigger'] },
    });
    // Widened past visibility, but the high_risk capability still gates it.
    expect(granted.allowed).toBe(false);
    expect(granted.requiresApproval).toBe(true);
  });
  it('P1 strict mode: deny-first still wins over allowedTools and forced core', () => {
    const visibility = new ToolVisibilityPolicyImpl();
    const overrides = {
      strict: true,
      allowedTools: ['shell', 'ask_user_question'],
      deniedTools: ['shell'],
    };
    expect(visibility.isVisible('shell', scope(), overrides)).toBe(false);
    expect(visibility.isVisible('ask_user_question', scope(), overrides)).toBe(true);
    expect(visibility.isVisible('tool_search', scope(), overrides)).toBe(true); // forced core
  });
})
