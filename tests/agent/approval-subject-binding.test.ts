/**
 * Generic tool approval: subject binding, risk derivation and the legacy
 * fail-open.
 *
 * Regression tests for three defects in before-tool-call.ts:
 *  - approve_session/approve_always was recorded under the bare tool name while
 *    the reuse lookup keys on tool + args, so one approval whitelisted every
 *    future call of that tool with ANY arguments;
 *  - risk was hardcoded 'medium', defeating the 'high'-only timeout guard in
 *    approval-store for tools whose capability declares approvalDefault:
 *    'high_risk';
 *  - the legacy (no PolicyCenter) branch allowed every non-shell tool ungated.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema } from '../../src/memory/schema';
import { ApprovalPolicyRepository } from '../../src/memory/repositories/approval-policy-repository';
import { SQLiteApprovalGate } from '../../src/tools/approval-gate';
import { PathAccessPolicyImpl } from '../../src/policy/path-policy';
import { ShellExecutionPolicyImpl } from '../../src/policy/shell/evaluator';
import { ToolVisibilityPolicyImpl } from '../../src/policy/tool-visibility';
import { ApprovalResolutionPolicyImpl } from '../../src/policy/approval/resolution';
import { AgentInheritancePolicyImpl } from '../../src/policy/inheritance/scope-merge';
import { PolicyCenterImpl } from '../../src/policy/policy-center';
import { createBeforeToolCall } from '../../src/agent/before-tool-call';
import { PendingApprovalStore } from '../../src/agent/approval-store';
import type { AgentPolicyScope } from '../../src/policy/types';
import type { ApprovalGate } from '../../src/app/types';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applySchema(db);
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

const policyScope: AgentPolicyScope = {
  toolsProfile: 'full',
  readRoots: [],
  writeRoots: [],
  deniedPatterns: [],
  shellExecMode: 'balanced',
  sessionApprovals: [],
  appApprovals: [],
  readOnly: false,
  computerUseEnabled: true,
  policyMode: 'balanced',
};

function makePolicyCenter(approvalGate: SQLiteApprovalGate) {
  const pathPolicy = new PathAccessPolicyImpl({
    readRoots: [],
    writeRoots: [],
    deniedPatterns: [],
  });
  return new PolicyCenterImpl({
    mode: 'balanced',
    toolVisibility: new ToolVisibilityPolicyImpl(),
    pathAccess: pathPolicy,
    shellExecution: new ShellExecutionPolicyImpl({ approvalGate }),
    approvalResolution: new ApprovalResolutionPolicyImpl({ approvalGate }),
    agentInheritance: new AgentInheritancePolicyImpl(),
  });
}

function makeLegacyGate(): ApprovalGate {
  return {
    evaluate: vi.fn(async () => 'requires_approval'),
    recordDecision: vi.fn(async () => undefined),
    getPolicy: vi.fn(async () => null),
  } as unknown as ApprovalGate;
}

describe('generic tool approval binds to the approved arguments', () => {
  it('reuses an approval only for the same tool + args, and reports high risk', async () => {
    const approvalGate = new SQLiteApprovalGate(new ApprovalPolicyRepository(db));
    const policyCenter = makePolicyCenter(approvalGate);
    const pendingApprovals = new PendingApprovalStore();
    vi.spyOn(pendingApprovals, 'create').mockResolvedValue('approve_session');

    const present = vi.fn(async () => 'msg-approval');
    const resolve = vi.fn(async () => undefined);
    const beforeToolCall = createBeforeToolCall({
      approvalGate: makeLegacyGate(),
      approvalPort: {
        getSession: () => ({ present, resolve }),
      } as any,
      approvalTimeoutMs: 30_000,
      pendingApprovals,
      sessionId: 'session-1',
      chatId: 'chat-1',
      resolvedSkillScope: { scope: 'global', scopeKey: '' },
      effectiveProfile: 'full',
      shellMode: 'full',
      channel: 'feishu',
      policyCenter,
      policyScope,
    });

    const first = { route: 'https://example.com/deploy-prod' };
    await expect(
      beforeToolCall({ toolCall: { name: 'remote_trigger' }, args: first }),
    ).resolves.toBeUndefined();

    // Capability says approvalDefault: 'high_risk' — the card must say so, or
    // approval-store's timeout guard (high only) would auto-approve it.
    expect(present).toHaveBeenCalledTimes(1);
    expect(present.mock.calls[0][0]).toEqual(
      expect.objectContaining({ command: `remote_trigger ${JSON.stringify(first)}`, risk: 'high' }),
    );

    // A different argument set is a different action — must NOT be free.
    await expect(
      beforeToolCall({
        toolCall: { name: 'remote_trigger' },
        args: { route: 'https://example.com/drop-tables' },
      }),
    ).resolves.toBeUndefined();
    expect(present).toHaveBeenCalledTimes(2);

    // The originally approved call is now reusable without a new card.
    await expect(
      beforeToolCall({ toolCall: { name: 'remote_trigger' }, args: first }),
    ).resolves.toBeUndefined();
    expect(present).toHaveBeenCalledTimes(2);
  });

  it('records the args-bound subject, not the bare tool name', async () => {
    const approvalGate = new SQLiteApprovalGate(new ApprovalPolicyRepository(db));
    const policyCenter = makePolicyCenter(approvalGate);
    const recordSpy = vi.spyOn(policyCenter, 'recordApprovalDecision');
    const pendingApprovals = new PendingApprovalStore();
    vi.spyOn(pendingApprovals, 'create').mockResolvedValue('approve_always');

    const beforeToolCall = createBeforeToolCall({
      approvalGate: makeLegacyGate(),
      approvalPort: {
        getSession: () => ({ present: async () => 'm', resolve: async () => {} }),
      } as any,
      approvalTimeoutMs: 30_000,
      pendingApprovals,
      sessionId: 'session-1',
      chatId: 'chat-1',
      resolvedSkillScope: { scope: 'global', scopeKey: '' },
      effectiveProfile: 'full',
      shellMode: 'full',
      channel: 'feishu',
      policyCenter,
      policyScope,
    });

    await beforeToolCall({ toolCall: { name: 'memory_delete' }, args: { id: 'mem-42' } });

    expect(recordSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: 'approve_always',
        kind: 'tool',
        subject: 'memory_delete {"id":"mem-42"}',
      }),
    );
  });
});

describe('legacy fallback without a PolicyCenter', () => {
  const legacyDeps = (overrides: Record<string, unknown> = {}) => ({
    approvalGate: makeLegacyGate(),
    approvalTimeoutMs: 30_000,
    pendingApprovals: new PendingApprovalStore(),
    sessionId: 'session-1',
    chatId: 'chat-1',
    resolvedSkillScope: { scope: 'global' as const, scopeKey: '' },
    effectiveProfile: 'full',
    shellMode: 'full' as const,
    channel: 'telegram' as const, // no approval sender → no interactive UI
    ...overrides,
  });

  it('blocks approval-requiring tools instead of allowing them silently', async () => {
    const beforeToolCall = createBeforeToolCall(legacyDeps());

    await expect(
      beforeToolCall({ toolCall: { name: 'memory_delete' }, args: { id: 'mem-1' } }),
    ).resolves.toEqual(expect.objectContaining({ block: true }));

    await expect(
      beforeToolCall({ toolCall: { name: 'remote_trigger' }, args: { route: 'x' } }),
    ).resolves.toEqual(expect.objectContaining({ block: true }));
  });

  it('still allows tools that declare no approval requirement', async () => {
    const beforeToolCall = createBeforeToolCall(legacyDeps());

    await expect(
      beforeToolCall({ toolCall: { name: 'web_search' }, args: { query: 'hi' } }),
    ).resolves.toBeUndefined();
    await expect(
      beforeToolCall({ toolCall: { name: 'file_read' }, args: { path: '/tmp/a.txt' } }),
    ).resolves.toBeUndefined();
  });
});
