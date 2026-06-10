/**
 * Shared command handler — channel-agnostic slash command processing.
 *
 * Channel adapters (Feishu, WeChat, etc.) call handle() with the message
 * text and session key, then send the returned reply through their own
 * messaging pipeline.
 */

import { i18n } from '../i18n/index.js';
import { teamModeStore } from '../agent/team-mode-store.js';

export interface CommandDeps {
  agentService: {
    abort(sessionId?: string): Promise<void>;
    isRunning(sessionId?: string): boolean;
    reset(sessionId: string): boolean;
    destroyRuntime(sessionId: string): boolean;
    rejectPendingApprovals(sessionId: string): number;
    /** Resolve the first pending approval for a session (used by /approve, /deny). */
    resolveFirstPendingApproval(sessionId: string, decision: string): boolean;
    /** Resolve ALL pending approvals for a session (used by /approve session, /approve always). */
    resolveAllPendingApprovals(sessionId: string, decision: string): number;
    steer(sessionId: string, message: string): boolean;
    followUp(sessionId: string, message: string, replyToMessageId?: string): Promise<boolean>;
    swapCard(sessionId: string, replyToMessageId?: string): Promise<boolean>;
    onNextAgentEnd(sessionId: string, callback: () => void): void;
  };
  skillRegistry?: {
    getSkills(): Array<{ manifest: { id: string; name: string; description: string } }>;
    reload(): Promise<number>;
  };
  cronService?: {
    list(): Array<{ id: string; name: string; scheduleText: string; nextRunAt: number | null; enabled: boolean; state: string; lastStatus: string | null; lastRunAt: number | null; prompt: string; endAt?: number }>;
    remove(id: string): boolean;
    pause(id: string): boolean;
    resume(id: string): boolean;
    runOnce(id: string): Promise<{ status: string; output: string; durationMs: number; error?: string }>;
  };
  feishuClient?: {
    createCard(cardData: Record<string, unknown>): Promise<string>;
    sendCardByCardId(chatId: string, cardId: string): Promise<string>;
  };
  /** V2: optional AgentManager for /agent command. */
  agentManager?: {
    list(): Array<{ id: string; name: string; description?: string; model: { primary: string } }>;
    get(id: string): { id: string; name: string; model: { primary: string } } | undefined;
  };
  /** V2: optional ExtensionManager for /extension command. */
  extensionManager?: {
    list(): Array<{ manifest: { id: string; name: string; version: string; kind: string }; status: string }>;
  };
}

export interface CommandResult {
  /** User-facing reply text. If absent, the command succeeded silently. */
  reply?: string;
  /** When set, forward this text to the agent after command processing. */
  forwardText?: string;
  /** True when a steer message was injected into the running agent. */
  steered?: boolean;
}

/**
 * Parse and execute a slash command.
 *
 * @returns CommandResult if a command was recognized and handled,
 *          null if the message is not a command (pass through to agent).
 */
export async function handleCommand(
  text: string,
  sessionKey: string,
  deps: CommandDeps,
  messageId?: string,
  chatId?: string,
): Promise<CommandResult | null> {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;

  const parts = trimmed.split(/\s+/);
  const command = parts[0].toLowerCase();
  const args = parts.slice(1).join(' ');

  switch (command) {
    case '/agent':
    case '/agents':
      return handleAgentCommand(args, sessionKey, deps);
    case '/stop':
      return await handleStop(sessionKey, deps);
    case '/clear':
      return await handleClear(sessionKey, deps);
    case '/new':
      return await handleNew(sessionKey, deps);
    case '/skill':
    case '/skills':
      return await handleSkill(args, deps);
    case '/steer':
      return handleSteer(sessionKey, args, deps, messageId);
    case '/queue':
      return await handleQueue(sessionKey, args, deps, messageId);
    case '/btw':
      return await handleBtw(sessionKey, args, deps, messageId);
    case '/cron':
      return await handleCron(args, deps, chatId);
    case '/team':
      return handleTeamCommand(args, sessionKey, deps);
    case '/extension':
      return handleExtensionCommand(args, deps);
    case '/approve':
      return await handleApprove(args, sessionKey, deps);
    case '/deny':
      return await handleDeny(sessionKey, deps);
    default:
      return null;
  }
}

async function handleStop(sessionKey: string, deps: CommandDeps): Promise<CommandResult> {
  const isRunning = deps.agentService.isRunning(sessionKey);

  // Reject any pending approvals for this session first
  const rejected = deps.agentService.rejectPendingApprovals(sessionKey);

  if (!isRunning && rejected === 0) {
    return { reply: i18n.t('commands:stop.noTask') };
  }

  // Wait for the agent to settle so that persistMessages (pre-complete
  // callback) finishes before the /stop reply is persisted — this keeps
  // the aborted turn's messages before the /stop exchange in the DB.
  await deps.agentService.abort(sessionKey);

  if (rejected > 0) {
    return { reply: i18n.t('commands:stop.stoppedWithApprovals', { count: rejected }) };
  }
  return { reply: i18n.t('commands:stop.stopped') };
}

async function handleClear(sessionKey: string, deps: CommandDeps): Promise<CommandResult> {
  deps.agentService.rejectPendingApprovals(sessionKey);
  if (deps.agentService.isRunning(sessionKey)) {
    await deps.agentService.abort(sessionKey);
  }
  const ok = deps.agentService.reset(sessionKey);
  return { reply: ok ? i18n.t('commands:clear.cleared') : i18n.t('commands:clear.noSession') };
}

async function handleNew(sessionKey: string, deps: CommandDeps): Promise<CommandResult> {
  deps.agentService.rejectPendingApprovals(sessionKey);
  if (deps.agentService.isRunning(sessionKey)) {
    await deps.agentService.abort(sessionKey);
  }
  deps.agentService.destroyRuntime(sessionKey);
  return { reply: i18n.t('commands:new.created') };
}

async function handleSkill(args: string, deps: CommandDeps): Promise<CommandResult> {
  if (!deps.skillRegistry) {
    return { reply: i18n.t('commands:skill.notEnabled') };
  }

  // /skills reload
  if (args === 'reload') {
    try {
      const count = await deps.skillRegistry.reload();
      return { reply: i18n.t('commands:skill.reloaded', { count }) };
    } catch (err) {
      return { reply: i18n.t('commands:skill.reloadFailed', { error: err instanceof Error ? err.message : String(err) }) };
    }
  }

  let skills: Array<{ manifest: { id: string; name: string; description: string } }>;
  try {
    skills = deps.skillRegistry.getSkills();
  } catch {
    return { reply: i18n.t('commands:skill.notEnabled') };
  }

  if (!args) {
    if (skills.length === 0) {
      return { reply: i18n.t('commands:skill.noSkills') };
    }
    const lines = skills.map(
      (s) => `- $${s.manifest.id} — ${s.manifest.description}`,
    );
    return { reply: i18n.t('commands:skill.list', { list: lines.join('\n\n') }) };
  }

  const targetId = args.split(/\s+/)[0]!.toLowerCase();
  const skill = skills.find((s) => s.manifest.id === targetId);

  if (!skill) {
    return { reply: i18n.t('commands:skill.notFound', { name: targetId }) };
  }

  return {
    reply: i18n.t('commands:skill.info', { command: `$${skill.manifest.id}`, name: skill.manifest.name, desc: skill.manifest.description }),
  };
}

function handleSteer(sessionKey: string, args: string, deps: CommandDeps, messageId?: string): CommandResult {
  if (!args) return {};
  if (!deps.agentService.isRunning(sessionKey)) {
    // No running agent — start a new turn with the message instead
    return { forwardText: args };
  }
  deps.agentService.steer(sessionKey, args);
  return { steered: true };
}

async function handleQueue(sessionKey: string, args: string, deps: CommandDeps, messageId?: string): Promise<CommandResult> {
  if (!args) return {};
  // Always route through forwardText — ChatQueue serializes per-session
  return { forwardText: args };
}

async function handleBtw(sessionKey: string, args: string, deps: CommandDeps, messageId?: string): Promise<CommandResult> {
  if (!args) return {};
  void deps.agentService.followUp(sessionKey, args, messageId);
  return {};
}

async function handleCron(args: string, deps: CommandDeps, chatId?: string): Promise<CommandResult> {
  if (!deps.cronService) {
    return { reply: i18n.t('commands:cron.notEnabled') };
  }

  const parts = args.split(/\s+/);
  const sub = parts[0]?.toLowerCase();
  const rest = parts.slice(1).join(' ');

  switch (sub) {
    case 'list': {
      const jobs = deps.cronService.list();
      if (jobs.length === 0) {
        return { reply: i18n.t('commands:cron.noJobs') };
      }
      const lines = jobs.map(j => {
        const status = j.enabled ? '▶' : '⏸';
        const next = j.nextRunAt ? new Date(j.nextRunAt).toLocaleString('zh-CN') : i18n.t('commands:cron.completed');
        const last = j.lastRunAt ? new Date(j.lastRunAt).toLocaleString('zh-CN') : i18n.t('commands:cron.notExecuted');
        const end = j.endAt ? ` | ${i18n.t('commands:cron.fieldEnd')} ${new Date(j.endAt).toLocaleString('zh-CN')}` : '';
        return [
          `${status} \`${j.id}\` ${j.name}`,
          `  ${i18n.t('commands:cron.fieldSchedule')} ${j.scheduleText} | ${i18n.t('commands:cron.fieldNext')} ${next}${end}`,
          `  ${i18n.t('commands:cron.fieldStatus')} ${j.state} | ${i18n.t('commands:cron.fieldLast')} ${last} (${j.lastStatus ?? 'n/a'})`,
          `  ${i18n.t('commands:cron.fieldPrompt')} ${j.prompt.slice(0, 80)}${j.prompt.length > 80 ? '...' : ''}`,
        ].join('\n');
      });
      return { reply: i18n.t('commands:cron.listHeader', { count: jobs.length }) + '\n\n' + lines.join('\n\n') };
    }

    case 'remove': {
      if (!rest) return { reply: i18n.t('commands:cron.removeUsage') };
      const ok = deps.cronService.remove(rest);
      return { reply: ok ? i18n.t('commands:cron.removed', { id: rest }) : i18n.t('commands:cron.notFound', { id: rest }) };
    }

    case 'pause': {
      if (!rest) return { reply: i18n.t('commands:cron.pauseUsage') };
      const ok = deps.cronService.pause(rest);
      return { reply: ok ? i18n.t('commands:cron.paused', { id: rest }) : i18n.t('commands:cron.notFound', { id: rest }) };
    }

    case 'resume': {
      if (!rest) return { reply: i18n.t('commands:cron.resumeUsage') };
      const ok = deps.cronService.resume(rest);
      return { reply: ok ? i18n.t('commands:cron.resumed', { id: rest }) : i18n.t('commands:cron.notFound', { id: rest }) };
    }

    case 'run': {
      if (!rest) return { reply: i18n.t('commands:cron.runUsage') };
      try {
        const result = await deps.cronService.runOnce(rest);
        if (result.status === 'success') {
          return { reply: i18n.t('commands:cron.ranSuccess', { id: rest, duration: result.durationMs }) };
        }
        return { reply: i18n.t('commands:cron.ranFailed', { id: rest, error: result.error ?? 'unknown error' }) };
      } catch (err) {
        return { reply: i18n.t('commands:cron.execFailed', { error: err instanceof Error ? err.message : String(err) }) };
      }
    }

    case 'test': {
      const targetChatId = rest || chatId;
      if (!targetChatId || !deps.feishuClient) {
        return { reply: i18n.t('commands:cron.testUsage') };
      }
      const cardData = {
        schema: '2.0' as const,
        config: { streaming_mode: false },
        header: {
          title: { tag: 'plain_text', content: i18n.t('commands:cron.testCardTitle') },
          template: 'wathet' as const,
        },
        body: {
          elements: [
            { tag: 'markdown', content: i18n.t('commands:cron.testCardBody') },
            { tag: 'hr' },
            { tag: 'markdown', content: i18n.t('commands:cron.testCardFooter'), text_size: 'notation' },
          ],
        },
      };
      await deps.feishuClient.createCard(cardData)
        .then((cardId: string) => deps.feishuClient!.sendCardByCardId(targetChatId, cardId));
      return { reply: i18n.t('commands:cron.testCardSent') };
    }

    default:
      return { reply: i18n.t('commands:cron.usage') };
  }
}

function handleExtensionCommand(args: string, deps: CommandDeps): CommandResult {
  if (!deps.extensionManager) {
    return { reply: '扩展系统未启用' };
  }

  const extensions = deps.extensionManager.list();

  if (extensions.length === 0) {
    return { reply: '没有已加载的扩展' };
  }

  const lines = extensions.map(ext => {
    const statusIcon = ext.status === 'loaded' ? '✅' : '❌';
    return `${statusIcon} \`${ext.manifest.id}\` — ${ext.manifest.name} v${ext.manifest.version} (${ext.manifest.kind})`;
  });

  return { reply: `已加载扩展 (${extensions.length}):\n\n${lines.join('\n\n')}` };
}

function handleAgentCommand(args: string, sessionKey: string, deps: CommandDeps): CommandResult {
  const agentManager = deps.agentManager;

  if (!agentManager) {
    return { reply: '未启用 Agent 管理器，无法使用 /agent 命令' };
  }

  const agents = agentManager.list();

  if (!args) {
    if (agents.length === 0) {
      return { reply: '当前没有已配置的 Agent' };
    }
    const lines = agents.map((a) =>
      `- ${a.id} — ${a.description || a.name} (${a.model.primary})`
    );
    return { reply: '可用 Agent：\n\n' + lines.join('\n\n') };
  }

  const parts = args.split(/\s+/);
  const targetId = parts[0]!.toLowerCase();
  const remainingMessage = parts.slice(1).join(' ');
  const agent = agentManager.get(targetId);

  if (!agent) {
    return { reply: `未找到 Agent "${targetId}"。使用 /agent 查看可用列表。` };
  }

  // Switch session to this agent (via AgentService)
  if ((deps.agentService as any).setSessionAgentId) {
    (deps.agentService as any).setSessionAgentId(sessionKey, agent.id);
    // Destroy old runtime so the next message creates a fresh Agent with new config
    (deps.agentService as any).destroyRuntime(sessionKey);
  }

  // If there's a message after the agent ID, forward it to the agent
  return {
    reply: `已切换到 ${agent.name}（${agent.model.primary}）` +
      (remainingMessage ? `，正在处理消息...` : ''),
    forwardText: remainingMessage || undefined,
  };
}

// ── /team command (v7) ─────────────────────────────────────────────────────────

function handleTeamCommand(
  args: string,
  sessionId: string,
  deps: CommandDeps,
): CommandResult {
  const arg = args.trim();
  const wasEnabled = teamModeStore.isEnabled(sessionId);

  // /team on
  if (arg === 'on' || arg === '') {
    teamModeStore.enable(sessionId, false);
    return { reply: i18n.t('commands:team.enabled') };
  }

  // /team off
  if (arg === 'off') {
    teamModeStore.disable(sessionId);
    return { reply: i18n.t('commands:team.disabled') };
  }

  // /team <message> — one-shot execution
  if (wasEnabled) {
    // Already in continuous mode: mark oneShot without changing state
    teamModeStore.markOneShot(sessionId);
  } else {
    // Not currently enabled: temporarily enable for this task
    teamModeStore.enable(sessionId, true);
  }

  // Auto-disable after agent finishes (only when oneShot is set)
  deps.agentService.onNextAgentEnd(sessionId, () => {
    const state = teamModeStore.get(sessionId);
    if (state?.oneShot) {
      teamModeStore.disable(sessionId);
    }
  });

  return {
    reply: i18n.t('commands:team.executing'),
    forwardText: arg,
  };
}

// ── /approve command ──────────────────────────────────────────────────────────

/**
 * Handle /approve [session|always] — resolve pending approval(s).
 *
 * - /approve         → resolve the oldest pending with approve_once
 * - /approve session → resolve ALL pending with approve_session
 * - /approve always  → resolve ALL pending with approve_always
 */
async function handleApprove(
  args: string,
  sessionKey: string,
  deps: CommandDeps,
): Promise<CommandResult> {
  const sub = args.trim().toLowerCase();

  if (sub === 'session') {
    const count = deps.agentService.resolveAllPendingApprovals(sessionKey, 'approve_session');
    if (count === 0) {
      return { reply: i18n.t('commands:approve.noPending') };
    }
    return { reply: i18n.t('commands:approve.sessionApproved', { count }) };
  }

  if (sub === 'always') {
    const count = deps.agentService.resolveAllPendingApprovals(sessionKey, 'approve_always');
    if (count === 0) {
      return { reply: i18n.t('commands:approve.noPending') };
    }
    return { reply: i18n.t('commands:approve.alwaysApproved', { count }) };
  }

  // Default: /approve — resolve first pending with approve_once
  const resolved = deps.agentService.resolveFirstPendingApproval(sessionKey, 'approve_once');
  if (!resolved) {
    return { reply: i18n.t('commands:approve.noPending') };
  }
  return { reply: i18n.t('commands:approve.onceApproved') };
}

// ── /deny command ─────────────────────────────────────────────────────────────

async function handleDeny(
  sessionKey: string,
  deps: CommandDeps,
): Promise<CommandResult> {
  const resolved = deps.agentService.resolveFirstPendingApproval(sessionKey, 'reject_once');
  if (!resolved) {
    return { reply: i18n.t('commands:deny.noPending') };
  }
  return { reply: i18n.t('commands:deny.denied') };
}
