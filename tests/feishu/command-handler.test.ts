import { i18n } from '../../src/i18n/index.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleCommand } from '../../src/commands/command-handler.js';
import type { CommandDeps } from '../../src/commands/command-handler.js';

function makeDeps(overrides?: Partial<CommandDeps>): CommandDeps {
  return {
    agentService: {
      abort: vi.fn(),
      isRunning: vi.fn(() => true),
      reset: vi.fn(() => true),
      destroyRuntime: vi.fn(() => true),
      rejectPendingApprovals: vi.fn(() => 0),
      steer: vi.fn(() => true),
      followUp: vi.fn(async (_sessionId: string, _message: string, _replyToMessageId?: string) => true),
    },
    skillRegistry: {
      getSkills: vi.fn(() => [
        { manifest: { id: 'researcher', name: 'Researcher', description: 'Research assistant' } },
        { manifest: { id: 'android-operator', name: 'Android Operator', description: 'ADB helper' } },
      ]),
      reload: vi.fn(async () => 2),
    },
    ...overrides,
  };
}

describe('handleCommand (shared)', () => {
  let deps: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = makeDeps();
  });

  // ── Non-command messages ──

  it('returns null for non-command messages', async () => {
    expect(await handleCommand('Hello', 's1', deps)).toBeNull();
    expect(await handleCommand('', 's1', deps)).toBeNull();
  });

  it('returns null for unknown slash commands', async () => {
    expect(await handleCommand('/bogus', 's1', deps)).toBeNull();
    expect(await handleCommand('/unknown', 's1', deps)).toBeNull();
  });

  it('treats commands case-insensitively', async () => {
    const result = await handleCommand('/CLEAR', 's1', deps);
    expect(result).not.toBeNull();
    expect(result!.reply).toBe(i18n.t('commands:clear.cleared'));
  });

  it('handles leading/trailing whitespace', async () => {
    const result = await handleCommand('  /stop  ', 's1', deps);
    expect(result).not.toBeNull();
    expect(result!.reply).toBe(i18n.t('commands:stop.stopped'));
  });

  // ── /stop ──

  it('/stop aborts and replies when running', async () => {
    const result = await handleCommand('/stop', 's1', deps);
    expect(deps.agentService.isRunning).toHaveBeenCalledWith('s1');
    expect(deps.agentService.abort).toHaveBeenCalledWith('s1');
    expect(result!.reply).toBe(i18n.t('commands:stop.stopped'));
  });

  it('/stop replies when not running', async () => {
    deps = makeDeps({ agentService: { ...makeDeps().agentService, isRunning: vi.fn(() => false) } });
    const result = await handleCommand('/stop', 's1', deps);
    expect(deps.agentService.abort).not.toHaveBeenCalled();
    expect(result!.reply).toBe(i18n.t('commands:stop.noTask'));
  });

  it('/stop rejects pending approvals and reports count', async () => {
    deps = makeDeps({
      agentService: { ...makeDeps().agentService, rejectPendingApprovals: vi.fn(() => 3) },
    });
    const result = await handleCommand('/stop', 's1', deps);
    expect(deps.agentService.rejectPendingApprovals).toHaveBeenCalledWith('s1');
    expect(deps.agentService.abort).toHaveBeenCalledWith('s1');
    expect(result!.reply).toBe(i18n.t('commands:stop.stoppedWithApprovals', { count: 3 }));
  });

  it('/stop rejects approvals even when not streaming', async () => {
    deps = makeDeps({
      agentService: {
        ...makeDeps().agentService,
        isRunning: vi.fn(() => false),
        rejectPendingApprovals: vi.fn(() => 2),
      },
    });
    const result = await handleCommand('/stop', 's1', deps);
    expect(result!.reply).toBe(i18n.t('commands:stop.stoppedWithApprovals', { count: 2 }));
  });

  // ── /clear ──

  it('/clear resets and replies', async () => {
    const result = await handleCommand('/clear', 's1', deps);
    expect(deps.agentService.reset).toHaveBeenCalledWith('s1');
    expect(result!.reply).toBe(i18n.t('commands:clear.cleared'));
  });

  it('/clear aborts first if running, then resets', async () => {
    const result = await handleCommand('/clear', 's1', deps);
    expect(deps.agentService.abort).toHaveBeenCalledWith('s1');
    expect(deps.agentService.reset).toHaveBeenCalledWith('s1');
    expect(result!.reply).toBe(i18n.t('commands:clear.cleared'));
  });

  it('/clear reports when no active session', async () => {
    deps = makeDeps({ agentService: { ...makeDeps().agentService, reset: vi.fn(() => false) } });
    const result = await handleCommand('/clear', 's1', deps);
    expect(result!.reply).toBe(i18n.t('commands:clear.noSession'));
  });

  // ── /new ──

  it('/new destroys runtime and replies', async () => {
    const result = await handleCommand('/new', 's1', deps);
    expect(deps.agentService.destroyRuntime).toHaveBeenCalledWith('s1');
    expect(result!.reply).toBe(i18n.t('commands:new.created'));
  });

  it('/new aborts first if running, then destroys runtime', async () => {
    const result = await handleCommand('/new', 's1', deps);
    expect(deps.agentService.abort).toHaveBeenCalledWith('s1');
    expect(deps.agentService.destroyRuntime).toHaveBeenCalledWith('s1');
  });

  // ── /skill ──

  it('/skill without args lists available skills', async () => {
    const result = await handleCommand('/skill', 's1', deps);
    expect(result!.reply).toContain(i18n.t('commands:skill.list', { list: '' }));
    expect(result!.reply).toContain('$researcher');
    expect(result!.reply).toContain('$android-operator');
  });

  it('/skill with no loaded skills', async () => {
    deps = makeDeps({
      skillRegistry: { getSkills: vi.fn(() => []), reload: vi.fn(async () => 0) },
    });
    const result = await handleCommand('/skill', 's1', deps);
    expect(result!.reply).toBe(i18n.t('commands:skill.noSkills'));
  });

  it('/skill reports when registry is absent', async () => {
    deps = makeDeps({ skillRegistry: undefined });
    const result = await handleCommand('/skill', 's1', deps);
    expect(result!.reply).toBe(i18n.t('commands:skill.notEnabled'));
  });

  it('/skill with valid name shows usage', async () => {
    const result = await handleCommand('/skill researcher', 's1', deps);
    expect(result!.reply).toContain('$researcher');
    expect(result!.reply).toContain('Researcher');
  });

  it('/skills is an alias for /skill', async () => {
    const result = await handleCommand('/skills', 's1', deps);
    expect(result!.reply).toContain(i18n.t('commands:skill.list', { list: '' }));
    expect(result!.reply).toContain('$researcher');
  });

  it('/skill with invalid name shows error', async () => {
    const result = await handleCommand('/skill nonexistent', 's1', deps);
    expect(result!.reply).toContain(i18n.t('commands:skill.notFound', { name: 'nonexistent' }));
    expect(result!.reply).toContain('/skill');
  });

  it('/skills reload triggers reload and reports count', async () => {
    const result = await handleCommand('/skills reload', 's1', deps);
    expect(deps.skillRegistry!.reload).toHaveBeenCalledOnce();
    expect(result!.reply).toBe(i18n.t('commands:skill.reloaded', { count: 2 }));
  });

  it('/skills reload reports error on failure', async () => {
    deps = makeDeps({
      skillRegistry: {
        getSkills: vi.fn(() => []),
        reload: vi.fn(async () => { throw new Error('disk full'); }),
      },
    });
    const result = await handleCommand('/skills reload', 's1', deps);
    expect(result!.reply).toBe(i18n.t('commands:skill.reloadFailed', { error: 'disk full' }));
  });

  it('/skills reload reports when registry is absent', async () => {
    deps = makeDeps({ skillRegistry: undefined });
    const result = await handleCommand('/skills reload', 's1', deps);
    expect(result!.reply).toBe(i18n.t('commands:skill.notEnabled'));
  });

  // ── /help removed ──

  it('/help is not a recognized command (passes through)', async () => {
    expect(await handleCommand('/help', 's1', deps)).toBeNull();
  });

  // ── /steer ──

  it('/steer without args returns empty result', async () => {
    const result = await handleCommand('/steer', 's1', deps);
    expect(result!.reply).toBeUndefined();
  });

  it('/steer queues steering message when agent is running', async () => {
    const result = await handleCommand('/steer use Docker instead', 's1', deps);
    expect(deps.agentService.isRunning).toHaveBeenCalledWith('s1');
    expect(deps.agentService.steer).toHaveBeenCalledWith('s1', 'use Docker instead');
    expect(result!.steered).toBe(true);
  });

  it('/steer falls through to agent execution when not running', async () => {
    deps = makeDeps({ agentService: { ...makeDeps().agentService, isRunning: vi.fn(() => false) } });
    const result = await handleCommand('/steer use Docker', 's1', deps);
    expect(deps.agentService.steer).not.toHaveBeenCalled();
    expect(result!.forwardText).toBe('use Docker');
  });

  // ── /btw ──

  it('/btw without args returns empty result', async () => {
    const result = await handleCommand('/btw', 's1', deps);
    expect(result!.reply).toBeUndefined();
  });

  it('/btw queues followUp message', async () => {
    const result = await handleCommand('/btw what is the weather?', 's1', deps);
    expect(deps.agentService.followUp).toHaveBeenCalledWith('s1', 'what is the weather?', undefined);
    expect(result!.reply).toBeUndefined();
  });

  // ── /queue ──

  it('/queue without args returns empty result', async () => {
    const result = await handleCommand('/queue', 's1', deps);
    expect(result!.reply).toBeUndefined();
    expect(result!.forwardText).toBeUndefined();
  });

  it('/queue returns forwardText to start a new agent turn', async () => {
    const result = await handleCommand('/queue what is the weather?', 's1', deps);
    expect(result!.forwardText).toBe('what is the weather?');
    expect(result!.reply).toBeUndefined();
  });

  it('/queue bypasses steer even when agent is running', async () => {
    // /queue always forwards — it never steers
    const result = await handleCommand('/queue do this now', 's1', deps);
    expect(deps.agentService.steer).not.toHaveBeenCalled();
    expect(result!.forwardText).toBe('do this now');
  });
});
