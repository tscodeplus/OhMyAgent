/**
 * E2E Integration Test: Approval Flow
 *
 * Tests the approval gate integration: shell command -> approval gate -> approval/denial
 * Uses real database and real approval gate, tests the component integration directly.
 * Also tests the full agent factory integration with beforeToolCall hook.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Agent } from '../../src/pi-mono/agent/agent.js';
import { EventBridge } from '../../src/agent/event-bridge.js';
import { createAgentFactory } from '../../src/agent/agent-factory.js';
import { createFeishuApprovalUiPort } from '../../extensions/channel-feishu/render/approval-ui-port-feishu.js';
import { createToolRegistry } from '../../src/tools/registry.js';
import { SQLiteApprovalGate } from '../../src/tools/approval-gate.js';
import { ApprovalPolicyRepository } from '../../src/memory/repositories/approval-policy-repository.js';
import { normalizeCommand } from '../../src/tools/shell-command-policy.js';
import type { ApprovalRequest } from '../../src/app/types.js';
import {
  createTestDatabase,
  makeTestConfig,
  makeMockTool,
  createMockDispatcher,
  createMockFeishuClient,
  createToolCallStreamFn,
} from './helpers.js';
import type Database from 'better-sqlite3';

// Mock pi-ai-setup to avoid real provider lookups
vi.mock('../../src/provider/pi-ai-setup.js', () => ({
  getDefaultModel: vi.fn(() => ({
    id: 'test-model',
    name: 'Test Model',
    api: 'openai-completions',
    provider: 'test-provider',
    baseUrl: '',
    reasoning: false,
    input: [],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 4096,
    maxTokens: 2048,
  })),
}));

// Mock approval card renderer (imported dynamically in agent-factory)
vi.mock('../../extensions/channel-feishu/render/approval-card-renderer.js', () => ({
  renderApprovalCard: vi.fn((request: any) => ({
    schema: '2.0',
    elements: [
      {
        tag: 'action',
        actions: [
          { tag: 'button', value: { action: 'approve_once', requestId: request.id } },
          { tag: 'button', value: { action: 'reject_once', requestId: request.id } },
        ],
      },
    ],
  })),
  renderApprovalQueueCard: vi.fn(() => ({
    elements: [],
  })),
  assessCommandRisk: vi.fn(() => 'medium'),
}));

function makeShellRequest(rawCommand: string, scope = 'global'): ApprovalRequest {
  const command = normalizeCommand(rawCommand);
  return {
    kind: 'shell',
    command,
    sessionKey: 'test-session',
    scope: scope as any,
  };
}

describe('E2E: Approval Flow', () => {
  let db: Database.Database;
  let policyRepo: ApprovalPolicyRepository;
  let approvalGate: SQLiteApprovalGate;

  beforeEach(() => {
    db = createTestDatabase();
    policyRepo = new ApprovalPolicyRepository(db);
    approvalGate = new SQLiteApprovalGate(policyRepo);
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  // ─── Approval Gate: require_approval policy ──────────────────────────────

  it('approval gate evaluates require_approval policy correctly', async () => {
    policyRepo.create({
      id: 'pol-1',
      scope: 'global',
      scope_key: '',
      target_kind: 'shell',
      pattern_type: 'prefix',
      pattern: 'adb install',
      effect: 'require_approval',
    });

    const result = await approvalGate.evaluate(makeShellRequest('adb install app.apk'));
    expect(result).toBe('requires_approval');
  });

  // ─── Approval Gate: deny policy ──────────────────────────────────────────

  it('approval gate evaluates deny policy correctly', async () => {
    policyRepo.create({
      id: 'pol-2',
      scope: 'global',
      scope_key: '',
      target_kind: 'shell',
      pattern_type: 'prefix',
      pattern: 'adb shell rm',
      effect: 'deny',
    });

    const result = await approvalGate.evaluate(makeShellRequest('adb shell rm -rf /data'));
    expect(result).toBe('rejected');
  });

  // ─── Approval Gate: allow policy ─────────────────────────────────────────

  it('approval gate evaluates allow policy correctly', async () => {
    policyRepo.create({
      id: 'pol-3',
      scope: 'global',
      scope_key: '',
      target_kind: 'shell',
      pattern_type: 'prefix',
      pattern: 'adb devices',
      effect: 'allow',
    });

    const result = await approvalGate.evaluate(makeShellRequest('adb devices'));
    expect(result).toBe('approved');
  });

  // ─── Approval Gate: no matching policy defaults to require_approval ──────

  it('no matching policy defaults to require_approval', async () => {
    const result = await approvalGate.evaluate(makeShellRequest('ls -la'));
    expect(result).toBe('requires_approval');
  });

  // ─── Approval Gate: deny takes priority over allow ───────────────────────

  it('deny takes priority over allow (more specific pattern wins)', async () => {
    policyRepo.create({
      id: 'pol-allow',
      scope: 'global',
      scope_key: '',
      target_kind: 'shell',
      pattern_type: 'prefix',
      pattern: 'adb',
      effect: 'allow',
    });
    policyRepo.create({
      id: 'pol-deny',
      scope: 'global',
      scope_key: '',
      target_kind: 'shell',
      pattern_type: 'prefix',
      pattern: 'adb shell rm',
      effect: 'deny',
    });

    const result = await approvalGate.evaluate(makeShellRequest('adb shell rm -rf /data'));
    expect(result).toBe('rejected');
  });

  // ─── Agent Factory: no approval gate ─────────────────────────────────────

  it('factory without approval gate — agent has no beforeToolCall hook', () => {
    const registry = createToolRegistry();
    registry.register(makeMockTool('shell'));
    const factory = createAgentFactory({ config: makeTestConfig(), toolRegistry: registry });
    const agent = factory.create();
    expect(agent.beforeToolCall).toBeUndefined();
  });

  // ─── Agent Factory: approval gate present ────────────────────────────────

  it('factory with approval gate — agent has beforeToolCall hook', () => {
    const registry = createToolRegistry();
    registry.register(makeMockTool('shell'));
    const feishuClient = createMockFeishuClient();
    const factory = createAgentFactory(
      { config: makeTestConfig(), toolRegistry: registry },
      { approvalGate, feishuClient },
    );
    const agent = factory.create();
    expect(agent.beforeToolCall).toBeDefined();
  });

  // ─── Agent Factory: non-shell tool bypasses ──────────────────────────────

  it('non-shell tool bypasses approval check', async () => {
    const registry = createToolRegistry();
    registry.register(makeMockTool('file_read'));
    const feishuClient = createMockFeishuClient();
    const factory = createAgentFactory(
      { config: makeTestConfig(), toolRegistry: registry },
      { approvalGate, feishuClient },
    );
    const agent = factory.create();

    const result = await agent.beforeToolCall!({
      toolCall: { name: 'file_read', id: 'tc-1', type: 'toolCall' } as any,
      args: { path: '/tmp/test.txt' },
      assistantMessage: { role: 'assistant', content: [] } as any,
      context: { systemPrompt: '', messages: [], tools: [] },
    });
    expect(result).toBeUndefined();
    expect(feishuClient.sendApprovalCard).not.toHaveBeenCalled();
  });

  // ─── Agent Factory: shell command with allow policy ──────────────────────

  it('shell command with allow policy — proceeds without approval', async () => {
    policyRepo.create({
      id: 'pol-allow',
      scope: 'global',
      scope_key: '',
      target_kind: 'shell',
      pattern_type: 'exact',
      pattern: 'adb devices',
      effect: 'allow',
    });

    const registry = createToolRegistry();
    registry.register(makeMockTool('shell'));
    const feishuClient = createMockFeishuClient();
    const factory = createAgentFactory(
      { config: makeTestConfig(), toolRegistry: registry },
      { approvalGate, feishuClient },
    );
    const agent = factory.create();

    const result = await agent.beforeToolCall!({
      toolCall: { name: 'shell', id: 'tc-1', type: 'toolCall' } as any,
      args: { command: 'adb devices' },
      assistantMessage: { role: 'assistant', content: [] } as any,
      context: { systemPrompt: '', messages: [], tools: [] },
    });
    expect(result).toBeUndefined();
    expect(feishuClient.sendApprovalCard).not.toHaveBeenCalled();
  });

  // ─── Agent Factory: shell command with deny policy ───────────────────────

  it('shell command with deny policy — blocks execution', async () => {
    policyRepo.create({
      id: 'pol-deny',
      scope: 'global',
      scope_key: '',
      target_kind: 'shell',
      pattern_type: 'prefix',
      pattern: 'adb shell rm',
      effect: 'deny',
    });

    const registry = createToolRegistry();
    registry.register(makeMockTool('shell'));
    const feishuClient = createMockFeishuClient();
    const factory = createAgentFactory(
      { config: makeTestConfig(), toolRegistry: registry },
      { approvalGate, feishuClient },
    );
    const agent = factory.create();

    const result = await agent.beforeToolCall!({
      toolCall: { name: 'shell', id: 'tc-1', type: 'toolCall' } as any,
      args: { command: 'adb shell rm -rf /data' },
      assistantMessage: { role: 'assistant', content: [] } as any,
      context: { systemPrompt: '', messages: [], tools: [] },
    });
    // Should block execution
    expect(result).toBeDefined();
    expect(result!.block).toBe(true);
    expect(feishuClient.sendApprovalCard).not.toHaveBeenCalled();
  });

  // ─── Agent Factory: resolveApproval for unknown ID ───────────────────────

  it('resolveApproval returns false for unknown requestId', () => {
    const registry = createToolRegistry();
    const feishuClient = createMockFeishuClient();
    const factory = createAgentFactory(
      { config: makeTestConfig(), toolRegistry: registry },
      { approvalGate, feishuClient },
    );
    expect(factory.resolveApproval('nonexistent', 'approved')).toBe(false);
  });

  // ─── Full agent flow: approved command executes ──────────────────────────

  it('full flow: high-risk command approved -> tool executes', async () => {
    policyRepo.create({
      id: 'pol-1',
      scope: 'global',
      scope_key: '',
      target_kind: 'shell',
      pattern_type: 'prefix',
      pattern: 'adb install',
      effect: 'require_approval',
    });

    const shellTool = makeMockTool('shell', 'Success');
    const registry = createToolRegistry();
    registry.register(shellTool);
    const feishuClient = createMockFeishuClient();
    const approvalPort = createFeishuApprovalUiPort({ feishuClient: feishuClient as any });
    const dispatcher = createMockDispatcher();
    const factory = createAgentFactory(
      { config: makeTestConfig(), toolRegistry: registry },
      { approvalGate, feishuClient, approvalPort, approvalTimeoutMs: 5000 },
    );

    const agent = factory.create({
      model: { id: 'test-model', name: 'Test Model', api: 'openai-completions', provider: 'test-provider', baseUrl: '', reasoning: false, input: [], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 2048 },
      chatId: 'chat-123',
      sessionId: 'sess-1',
    });
    agent.streamFn = createToolCallStreamFn('shell', { command: 'adb install app.apk' }, 'Done');

    const bridge = new EventBridge(dispatcher);
    bridge.start(agent);

    const promptPromise = agent.prompt('Install the app');
    await new Promise(r => setTimeout(r, 100));

    // Verify approval card was sent
    expect(feishuClient.sendApprovalCard).toHaveBeenCalledOnce();
    const cardArg = feishuClient.sendApprovalCard.mock.calls[0][1] as any;
    const actionBlock = cardArg.elements?.find((e: any) => e.tag === 'action');
    const approveButton = actionBlock?.actions?.find(
      (a: any) => a.value?.action === 'approve_once',
    );
    const requestId = approveButton?.value?.requestId;
    expect(requestId).toBeDefined();

    // Approve the command
    factory.resolveApproval(requestId, 'approved');

    await promptPromise;
    bridge.stop();

    expect(shellTool.execute).toHaveBeenCalled();
    expect(dispatcher.onComplete).toHaveBeenCalled();
  });

  // ─── Full agent flow: denied command blocked ─────────────────────────────

  it('full flow: high-risk command denied -> tool blocked', async () => {
    policyRepo.create({
      id: 'pol-1',
      scope: 'global',
      scope_key: '',
      target_kind: 'shell',
      pattern_type: 'prefix',
      pattern: 'adb install',
      effect: 'require_approval',
    });

    const shellTool = makeMockTool('shell', 'Success');
    const registry = createToolRegistry();
    registry.register(shellTool);
    const feishuClient = createMockFeishuClient();
    const approvalPort = createFeishuApprovalUiPort({ feishuClient: feishuClient as any });
    const dispatcher = createMockDispatcher();
    const factory = createAgentFactory(
      { config: makeTestConfig(), toolRegistry: registry },
      { approvalGate, feishuClient, approvalPort, approvalTimeoutMs: 5000 },
    );

    const agent = factory.create({
      model: { id: 'test-model', name: 'Test Model', api: 'openai-completions', provider: 'test-provider', baseUrl: '', reasoning: false, input: [], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 2048 },
      chatId: 'chat-123',
      sessionId: 'sess-1',
    });
    agent.streamFn = createToolCallStreamFn('shell', { command: 'adb install app.apk' }, 'Done');

    const bridge = new EventBridge(dispatcher);
    bridge.start(agent);

    const promptPromise = agent.prompt('Install the app');
    await new Promise(r => setTimeout(r, 100));

    const cardArg = feishuClient.sendApprovalCard.mock.calls[0][1] as any;
    const actionBlock = cardArg.elements?.find((e: any) => e.tag === 'action');
    const approveButton = actionBlock?.actions?.find(
      (a: any) => a.value?.action === 'approve_once',
    );
    const requestId = approveButton?.value?.requestId;

    // Reject the command
    factory.resolveApproval(requestId, 'rejected');

    await promptPromise;
    bridge.stop();

    // Tool should NOT have executed
    expect(shellTool.execute).not.toHaveBeenCalled();
    expect(dispatcher.onComplete).toHaveBeenCalled();
  });

  // ─── Full agent flow: low-risk command executes directly ─────────────────

  it('full flow: low-risk command allowed -> executes without approval', async () => {
    policyRepo.create({
      id: 'pol-1',
      scope: 'global',
      scope_key: '',
      target_kind: 'shell',
      pattern_type: 'prefix',
      pattern: 'ls',
      effect: 'allow',
    });

    const shellTool = makeMockTool('shell', 'file1.txt');
    const registry = createToolRegistry();
    registry.register(shellTool);
    const feishuClient = createMockFeishuClient();
    const dispatcher = createMockDispatcher();
    const factory = createAgentFactory(
      { config: makeTestConfig(), toolRegistry: registry },
      { approvalGate, feishuClient, approvalTimeoutMs: 5000 },
    );

    const agent = factory.create({
      model: { id: 'test-model', name: 'Test Model', api: 'openai-completions', provider: 'test-provider', baseUrl: '', reasoning: false, input: [], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 2048 },
      sessionId: 'sess-1',
    });
    agent.streamFn = createToolCallStreamFn('shell', { command: 'ls' }, 'Files listed');

    const bridge = new EventBridge(dispatcher);
    bridge.start(agent);
    await agent.prompt('List files');
    bridge.stop();

    expect(shellTool.execute).toHaveBeenCalled();
    expect(feishuClient.sendApprovalCard).not.toHaveBeenCalled();
    expect(dispatcher.onComplete).toHaveBeenCalled();
  });

  // ─── Full agent flow: approval timeout -> rejected ───────────────────────

  it('full flow: approval timeout -> command rejected', async () => {
    policyRepo.create({
      id: 'pol-1',
      scope: 'global',
      scope_key: '',
      target_kind: 'shell',
      pattern_type: 'prefix',
      pattern: 'adb',
      effect: 'require_approval',
    });

    const shellTool = makeMockTool('shell', 'output');
    const registry = createToolRegistry();
    registry.register(shellTool);
    const feishuClient = createMockFeishuClient();
    const dispatcher = createMockDispatcher();
    const factory = createAgentFactory(
      { config: makeTestConfig(), toolRegistry: registry },
      { approvalGate, feishuClient, approvalTimeoutMs: 100 },
    );

    const agent = factory.create({
      model: { id: 'test-model', name: 'Test Model', api: 'openai-completions', provider: 'test-provider', baseUrl: '', reasoning: false, input: [], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 2048 },
      chatId: 'chat-123',
      sessionId: 'sess-1',
    });
    agent.streamFn = createToolCallStreamFn('shell', { command: 'adb devices' }, 'Done');

    const bridge = new EventBridge(dispatcher);
    bridge.start(agent);
    await agent.prompt('Check devices');
    bridge.stop();

    expect(shellTool.execute).not.toHaveBeenCalled();
    expect(dispatcher.onComplete).toHaveBeenCalled();
  });
});
