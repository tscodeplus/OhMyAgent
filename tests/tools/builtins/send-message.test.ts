// ---------------------------------------------------------------------------
// Tests for the send_message v4 ToolDefinition tool
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from 'vitest';
import { createSendMessageToolDefinition } from '../../../src/tools/builtins/tasks/send-message-definition.js';
import type { ToolExecutionContext } from '../../../src/tools/platform/tool-context.js';
import type { Orchestrator, AgentMessage } from '../../../src/orchestrator/types.js';
import { extractToolText, expectToolResultContains } from '../../helpers/tool-result.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(
  overrides?: Partial<ToolExecutionContext>,
  orchestrator?: Orchestrator,
): ToolExecutionContext {
  return {
    cwd: '/tmp',
    policyScope: { agentId: 'test' } as any,
    services: {
      orchestrator,
    } as any,
    ...overrides,
  };
}

function createMockOrchestrator(): {
  orchestrator: Orchestrator;
  sentMessages: AgentMessage[];
} {
  const sentMessages: AgentMessage[] = [];
  const orchestrator: Orchestrator = {
    sendMessage: vi.fn(async (input) => {
      const msg: AgentMessage = {
        id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        fromAgentId: input.fromAgentId,
        toAgentId: input.toAgentId,
        sessionId: input.sessionId,
        kind: input.kind,
        content: input.content,
        createdAt: Date.now(),
      };
      sentMessages.push(msg);

      if (input.kind === 'instruction' || input.kind === 'status' || input.kind === 'result') {
        // Internal: store in message log, no user visibility
        sentMessages.push(msg);
      } else {
        // External (question): store in message log
        sentMessages.push(msg);
      }
    }),
    spawnChildAgent: vi.fn() as any,
    stopAgent: vi.fn(),
    createTask: vi.fn() as any,
    listTasks: vi.fn() as any,
    getTask: vi.fn() as any,
    updateTask: vi.fn() as any,
    collectResults: vi.fn() as any,
    getAgentRun: vi.fn(),
    listAgentRuns: vi.fn(),
    getMessages: vi.fn(),
    routeApprovalToParent: vi.fn(),
    finishAgent: vi.fn(),
  };
  return { orchestrator, sentMessages };
}

// ===========================================================================
// send_message tool
// ===========================================================================

const sendMsgDef = createSendMessageToolDefinition();

describe('send_message', () => {
  it('returns error when orchestrator is not available', async () => {
    const ctx = makeCtx({}, undefined);
    const result = await sendMsgDef.execute(
      { toAgentId: 'agent-1', content: 'hello' },
      ctx,
    );
    expect(result.isError).toBe(true);
    expectToolResultContains(result, 'Orchestrator is not available');
  });

  it('sends an instruction message successfully', async () => {
    const { orchestrator } = createMockOrchestrator();
    const ctx = makeCtx({ agentId: 'sender-1', sessionId: 'session-1' }, orchestrator);

    const result = await sendMsgDef.execute(
      { toAgentId: 'agent-2', content: 'Please process this task', kind: 'instruction' },
      ctx,
    );

    expect(result.isError).toBeFalsy();
    expectToolResultContains(result, 'Message sent to agent "agent-2"');
    expect(orchestrator.sendMessage).toHaveBeenCalledWith({
      fromAgentId: 'sender-1',
      toAgentId: 'agent-2',
      sessionId: 'session-1',
      kind: 'instruction',
      content: 'Please process this task',
    });
  });

  it('sends a question message successfully', async () => {
    const { orchestrator } = createMockOrchestrator();
    const ctx = makeCtx({ agentId: 'sender-1', sessionId: 'session-1' }, orchestrator);

    const result = await sendMsgDef.execute(
      { toAgentId: 'agent-2', content: 'What do you think?', kind: 'question' },
      ctx,
    );

    expect(result.isError).toBeFalsy();
    expectToolResultContains(result, 'Message sent to agent "agent-2"');
    expect(orchestrator.sendMessage).toHaveBeenCalledWith({
      fromAgentId: 'sender-1',
      toAgentId: 'agent-2',
      sessionId: 'session-1',
      kind: 'question',
      content: 'What do you think?',
    });
  });

  it('defaults to instruction kind when not specified', async () => {
    const { orchestrator } = createMockOrchestrator();
    const ctx = makeCtx({ agentId: 'sender-1', sessionId: 'session-1' }, orchestrator);

    const result = await sendMsgDef.execute(
      { toAgentId: 'agent-2', content: 'Hello' },
      ctx,
    );

    expect(result.isError).toBeFalsy();
    expect(orchestrator.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'instruction' }),
    );
  });

  it('uses fallback agentId when ctx.agentId is missing', async () => {
    const { orchestrator } = createMockOrchestrator();
    const ctx = makeCtx({ sessionId: 'session-1' }, orchestrator);

    await sendMsgDef.execute(
      { toAgentId: 'agent-2', content: 'Hello', kind: 'status' },
      ctx,
    );

    expect(orchestrator.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ fromAgentId: 'primary' }),
    );
  });

  it('uses fallback sessionId when ctx.sessionId is missing', async () => {
    const { orchestrator } = createMockOrchestrator();
    const ctx = makeCtx({ agentId: 'sender-1' }, orchestrator);

    await sendMsgDef.execute(
      { toAgentId: 'agent-2', content: 'Hello', kind: 'status' },
      ctx,
    );

    expect(orchestrator.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'default' }),
    );
  });

  it('returns error when orchestrator.sendMessage throws', async () => {
    const orchestrator: Orchestrator = {
      sendMessage: vi.fn(async () => {
        throw new Error('Target agent "nonexistent" not found');
      }),
      spawnChildAgent: vi.fn() as any,
      stopAgent: vi.fn(),
      createTask: vi.fn() as any,
      listTasks: vi.fn() as any,
      getTask: vi.fn() as any,
      updateTask: vi.fn() as any,
      collectResults: vi.fn() as any,
      getAgentRun: vi.fn(),
      listAgentRuns: vi.fn(),
      getMessages: vi.fn(),
      routeApprovalToParent: vi.fn(),
      finishAgent: vi.fn(),
      registerRuntime: vi.fn(),
      unregisterRuntime: vi.fn(),
    };
    const ctx = makeCtx({ agentId: 'sender-1', sessionId: 'session-1' }, orchestrator);

    const result = await sendMsgDef.execute(
      { toAgentId: 'nonexistent', content: 'Hello' },
      ctx,
    );

    expect(result.isError).toBe(true);
    expectToolResultContains(result, 'Target agent "nonexistent" not found');
  });

  it('sends a result kind message', async () => {
    const { orchestrator } = createMockOrchestrator();
    const ctx = makeCtx({ agentId: 'sender-1', sessionId: 'session-1' }, orchestrator);

    const result = await sendMsgDef.execute(
      { toAgentId: 'agent-2', content: 'Task completed successfully', kind: 'result' },
      ctx,
    );

    expect(result.isError).toBeFalsy();
    expect(orchestrator.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'result', content: 'Task completed successfully' }),
    );
  });

  it('sends a status kind message', async () => {
    const { orchestrator } = createMockOrchestrator();
    const ctx = makeCtx({ agentId: 'sender-1', sessionId: 'session-1' }, orchestrator);

    const result = await sendMsgDef.execute(
      { toAgentId: 'agent-2', content: 'Processing...', kind: 'status' },
      ctx,
    );

    expect(result.isError).toBeFalsy();
    expect(orchestrator.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'status', content: 'Processing...' }),
    );
  });

  // ===========================================================================
  // F3: External route tests
  // ===========================================================================

  it('external route: returns error when targetChannel is missing', async () => {
    const { orchestrator } = createMockOrchestrator();
    const ctx = makeCtx({ agentId: 'sender-1', sessionId: 'session-1' }, orchestrator);

    const result = await sendMsgDef.execute(
      {
        toAgentId: 'user-1',
        content: 'Hello from agent',
        route: 'external',
        targetId: 'user-123',
        externalKind: 'message',
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expectToolResultContains(result, 'targetChannel');
  });

  it('external route: returns error when targetId is missing', async () => {
    const { orchestrator } = createMockOrchestrator();
    const ctx = makeCtx({ agentId: 'sender-1', sessionId: 'session-1' }, orchestrator);

    const result = await sendMsgDef.execute(
      {
        toAgentId: 'user-1',
        content: 'Hello from agent',
        route: 'external',
        targetChannel: 'feishu',
        externalKind: 'message',
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expectToolResultContains(result, 'targetId');
  });

  it('external route: returns error for unsupported channel', async () => {
    const { orchestrator } = createMockOrchestrator();
    const ctx = makeCtx({ agentId: 'sender-1', sessionId: 'session-1' }, orchestrator);

    const result = await sendMsgDef.execute(
      {
        toAgentId: 'user-1',
        content: 'Hello',
        route: 'external',
        targetChannel: 'slack' as any,
        targetId: 'user-123',
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expectToolResultContains(result, 'Unsupported external send channel');
  });

  it('external route: routes internal by default with no route field', async () => {
    const { orchestrator } = createMockOrchestrator();
    const ctx = makeCtx({ agentId: 'sender-1', sessionId: 'session-1' }, orchestrator);

    const result = await sendMsgDef.execute(
      {
        toAgentId: 'agent-2',
        content: 'internal msg',
        kind: 'instruction',
      },
      ctx,
    );

    expect(result.isError).toBeFalsy();
    expect(orchestrator.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'instruction', content: 'internal msg' }),
    );
  });

  it('external route: question with no route defaults to internal', async () => {
    const { orchestrator } = createMockOrchestrator();
    const ctx = makeCtx({ agentId: 'sender-1', sessionId: 'session-1' }, orchestrator);

    const result = await sendMsgDef.execute(
      {
        toAgentId: 'agent-2',
        content: 'question?',
        kind: 'question',
      },
      ctx,
    );

    expect(result.isError).toBeFalsy();
    expect(orchestrator.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'question' }),
    );
  });

  it('external route: returns error when external message sender not configured', async () => {
    const { orchestrator } = createMockOrchestrator();
    const ctx = makeCtx(
      {
        agentId: 'sender-1',
        sessionId: 'session-1',
        services: {
          orchestrator,
          policyCenter: undefined,
        } as any,
      },
      orchestrator,
    );

    const result = await sendMsgDef.execute(
      {
        toAgentId: 'user-1',
        content: 'Hello',
        route: 'external',
        targetChannel: 'feishu',
        targetId: 'user-123',
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expectToolResultContains(result, 'External message sender is not configured');
  });

  it('external route: successfully sends via external message sender', async () => {
    const mockSender = {
      send: vi.fn(async () => ({ messageId: 'ext-msg-1' })),
    };
    const { orchestrator } = createMockOrchestrator();
    const ctx = makeCtx(
      {
        agentId: 'sender-1',
        sessionId: 'session-1',
        services: {
          orchestrator,
          policyCenter: undefined,
          externalMessageSender: mockSender,
        } as any,
      },
      orchestrator,
    );

    const result = await sendMsgDef.execute(
      {
        toAgentId: 'user-1',
        content: 'Hello from agent',
        route: 'external',
        targetChannel: 'feishu',
        targetId: 'user-123',
        externalKind: 'message',
      },
      ctx,
    );

    expect(result.isError).toBeFalsy();
    expectToolResultContains(result, 'External message sent via feishu');
    expect(mockSender.send).toHaveBeenCalledWith({
      channel: 'feishu',
      targetId: 'user-123',
      content: 'Hello from agent',
      kind: 'message',
    });
  });

  it('external route: policyCenter deny blocks external send', async () => {
    const { orchestrator } = createMockOrchestrator();
    const mockPolicyCenter = {
      evaluateToolCall: vi.fn(async () => ({
        allowed: false,
        requiresApproval: false,
        reason: 'External send blocked by test policy',
      })),
    };
    const ctx = makeCtx(
      {
        agentId: 'sender-1',
        sessionId: 'session-1',
        services: {
          orchestrator,
          policyCenter: mockPolicyCenter,
        } as any,
      },
      orchestrator,
    );

    const result = await sendMsgDef.execute(
      {
        toAgentId: 'user-1',
        content: 'Hello',
        route: 'external',
        targetChannel: 'feishu',
        targetId: 'user-123',
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expectToolResultContains(result, 'blocked by test policy');
    expect(mockPolicyCenter.evaluateToolCall).toHaveBeenCalledOnce();
  });

  it('external route: policyCenter requiresApproval returns error message', async () => {
    const { orchestrator } = createMockOrchestrator();
    const mockPolicyCenter = {
      evaluateToolCall: vi.fn(async () => ({
        allowed: false,
        requiresApproval: true,
        reason: 'needs user approval',
      })),
    };
    const ctx = makeCtx(
      {
        agentId: 'sender-1',
        sessionId: 'session-1',
        services: {
          orchestrator,
          policyCenter: mockPolicyCenter,
        } as any,
      },
      orchestrator,
    );

    const result = await sendMsgDef.execute(
      {
        toAgentId: 'user-1',
        content: 'Hello',
        route: 'external',
        targetChannel: 'feishu',
        targetId: 'user-123',
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expectToolResultContains(result, 'requires user approval');
    expect(mockPolicyCenter.evaluateToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: expect.objectContaining({
          usesNetwork: true,
          approvalDefault: 'high_risk',
        }),
      }),
    );
    expect(mockPolicyCenter.evaluateToolCall).toHaveBeenCalledOnce();
  });

  it('external route: sends after runtime approval has already been handled', async () => {
    const mockSender = {
      send: vi.fn(async () => ({ messageId: 'ext-msg-1' })),
    };
    const mockPolicyCenter = {
      evaluateToolCall: vi.fn(async () => ({
        allowed: false,
        requiresApproval: true,
        reason: 'needs user approval',
      })),
    };
    const { orchestrator } = createMockOrchestrator();
    const ctx = makeCtx(
      {
        agentId: 'sender-1',
        sessionId: 'session-1',
        approvalAlreadyHandled: true,
        services: {
          orchestrator,
          policyCenter: mockPolicyCenter,
          externalMessageSender: mockSender,
        } as any,
      },
      orchestrator,
    );

    const result = await sendMsgDef.execute(
      {
        toAgentId: 'user-1',
        content: 'Hello',
        route: 'external',
        targetChannel: 'feishu',
        targetId: 'user-123',
      },
      ctx,
    );

    expect(result.isError).toBeFalsy();
    expectToolResultContains(result, 'External message sent via feishu');
    expect(mockSender.send).toHaveBeenCalledOnce();
  });

  it('external route: sender failure returns error', async () => {
    const mockSender = {
      send: vi.fn(async () => { throw new Error('Network error'); }),
    };
    const { orchestrator } = createMockOrchestrator();
    const ctx = makeCtx(
      {
        agentId: 'sender-1',
        sessionId: 'session-1',
        services: {
          orchestrator,
          policyCenter: undefined,
          externalMessageSender: mockSender,
        } as any,
      },
      orchestrator,
    );

    const result = await sendMsgDef.execute(
      {
        toAgentId: 'user-1',
        content: 'Hello',
        route: 'external',
        targetChannel: 'feishu',
        targetId: 'user-123',
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expectToolResultContains(result, 'Network error');
  });
});
