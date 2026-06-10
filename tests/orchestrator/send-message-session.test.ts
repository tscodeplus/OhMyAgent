import { describe, expect, it, vi } from 'vitest';
import { InMemoryAgentRunStore } from '../../src/orchestrator/agent-run-store';
import { InMemoryTaskRunStore } from '../../src/orchestrator/task-run-store';
import { OrchestratorImpl } from '../../src/orchestrator/orchestrator';
import { DEFAULT_POLICY_SCOPE } from '../../src/policy/types';

function makeOrchestrator(agentRunStore = new InMemoryAgentRunStore()) {
  return new OrchestratorImpl({
    agentRunStore,
    taskRunStore: new InMemoryTaskRunStore(),
    permissionInheritance: { deriveChildScope: vi.fn(() => DEFAULT_POLICY_SCOPE) },
    approvalStateSync: { routeApproval: vi.fn(async () => undefined) },
    policyCenter: {} as any,
    agentFactory: {} as any,
    agentManager: {} as any,
    pendingApprovals: {} as any,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
  });
}

describe('OrchestratorImpl.sendMessage session boundaries', () => {
  it('rejects messages when the target agent is outside the requested session', async () => {
    const agentRunStore = new InMemoryAgentRunStore();
    agentRunStore.create({
      agentId: 'target',
      rootSessionId: 'session-b',
      role: 'child',
      scope: DEFAULT_POLICY_SCOPE,
      prompt: '',
    });
    const orchestrator = makeOrchestrator(agentRunStore);

    await expect(orchestrator.sendMessage({
      fromAgentId: 'primary',
      toAgentId: 'target',
      sessionId: 'session-a',
      kind: 'instruction',
      content: 'hello',
    })).rejects.toThrow('Cross-session messaging is not allowed');
  });

  it('stores messages when sender, target, and requested session match', async () => {
    const agentRunStore = new InMemoryAgentRunStore();
    agentRunStore.create({
      agentId: 'sender',
      rootSessionId: 'session-a',
      role: 'primary',
      scope: DEFAULT_POLICY_SCOPE,
      prompt: '',
    });
    agentRunStore.create({
      agentId: 'target',
      rootSessionId: 'session-a',
      role: 'child',
      scope: DEFAULT_POLICY_SCOPE,
      prompt: '',
    });
    const orchestrator = makeOrchestrator(agentRunStore);

    await orchestrator.sendMessage({
      fromAgentId: 'sender',
      toAgentId: 'target',
      sessionId: 'session-a',
      kind: 'instruction',
      content: 'hello',
    });

    expect(orchestrator.getMessages('target')).toHaveLength(1);
  });
});
