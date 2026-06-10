import { describe, expect, it, beforeEach, vi } from 'vitest';
import { handleCommand, type CommandDeps } from '../../src/commands/command-handler.js';
import { teamModeStore } from '../../src/agent/team-mode-store.js';
import type { SmartAgentTeamConfig } from '../../src/app/types.js';
import { i18n } from '../../src/i18n/index.js';

const defaultConfig: SmartAgentTeamConfig = {
  enabled: true,
  max_children: 4,
};

function makeDeps(overrides: Partial<CommandDeps> = {}): CommandDeps {
  return {
    agentService: {
      abort: vi.fn(),
      isRunning: vi.fn(() => false),
      reset: vi.fn(() => true),
      destroyRuntime: vi.fn(() => true),
      rejectPendingApprovals: vi.fn(() => 0),
      steer: vi.fn(() => false),
      followUp: vi.fn(async () => false),
      swapCard: vi.fn(async () => false),
      onNextAgentEnd: vi.fn(),
    },
    ...overrides,
  };
}

describe('/team command', () => {
  beforeEach(() => {
    teamModeStore.delete('session-1');
    teamModeStore.init(defaultConfig);
  });

  it('/team on enables team mode', async () => {
    const deps = makeDeps();
    const result = await handleCommand('/team on', 'session-1', deps);
    expect(result?.reply).toBe(i18n.t('commands:team.enabled'));
    expect(teamModeStore.isEnabled('session-1')).toBe(true);
    const state = teamModeStore.get('session-1')!;
    expect(state.oneShot).toBe(false);
  });

  it('/team off disables team mode', async () => {
    teamModeStore.enable('session-1', true);
    const deps = makeDeps();
    const result = await handleCommand('/team off', 'session-1', deps);
    expect(result?.reply).toBe(i18n.t('commands:team.disabled'));
    expect(teamModeStore.isEnabled('session-1')).toBe(false);
  });

  it('/team <message> sets oneShot and forwards text (when off)', async () => {
    const deps = makeDeps();
    const result = await handleCommand('/team 帮我研究竞品', 'session-1', deps);
    expect(result?.reply).toBe(i18n.t('commands:team.executing'));
    expect(result?.forwardText).toBe('帮我研究竞品');
    expect(teamModeStore.isEnabled('session-1')).toBe(true);
    expect(teamModeStore.get('session-1')!.oneShot).toBe(true);
  });

  it('/team <message> marks oneShot without disabling (when already on)', async () => {
    teamModeStore.enable('session-1', false);
    const deps = makeDeps();
    const result = await handleCommand('/team 再做一件事', 'session-1', deps);
    expect(result?.forwardText).toBe('再做一件事');
    const state = teamModeStore.get('session-1')!;
    expect(state.enabled).toBe(true);
    expect(state.oneShot).toBe(true);
    expect(teamModeStore.isEnabled('session-1')).toBe(true);
  });

  it('empty /team defaults to "on" behavior', async () => {
    const deps = makeDeps();
    const result = await handleCommand('/team', 'session-1', deps);
    expect(result?.reply).toBe(i18n.t('commands:team.enabled'));
    expect(teamModeStore.isEnabled('session-1')).toBe(true);
  });

  it('/team on is idempotent', async () => {
    teamModeStore.enable('session-1', false);
    const deps = makeDeps();
    const result = await handleCommand('/team on', 'session-1', deps);
    expect(result?.reply).toBe(i18n.t('commands:team.enabled'));
    expect(teamModeStore.isEnabled('session-1')).toBe(true);
  });

  it('/team off is idempotent', async () => {
    const deps = makeDeps();
    const result = await handleCommand('/team off', 'session-1', deps);
    expect(result?.reply).toBe(i18n.t('commands:team.disabled'));
    const result2 = await handleCommand('/team off', 'session-1', deps);
    expect(result2?.reply).toBe(i18n.t('commands:team.disabled'));
  });

  it('registers onNextAgentEnd for one-shot execution', async () => {
    const onNextAgentEnd = vi.fn();
    const deps = makeDeps({ agentService: { ...makeDeps().agentService, onNextAgentEnd } as any });
    await handleCommand('/team 做任务', 'session-1', deps);
    expect(onNextAgentEnd).toHaveBeenCalledWith('session-1', expect.any(Function));
  });

  it('non-slash messages return null', async () => {
    const deps = makeDeps();
    const result = await handleCommand('hello world', 'session-1', deps);
    expect(result).toBeNull();
  });
});
