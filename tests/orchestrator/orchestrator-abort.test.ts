// ---------------------------------------------------------------------------
// Tests for OrchestratorImpl — real agent abort (F4)
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OrchestratorImpl } from '../../src/orchestrator/orchestrator.js';
import { InMemoryAgentRunStore } from '../../src/orchestrator/agent-run-store.js';
import { InMemoryTaskRunStore } from '../../src/orchestrator/task-run-store.js';
import type { ManagedAgentRuntime, AgentRun } from '../../src/orchestrator/types.js';
import { DEFAULT_POLICY_SCOPE } from '../../src/policy/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createOrchestrator() {
  const agentRunStore = new InMemoryAgentRunStore();
  const taskRunStore = new InMemoryTaskRunStore();

  const orchestrator = new OrchestratorImpl({
    agentRunStore,
    taskRunStore,
    permissionInheritance: {
      deriveChildScope: vi.fn((parent, child) => ({
        ...parent,
        ...child,
      })),
    } as any,
    approvalStateSync: {
      routeApproval: vi.fn(),
    } as any,
    policyCenter: {} as any,
    agentFactory: {} as any,
    agentManager: {} as any,
    pendingApprovals: {} as any,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as any,
  });

  return { orchestrator, agentRunStore };
}

function createMockRuntime(agentId: string, sessionId: string = 'session-1'): ManagedAgentRuntime {
  return {
    agentId,
    sessionId,
    abort: vi.fn(),
    waitForIdle: vi.fn(async () => {}),
  };
}

function createAgentRun(store: InMemoryAgentRunStore, agentId: string, sessionId: string = 'session-1'): AgentRun {
  return store.create({
    agentId,
    rootSessionId: sessionId,
    role: 'primary',
    scope: DEFAULT_POLICY_SCOPE,
    prompt: '',
  });
}

// ===========================================================================
// Tests
// ===========================================================================

describe('OrchestratorImpl - Agent Abort (F4)', () => {
  let ctx: ReturnType<typeof createOrchestrator>;

  beforeEach(() => {
    ctx = createOrchestrator();
  });

  describe('registerRuntime / unregisterRuntime', () => {
    it('registers a runtime and allows stopAgent to abort it', async () => {
      const runtime = createMockRuntime('agent-1');
      ctx.orchestrator.registerRuntime(runtime);

      await ctx.orchestrator.stopAgent('agent-1');

      expect(runtime.abort).toHaveBeenCalledOnce();
      expect(runtime.waitForIdle).toHaveBeenCalledOnce();
    });

    it('unregisterRuntime removes runtime from the map', async () => {
      const runtime = createMockRuntime('agent-1');
      ctx.orchestrator.registerRuntime(runtime);
      ctx.orchestrator.unregisterRuntime('agent-1');

      // Runtime was unregistered — abort should NOT be called
      await ctx.orchestrator.stopAgent('agent-1');
      expect(runtime.abort).not.toHaveBeenCalled();
    });

    it('unregisters runtime after stopAgent completes', async () => {
      const runtime = createMockRuntime('agent-1');
      ctx.orchestrator.registerRuntime(runtime);

      await ctx.orchestrator.stopAgent('agent-1');

      // Calling stopAgent again should not call abort again (already unregistered)
      await ctx.orchestrator.stopAgent('agent-1');
      expect(runtime.abort).toHaveBeenCalledTimes(1);
    });
  });

  describe('stopAgent - real abort', () => {
    it('aborts agent and updates status to stopped', async () => {
      createAgentRun(ctx.agentRunStore, 'agent-1');
      const runtime = createMockRuntime('agent-1');
      ctx.orchestrator.registerRuntime(runtime);

      await ctx.orchestrator.stopAgent('agent-1');

      expect(runtime.abort).toHaveBeenCalledOnce();
      expect(runtime.waitForIdle).toHaveBeenCalledOnce();
      const agentRun = ctx.orchestrator.getAgentRun('agent-1');
      expect(agentRun?.status).toBe('stopped');
      expect(agentRun?.finishedAt).toBeDefined();
    });

    it('handles stopAgent when no runtime is registered (graceful fallback)', async () => {
      createAgentRun(ctx.agentRunStore, 'agent-2');
      // No runtime registered, just status update
      await ctx.orchestrator.stopAgent('agent-2');

      const agentRun = ctx.orchestrator.getAgentRun('agent-2');
      expect(agentRun?.status).toBe('stopped');
    });

    it('does not hang if waitForIdle takes too long (10s timeout)', async () => {
      vi.useFakeTimers();
      try {
        const runtime: ManagedAgentRuntime = {
          agentId: 'agent-slow',
          sessionId: 'session-1',
          abort: vi.fn(),
          waitForIdle: vi.fn(async () => {
            // Never resolves naturally
            await new Promise(() => {});
          }),
        };
        ctx.orchestrator.registerRuntime(runtime);

        // Start the stopAgent call (it will be blocked on waitForIdle)
        const stopPromise = ctx.orchestrator.stopAgent('agent-slow');

        // Advance time past the 10s timeout
        await vi.advanceTimersByTimeAsync(11_000);

        await expect(stopPromise).resolves.toBeUndefined();
        expect(runtime.abort).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('finishAgent - cleanup', () => {
    it('unregisters runtime on finishAgent', async () => {
      const runtime = createMockRuntime('agent-3');
      ctx.orchestrator.registerRuntime(runtime);

      await ctx.orchestrator.finishAgent('agent-3', 'completed');

      // After finishAgent, runtime should be unregistered
      // Calling stopAgent should not invoke abort
      await ctx.orchestrator.stopAgent('agent-3');
      expect(runtime.abort).not.toHaveBeenCalled();
    });
  });

  describe('stopAgent idempotency', () => {
    it('multiple stopAgent calls are safe', async () => {
      createAgentRun(ctx.agentRunStore, 'agent-1');
      const runtime = createMockRuntime('agent-1');
      ctx.orchestrator.registerRuntime(runtime);

      await ctx.orchestrator.stopAgent('agent-1');
      await ctx.orchestrator.stopAgent('agent-1');
      await ctx.orchestrator.stopAgent('agent-1');

      // abort should only be called once (first call unregisters)
      expect(runtime.abort).toHaveBeenCalledTimes(1);
      const agentRun = ctx.orchestrator.getAgentRun('agent-1');
      expect(agentRun?.status).toBe('stopped');
    });

    it('normal completion + stop is safe', async () => {
      const runtime = createMockRuntime('agent-1');
      ctx.orchestrator.registerRuntime(runtime);

      // Normal completion
      await ctx.orchestrator.finishAgent('agent-1', 'completed');

      // Then stop (should be no-op since runtime was unregistered)
      await ctx.orchestrator.stopAgent('agent-1');
      expect(runtime.abort).not.toHaveBeenCalled();
    });

    it('stop after normal completion is safe', async () => {
      createAgentRun(ctx.agentRunStore, 'agent-1');
      const runtime = createMockRuntime('agent-1');
      ctx.orchestrator.registerRuntime(runtime);
      await ctx.orchestrator.finishAgent('agent-1', 'completed');

      await ctx.orchestrator.stopAgent('agent-1');
      const agentRun = ctx.orchestrator.getAgentRun('agent-1');
      expect(agentRun?.status).toBe('stopped');
    });
  });
});
