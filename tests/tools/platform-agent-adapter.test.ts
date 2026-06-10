import { describe, expect, it, vi } from 'vitest';
import { AgentToolAdapterImpl } from '../../src/tools/platform/agent-tool-adapter';
import { ToolPlatformRegistryImpl } from '../../src/tools/platform/registry';
import { ToolRegistryImpl } from '../../src/tools/registry';
import { createToolSearchToolDefinition } from '../../src/tools/builtins/session/tool-search-definition';
import { createFileWriteToolDefinition } from '../../src/tools/builtins/files/write-definition';
import type { PolicyCenter } from '../../src/policy/types';
import { extractToolText } from '../helpers/tool-result';

describe('AgentToolAdapterImpl', () => {
  it('injects runtime services into ToolDefinition execution', async () => {
    const legacyRegistry = new ToolRegistryImpl();
    let platformRegistry: ToolPlatformRegistryImpl;
    const adapter = new AgentToolAdapterImpl({
      getServices: () => ({ toolPlatformRegistry: platformRegistry } as any),
    });
    platformRegistry = new ToolPlatformRegistryImpl(legacyRegistry, adapter);
    platformRegistry.registerDefinition(createToolSearchToolDefinition());

    const tool = legacyRegistry.get('tool_search');
    expect(tool).toBeDefined();

    const result = await tool!.execute('call-1', {});
    expect(extractToolText(result)).toContain('tool_search');
  });

  it('blocks hard policy denials in the adapter path', async () => {
    const policyCenter = {
      evaluateToolCall: vi.fn(async () => ({
        allowed: false,
        requiresApproval: false,
        reason: 'blocked by test policy',
      })),
    } as unknown as PolicyCenter;

    const adapter = new AgentToolAdapterImpl({ policyCenter });
    const tool = adapter.toAgentTool(createFileWriteToolDefinition());

    const result = await tool.execute('call-1', {
      filePath: '/tmp/blocked.txt',
      content: 'blocked',
    });

    expect(extractToolText(result)).toContain('blocked by test policy');
    expect(policyCenter.evaluateToolCall).toHaveBeenCalledOnce();
  });

  // F3: Approval invariants
  it('blocks tool when requiresApproval and no approval gate configured', async () => {
    const policyCenter = {
      evaluateToolCall: vi.fn(async () => ({
        allowed: false,
        requiresApproval: true,
        reason: 'needs approval',
      })),
    } as unknown as PolicyCenter;

    const adapter = new AgentToolAdapterImpl({ policyCenter });
    const tool = adapter.toAgentTool(createFileWriteToolDefinition());

    const result = await tool.execute('call-1', {
      filePath: '/tmp/test.txt',
      content: 'test',
    });

    expect(extractToolText(result)).toContain('blocked');
    expect(policyCenter.evaluateToolCall).toHaveBeenCalledOnce();
  });

  it('allows execution when policyCenter returns allowed', async () => {
    const policyCenter = {
      evaluateToolCall: vi.fn(async () => ({
        allowed: true,
        requiresApproval: false,
      })),
    } as unknown as PolicyCenter;

    const adapter = new AgentToolAdapterImpl({ policyCenter });
    const tool = adapter.toAgentTool(createFileWriteToolDefinition());

    const result = await tool.execute('call-1', {
      filePath: '/tmp/test.txt',
      content: 'test',
    });

    expect(result.isError).toBeFalsy();
    expect(policyCenter.evaluateToolCall).toHaveBeenCalledOnce();
  });

  it('throws on requiresApproval when approvalGate is absent from services', async () => {
    const policyCenter = {
      evaluateToolCall: vi.fn(async () => ({
        allowed: false,
        requiresApproval: true,
        reason: 'needs approval',
      })),
    } as unknown as PolicyCenter;

    const adapter = new AgentToolAdapterImpl({
      policyCenter,
      getServices: () => ({}) as any,
    });
    const tool = adapter.toAgentTool(createFileWriteToolDefinition());

    const result = await tool.execute('call-1', {
      filePath: '/tmp/test.txt',
      content: 'test',
    });

    expect(extractToolText(result)).toContain('blocked');
    expect(extractToolText(result)).toContain('requires approval');
    expect(policyCenter.evaluateToolCall).toHaveBeenCalledOnce();
  });

  it('does not treat a configured approvalGate as proof of approval', async () => {
    const policyCenter = {
      evaluateToolCall: vi.fn(async () => ({
        allowed: false,
        requiresApproval: true,
        reason: 'needs approval',
      })),
    } as unknown as PolicyCenter;

    const adapter = new AgentToolAdapterImpl({
      policyCenter,
      getServices: () => ({ approvalGate: {} }) as any,
    });
    const tool = adapter.toAgentTool(createFileWriteToolDefinition());

    const result = await tool.execute('call-1', {
      filePath: '/tmp/test.txt',
      content: 'test',
    });

    expect(extractToolText(result)).toContain('requires approval before execution');
    expect(policyCenter.evaluateToolCall).toHaveBeenCalledOnce();
  });

  it('allows requiresApproval only when runtime approval handling is marked complete', async () => {
    const policyCenter = {
      evaluateToolCall: vi.fn(async () => ({
        allowed: false,
        requiresApproval: true,
        reason: 'needs approval',
      })),
    } as unknown as PolicyCenter;

    const adapter = new AgentToolAdapterImpl({
      policyCenter,
      getContextOverrides: () => ({ approvalAlreadyHandled: true }),
    });
    const tool = adapter.toAgentTool(createFileWriteToolDefinition());

    const result = await tool.execute('call-1', {
      filePath: '/tmp/adapter-approval-handled.txt',
      content: 'test',
    });

    expect(extractToolText(result)).toContain('Successfully wrote');
    expect(policyCenter.evaluateToolCall).toHaveBeenCalledOnce();
  });
});
