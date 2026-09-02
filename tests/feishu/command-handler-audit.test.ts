import { describe, it, expect, vi } from 'vitest';
import { handleCommand } from '../../src/commands/command-handler.js';
import { i18n } from '../../src/i18n/index.js';
import { changeI18nLocale } from '../../src/i18n/i18n-service.js';
import type { CommandDeps } from '../../src/commands/command-handler.js';

function makeDeps(overrides?: Partial<CommandDeps>): CommandDeps {
  return {
    agentService: {
      abort: vi.fn(),
      isRunning: vi.fn(() => true),
      reset: vi.fn(() => true),
      destroyRuntime: vi.fn(() => true),
      rejectPendingApprovals: vi.fn(() => 0),
      resolveFirstPendingApproval: vi.fn(() => false),
      resolveAllPendingApprovals: vi.fn(() => 0),
      rejectPendingQuestions: vi.fn(() => 0),
      resolveUserQuestion: vi.fn(() => false),
      resolveFirstPendingQuestion: vi.fn(() => false),
      steer: vi.fn(() => true),
      followUp: vi.fn(async () => true),
      swapCard: vi.fn(async () => true),
      onNextAgentEnd: vi.fn(),
      setSessionAgentId: vi.fn(),
    },
    skillRegistry: {
      getSkills: vi.fn(() => []),
      reload: vi.fn(async () => 0),
    },
    cronService: {
      list: vi.fn(() => []),
      remove: vi.fn(() => true),
      pause: vi.fn(() => true),
      resume: vi.fn(() => true),
      runOnce: vi.fn(async () => ({ status: 'success', output: 'ok', durationMs: 1 })),
    },
    feishuClient: {
      createCard: vi.fn(async () => 'cardId'),
      sendCardByCardId: vi.fn(async () => 'msgId'),
    },
    agentManager: {
      list: vi.fn(() => [
        {
          id: 'default',
          name: 'Default',
          description: 'Default agent',
          model: { primary: 'gpt-4' },
        },
      ]),
      get: vi.fn((id: string) =>
        id === 'default'
          ? {
              id: 'default',
              name: 'Default',
              description: 'Default agent',
              model: { primary: 'gpt-4' },
            }
          : undefined,
      ),
    },
    extensionManager: {
      list: vi.fn(() => [
        {
          manifest: { id: 'feishu', name: 'Feishu', version: '1.0.0', kind: 'channel' },
          status: 'loaded',
        },
      ]),
    },
    configPath: './config.yaml',
    triggerConfigReload: vi.fn(),
    isAdmin: () => true,
    ...overrides,
  };
}

describe('slash command audit (untested commands)', () => {
  it('/agent lists agents', async () => {
    const deps = makeDeps();
    const result = await handleCommand('/agent', 's1', deps);
    expect(result).not.toBeNull();
    expect(deps.agentManager!.list).toHaveBeenCalled();
    expect(result!.reply).toContain('Default');
  });

  it('/agent switches to a valid agent and forwards message', async () => {
    const deps = makeDeps();
    const result = await handleCommand('/agent default do something', 's1', deps);
    expect(result).not.toBeNull();
    expect(deps.agentService.setSessionAgentId).toHaveBeenCalledWith('s1', 'default');
    expect(deps.agentService.destroyRuntime).toHaveBeenCalledWith('s1');
    expect(result!.forwardText).toBe('do something');
  });

  it('/agent <unknown> reports not found', async () => {
    const deps = makeDeps();
    const result = await handleCommand('/agent ghost', 's1', deps);
    expect(result!.reply).toContain('ghost');
  });

  it('/extension lists extensions', async () => {
    const deps = makeDeps();
    const result = await handleCommand('/extension', 's1', deps);
    expect(result).not.toBeNull();
    expect(deps.extensionManager!.list).toHaveBeenCalled();
    expect(result!.reply).toContain('feishu');
  });

  it('/approve with no pending returns noPending', async () => {
    const deps = makeDeps({
      agentService: { ...makeDeps().agentService, resolveFirstPendingApproval: vi.fn(() => false) },
    });
    const result = await handleCommand('/approve', 's1', deps);
    expect(result!.reply).toBeDefined();
    expect(result!.reply).toMatch(/no pending/i);
  });

  it('/deny with no pending returns noPending', async () => {
    const deps = makeDeps({
      agentService: { ...makeDeps().agentService, resolveFirstPendingApproval: vi.fn(() => false) },
    });
    const result = await handleCommand('/deny', 's1', deps);
    expect(result!.reply).toBeDefined();
    expect(result!.reply).toMatch(/no pending/i);
  });

  it('/answer with no pending returns noPending', async () => {
    const deps = makeDeps({
      agentService: { ...makeDeps().agentService, resolveFirstPendingQuestion: vi.fn(() => false) },
    });
    const result = await handleCommand('/answer yes', 's1', deps);
    expect(result!.reply).toBeDefined();
    // Must NOT be a raw i18n key
    expect(result!.reply).not.toMatch(/^answer\./);
    expect(result!.reply).toMatch(/no pending/i);
  });

  it('/answer with pending echoes the answer', async () => {
    const deps = makeDeps({
      agentService: { ...makeDeps().agentService, resolveFirstPendingQuestion: vi.fn(() => true) },
    });
    const result = await handleCommand('/answer yes', 's1', deps);
    expect(result!.reply).toBeDefined();
    expect(result!.reply).not.toMatch(/\{\{answer\}\}/);
    expect(result!.reply).toContain('yes');
  });

  it('/approve resolves pending approval', async () => {
    const deps = makeDeps({
      agentService: { ...makeDeps().agentService, resolveFirstPendingApproval: vi.fn(() => true) },
    });
    const result = await handleCommand('/approve', 's1', deps);
    expect(result!.reply).toBeDefined();
    expect(result!.reply).not.toMatch(/no pending/i);
  });

  it('/cronjob is an alias for /cron (bare form shows usage)', async () => {
    const deps = makeDeps();
    const result = await handleCommand('/cronjob', 's1', deps);
    expect(result).not.toBeNull();
    // Bare form (no subcommand) routes to the default branch → usage text,
    // exactly like bare /cron. cronService.list() is only called for `list`.
    expect(deps.cronService!.list).not.toHaveBeenCalled();
    expect(result!.reply).toBe(i18n.t('commands:cron.usage'));
  });

  it('/cronjob list routes to handleCron list', async () => {
    const deps = makeDeps();
    const result = await handleCommand('/cronjob list', 's1', deps);
    expect(result).not.toBeNull();
    expect(deps.cronService!.list).toHaveBeenCalled();
    expect(result!.reply).toBe(i18n.t('commands:cron.noJobs'));
  });

  // ── /cron i18n coverage ──
  function cronDepsWithJobs(overrides?: Partial<CommandDeps>): CommandDeps {
    return makeDeps({
      cronService: {
        list: vi.fn(() => [
          {
            id: 'abc12345',
            name: 'Remind me',
            scheduleText: 'every 5m',
            nextRunAt: 1_700_000_000_000,
            enabled: true,
            state: 'running',
            lastStatus: 'success',
            lastRunAt: 1_699_999_000_000,
            prompt: 'Do the thing',
          } as never,
        ]),
        remove: vi.fn(() => true),
        pause: vi.fn(() => true),
        resume: vi.fn(() => true),
        runOnce: vi.fn(async () => ({ status: 'success', output: 'ok', durationMs: 1 })),
      },
      ...overrides,
    });
  }

  it('/cron list translates state and lastStatus (en)', async () => {
    const deps = cronDepsWithJobs();
    const result = await handleCommand('/cron list', 's1', deps);
    expect(result).not.toBeNull();
    // Raw enum values must NOT appear — they are localized.
    expect(result!.reply).not.toContain('running');
    expect(result!.reply).not.toContain('success');
    expect(result!.reply).toContain('Running');
    expect(result!.reply).toContain('Success');
  });

  it('/cron list translates state and lastStatus (zh-CN) and uses UI locale for dates', async () => {
    await changeI18nLocale('zh-CN');
    try {
      const deps = cronDepsWithJobs();
      const result = await handleCommand('/cron list', 's1', deps);
      expect(result).not.toBeNull();
      expect(result!.reply).toContain('运行中');
      expect(result!.reply).toContain('成功');
    } finally {
      await changeI18nLocale('en');
    }
  });

  // ── /agent & /extension i18n coverage ──
  it('/agent list header is localized (en)', async () => {
    await changeI18nLocale('en');
    const deps = makeDeps();
    const result = await handleCommand('/agent', 's1', deps);
    expect(result!.reply).toContain('Available agents:');
    expect(result!.reply).not.toContain('可用 Agent');
  });

  it('/agent list header is localized (zh-CN)', async () => {
    await changeI18nLocale('zh-CN');
    try {
      const deps = makeDeps();
      const result = await handleCommand('/agent', 's1', deps);
      expect(result!.reply).toContain('可用 Agent：');
      expect(result!.reply).not.toContain('Available agents');
    } finally {
      await changeI18nLocale('en');
    }
  });

  it('/agent <unknown> is localized (en)', async () => {
    await changeI18nLocale('en');
    const deps = makeDeps();
    const result = await handleCommand('/agent ghost', 's1', deps);
    expect(result!.reply).toMatch(/not found/i);
    expect(result!.reply).not.toContain('未找到');
    expect(result!.reply).not.toMatch(/^{{target}}/);
  });

  it('/agent <unknown> is localized (zh-CN)', async () => {
    await changeI18nLocale('zh-CN');
    try {
      const deps = makeDeps();
      const result = await handleCommand('/agent ghost', 's1', deps);
      expect(result!.reply).toContain('未找到');
      expect(result!.reply).not.toMatch(/not found/i);
    } finally {
      await changeI18nLocale('en');
    }
  });

  it('/agent switched message is localized (en)', async () => {
    await changeI18nLocale('en');
    const deps = makeDeps();
    const result = await handleCommand('/agent default hi', 's1', deps);
    expect(result!.reply).toContain('Switched to Default (gpt-4)');
    expect(result!.reply).toContain(', processing message...');
  });

  it('/agent switched message is localized (zh-CN)', async () => {
    await changeI18nLocale('zh-CN');
    try {
      const deps = makeDeps();
      const result = await handleCommand('/agent default hi', 's1', deps);
      expect(result!.reply).toContain('已切换到 Default（gpt-4）');
      expect(result!.reply).toContain('，正在处理消息...');
    } finally {
      await changeI18nLocale('en');
    }
  });

  it('/extension header is localized (en)', async () => {
    await changeI18nLocale('en');
    const deps = makeDeps();
    const result = await handleCommand('/extension', 's1', deps);
    expect(result!.reply).toContain('Loaded extensions (1):');
    expect(result!.reply).not.toContain('已加载扩展');
  });

  it('/extension header is localized (zh-CN)', async () => {
    await changeI18nLocale('zh-CN');
    try {
      const deps = makeDeps();
      const result = await handleCommand('/extension', 's1', deps);
      expect(result!.reply).toContain('已加载扩展 (1):');
      expect(result!.reply).not.toContain('Loaded extensions');
    } finally {
      await changeI18nLocale('en');
    }
  });

  it('/extension notEnabled is localized (en)', async () => {
    await changeI18nLocale('en');
    const deps = makeDeps({ extensionManager: undefined });
    const result = await handleCommand('/extension', 's1', deps);
    expect(result!.reply).toContain('Extension system is not enabled');
  });

  it('/extension notEnabled is localized (zh-CN)', async () => {
    await changeI18nLocale('zh-CN');
    try {
      const deps = makeDeps({ extensionManager: undefined });
      const result = await handleCommand('/extension', 's1', deps);
      expect(result!.reply).toContain('扩展系统未启用');
    } finally {
      await changeI18nLocale('en');
    }
  });
});
