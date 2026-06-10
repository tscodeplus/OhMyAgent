/**
 * Verify chatId propagates correctly from AgentFactory.create() to cronjob tool.
 */
import { describe, it, expect } from 'vitest';
import dotenv from 'dotenv';
dotenv.config();

import { loadConfig } from '../../src/app/config.js';
import { ToolRegistryImpl } from '../../src/tools/registry.js';
import { createAgentFactory } from '../../src/agent/agent-factory.js';
import { createComputerUseTool } from '../../src/tools/builtins/computer-use-tool.js';

describe('cronjob chatId propagation', () => {
  it('passes chatId to cronjob tool', async () => {
    const config = loadConfig();
    config.toolSearch = { enabled: 'off', thresholdPct: 10, searchDefaultLimit: 5, maxSearchLimit: 20 };
    const toolRegistry = new ToolRegistryImpl();
    toolRegistry.register({
      name: 'dummy',
      label: 'Dummy',
      description: '',
      parameters: { type: 'object' as const, properties: {} },
      execute: async () => ({ content: [] }),
    });

    let capturedChatId: string | undefined;
    let capturedChannel: string | undefined;
    let capturedAgentId: string | undefined;
    let capturedComputerUseAllowed: boolean | undefined;

    const cronServiceFactory = () => ({
      add: (input: any) => {
        capturedChatId = input.chatId;
        capturedChannel = input.channel;
        capturedAgentId = input.agentId;
        capturedComputerUseAllowed = input.computerUseAllowed;
        return { id: 'test-job', name: input.name || 'test' };
      },
      list: () => [] as any[],
      pause: () => true,
      resume: () => true,
      remove: () => true,
      runOnce: async () => ({ status: 'success' as const, jobId: 'x', durationMs: 0, output: '' }),
    });

    const factory = createAgentFactory(
      { config, toolRegistry },
      { cronServiceFactory }
    );

    const testChatId = 'oc_test_chat_67890';
    const agent = factory.create({ message: 'hello', chatId: testChatId, channel: 'feishu', agentId: 'test-agent' });

    const tools = (agent.state as any)?.tools || [];
    const cronTools = tools.filter((t: any) => t.name === 'cronjob');
    expect(cronTools.length, 'cronjob tool count when chatId present').toBe(1);

    await cronTools[0].execute('call1', {
      action: 'create',
      name: 'Reminder',
      schedule: '1m',
      prompt: 'Test prompt',
    });

    expect(capturedChatId).toBe(testChatId);
    expect(capturedChannel).toBe('feishu');
    expect(capturedAgentId).toBe('test-agent');
    expect(capturedComputerUseAllowed).toBe(false);
  });

  it('captures Computer Use grant when creator can see computer_use', async () => {
    const config = loadConfig();
    config.toolSearch = { enabled: 'off', thresholdPct: 10, searchDefaultLimit: 5, maxSearchLimit: 20 };
    const toolRegistry = new ToolRegistryImpl();
    toolRegistry.register(createComputerUseTool({} as any));

    let capturedComputerUseAllowed: boolean | undefined;
    const cronServiceFactory = () => ({
      add: (input: any) => {
        capturedComputerUseAllowed = input.computerUseAllowed;
        return { id: 'test-job', name: input.name || 'test' };
      },
      list: () => [] as any[],
      pause: () => true,
      resume: () => true,
      remove: () => true,
      runOnce: async () => ({ status: 'success' as const, jobId: 'x', durationMs: 0, output: '' }),
    });

    const factory = createAgentFactory(
      { config, toolRegistry },
      { cronServiceFactory }
    );

    const agent = factory.create({ message: 'hello', chatId: 'oc_test', channel: 'feishu', agentId: 'default' });
    const cronTool = (agent.state as any).tools.find((t: any) => t.name === 'cronjob');

    await cronTool.execute('call1', {
      action: 'create',
      name: 'Reminder',
      schedule: '1m',
      prompt: 'Test prompt',
    });

    expect(capturedComputerUseAllowed).toBe(true);
  });

  it('does NOT include cronjob when no chatId', () => {
    const config = loadConfig();
    config.toolSearch = { enabled: 'off', thresholdPct: 10, searchDefaultLimit: 5, maxSearchLimit: 20 };
    const toolRegistry = new ToolRegistryImpl();

    const factory = createAgentFactory(
      { config, toolRegistry },
      {}
    );

    const agent = factory.create({ message: 'no chat' });
    const tools = (agent.state as any)?.tools || [];
    const cronTools = tools.filter((t: any) => t.name === 'cronjob');
    expect(cronTools.length).toBe(0);
  });
});
