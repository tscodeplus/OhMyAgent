/**
 * Shared command handler — channel-agnostic slash command processing.
 *
 * Channel adapters (Feishu, WeChat, etc.) call handle() with the message
 * text and session key, then send the returned reply through their own
 * messaging pipeline.
 */

import { i18n } from '../i18n/index.js';
import type { ConversationSessions } from '../memory/conversation-sessions.js';
import type { CaptureResult, NotesService } from '../notes/service-contract.js';
import { inferChannel } from '../memory/session-channel.js';
import { truncate } from '../shared/truncation.js';
import { teamModeStore } from '../agent/team-mode-store.js';
import { existsSync, readFileSync } from 'node:fs';
import { load as parseYaml } from 'js-yaml';
import {
  applyConfigObject,
  mutateConfigYaml,
  readConfigObject,
} from '../app/webui/yaml-mutation.js';

const VALID_MODES = ['bypass', 'permissive', 'balanced', 'safe'] as const;
type PolicyMode = (typeof VALID_MODES)[number];

export interface CommandDeps {
  agentService: {
    abort(sessionId?: string): Promise<void>;
    isRunning(sessionId?: string): boolean;
    reset(sessionId: string): boolean;
    destroyRuntime(sessionId: string): boolean;
    rejectPendingApprovals(sessionId: string, reason?: 'stopped_by_user' | 'steered'): number;
    /** Resolve the first pending approval for a session (used by /approve, /deny). */
    resolveFirstPendingApproval(sessionId: string, decision: string): boolean;
    /** Resolve ALL pending approvals for a session (used by /approve session, /approve always). */
    resolveAllPendingApprovals(sessionId: string, decision: string): number;
    /** Reject all pending user questions for a session. */
    rejectPendingQuestions(sessionId: string): number;
    /** Resolve a pending user question by requestId. */
    resolveUserQuestion(requestId: string, answer: string): boolean;
    /** Resolve the first pending user question for a session (used by /answer). */
    resolveFirstPendingQuestion(sessionId: string, answer: string): boolean;
    steer(sessionId: string, message: string): boolean;
    followUp(sessionId: string, message: string, replyToMessageId?: string): Promise<boolean>;
    swapCard(sessionId: string, replyToMessageId?: string): Promise<boolean>;
    onNextAgentEnd(sessionId: string, callback: () => void): void;
    setSessionAgentId(sessionId: string, agentId: string): void;
  };
  /**
   * Chat-slot → transcript bookkeeping for `/new` and `/rename`. Optional: a
   * channel that does not wire it keeps the pre-split behaviour (`/new` clears
   * the runtime and stays in the same session row).
   */
  conversations?: Pick<ConversationSessions, 'start' | 'rename'>;
  skillRegistry?: {
    getSkills(): Array<{ manifest: { id: string; name: string; description: string } }>;
    reload(): Promise<number>;
  };
  cronService?: {
    list(): Array<{
      id: string;
      name: string;
      scheduleText: string;
      nextRunAt: number | null;
      enabled: boolean;
      state: string;
      lastStatus: string | null;
      lastRunAt: number | null;
      prompt: string;
      endAt?: number;
    }>;
    remove(id: string): boolean;
    pause(id: string): boolean;
    resume(id: string): boolean;
    runOnce(
      id: string,
    ): Promise<{ status: string; output: string; durationMs: number; error?: string }>;
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
    list(): Array<{
      manifest: { id: string; name: string; version: string; kind: string };
      status: string;
    }>;
  };
  /** Path to config.yaml for slash commands that modify config (e.g. /permission). */
  configPath?: string;
  /** Trigger config hot-reload after config.yaml is modified by a slash command. */
  triggerConfigReload?: () => void;
  /** Channel-provided admin check for privileged commands (e.g. /permission).
   *  When present, the operator identity passed to handleCommand is required
   *  to satisfy it; a failing check rejects the command. */
  isAdmin?: (operator: { senderId?: string; chatType?: string }) => boolean;
  /**
   * Notes capture for `/note` (MyDocs/NOTES_LAYER_PLAN.md §11).
   *
   * Only `capture` is needed, and it is absent when `notes.enabled` is false —
   * which `/note` reports instead of forwarding the text to the agent, because
   * nobody types `/note` into a chat expecting the model to answer it.
   */
  notes?: Pick<NotesService, 'capture'>;
}

/** Operator context of the message that issued a slash command. */
export interface CommandOperator {
  /** Channel sender identity (e.g. Feishu open_id, Telegram user id). */
  senderId?: string;
  /** Chat type (e.g. 'p2p' | 'group'; Telegram: 'private' | 'group' | 'supergroup'). */
  chatType?: string;
  /** Channel id ('feishu' | 'telegram' | 'wechat' | 'qq') — lets the shared
   *  admin check resolve the right allowedUsers list. Defaults to feishu. */
  channel?: string;
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
  operator?: CommandOperator,
): Promise<CommandResult | null> {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;

  const parts = trimmed.split(/\s+/);
  /**
   * Telegram delivers a *group* command as `/note@my_bot` — the mention belongs to
   * the same token. The suffix is stripped here rather than in each adapter
   * because every channel shares this parser: without it `/stop@bot`,
   * `/cron@bot` and `/note@bot` fall through to the agent as ordinary chat text,
   * which looks like the bot ignoring commands in exactly the chats that need
   * them most (a mention is the only way a group command is delivered at all).
   *
   * Only the command token is normalised; arguments are passed through untouched,
   * so `@` remains usable in an instruction (`/note 把 @张三 的那段整理出来`).
   */
  const command = parts[0].toLowerCase().replace(/@[^@]*$/, '');
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
      return await handleNew(args, sessionKey, deps, chatId);
    case '/rename':
      return await handleRename(args, sessionKey, deps);
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
    case '/cronjob':
      return await handleCron(args, deps, chatId);
    case '/team':
      return handleTeamCommand(args, sessionKey, deps);
    case '/extension':
      return handleExtensionCommand(args, deps);
    case '/approve':
      return await handleApprove(args, sessionKey, deps);
    case '/deny':
      return await handleDeny(sessionKey, deps);
    case '/answer':
      return handleAnswer(args, sessionKey, deps);
    case '/permission':
      return await handlePermission(args, deps, operator);
    case '/note':
    case '/notes':
      return await handleNote(args, sessionKey, deps, operator);
    default:
      return null;
  }
}

async function handleStop(sessionKey: string, deps: CommandDeps): Promise<CommandResult> {
  const isRunning = deps.agentService.isRunning(sessionKey);

  // Reject any pending approvals and user questions for this session first
  const rejected = deps.agentService.rejectPendingApprovals(sessionKey);
  deps.agentService.rejectPendingQuestions(sessionKey);

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
  deps.agentService.rejectPendingQuestions(sessionKey);
  if (deps.agentService.isRunning(sessionKey)) {
    await deps.agentService.abort(sessionKey);
  }
  const ok = deps.agentService.reset(sessionKey);
  return { reply: ok ? i18n.t('commands:clear.cleared') : i18n.t('commands:clear.noSession') };
}

async function handleNew(
  args: string,
  sessionKey: string,
  deps: CommandDeps,
  chatId?: string,
): Promise<CommandResult> {
  deps.agentService.rejectPendingApprovals(sessionKey);
  deps.agentService.rejectPendingQuestions(sessionKey);
  if (deps.agentService.isRunning(sessionKey)) {
    await deps.agentService.abort(sessionKey);
  }
  deps.agentService.destroyRuntime(sessionKey);

  // The rejected approvals belong to the conversation being closed, so the slot
  // is read before the rotation: `start` opens the next transcript for it.
  const started = deps.conversations?.start(sessionKey, {
    title: args,
    externalChatId: chatId ?? null,
  });
  if (!started) {
    return { reply: i18n.t('commands:new.created') };
  }
  return {
    reply: started.title
      ? i18n.t('commands:new.createdWithTitle', { title: started.title })
      : i18n.t('commands:new.created'),
  };
}

/**
 * Retitle the conversation that is currently being written to.
 *
 * Exists because `/new` titles are typed under time pressure: retitling after
 * the fact must not require abandoning the context that was already built up.
 */
async function handleRename(
  args: string,
  sessionKey: string,
  deps: CommandDeps,
): Promise<CommandResult> {
  if (!deps.conversations) {
    return { reply: i18n.t('commands:rename.unavailable') };
  }
  const title = deps.conversations.rename(sessionKey, args);
  if (!title) {
    return { reply: i18n.t('commands:rename.usage') };
  }
  return { reply: i18n.t('commands:rename.renamed', { title }) };
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
      return {
        reply: i18n.t('commands:skill.reloadFailed', {
          error: err instanceof Error ? err.message : String(err),
        }),
      };
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
      (s) => `- $${s.manifest.id}（或 /skill:${s.manifest.id}）— ${s.manifest.description}`,
    );
    return { reply: i18n.t('commands:skill.list', { list: lines.join('\n\n') }) };
  }

  const targetId = args.split(/\s+/)[0]!.toLowerCase();
  const skill = skills.find((s) => s.manifest.id === targetId);

  if (!skill) {
    return { reply: i18n.t('commands:skill.notFound', { name: targetId }) };
  }

  return {
    reply: i18n.t('commands:skill.info', {
      command: `$${skill.manifest.id} 或 /skill:${skill.manifest.id}`,
      name: skill.manifest.name,
      desc: skill.manifest.description,
    }),
  };
}

function handleSteer(
  sessionKey: string,
  args: string,
  deps: CommandDeps,
  messageId?: string,
): CommandResult {
  if (!args) return {};
  if (!deps.agentService.isRunning(sessionKey)) {
    // No running agent — start a new turn with the message instead
    return { forwardText: args };
  }
  deps.agentService.steer(sessionKey, args);
  return { steered: true };
}

async function handleQueue(
  sessionKey: string,
  args: string,
  deps: CommandDeps,
  messageId?: string,
): Promise<CommandResult> {
  if (!args) return {};
  // Always route through forwardText — ChatQueue serializes per-session
  return { forwardText: args };
}

async function handleBtw(
  sessionKey: string,
  args: string,
  deps: CommandDeps,
  messageId?: string,
): Promise<CommandResult> {
  if (!args) return {};
  void deps.agentService.followUp(sessionKey, args, messageId);
  return {};
}

async function handleCron(
  args: string,
  deps: CommandDeps,
  chatId?: string,
): Promise<CommandResult> {
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
      const lines = jobs.map((j) => {
        const status = j.enabled ? '▶' : '⏸';
        const locale = i18n.locale;
        const next = j.nextRunAt
          ? new Date(j.nextRunAt).toLocaleString(locale)
          : i18n.t('commands:cron.completed');
        const last = j.lastRunAt
          ? new Date(j.lastRunAt).toLocaleString(locale)
          : i18n.t('commands:cron.notExecuted');
        const end = j.endAt
          ? ` | ${i18n.t('commands:cron.fieldEnd')} ${new Date(j.endAt).toLocaleString(locale)}`
          : '';
        const stateLabel = i18n.t(`commands:cron.state.${j.state}`);
        const lastStatusLabel = j.lastStatus
          ? i18n.t(`commands:cron.runStatus.${j.lastStatus}`)
          : i18n.t('commands:cron.na');
        return [
          `${status} \`${j.id}\` ${j.name}`,
          `  ${i18n.t('commands:cron.fieldSchedule')} ${j.scheduleText} | ${i18n.t('commands:cron.fieldNext')} ${next}${end}`,
          `  ${i18n.t('commands:cron.fieldStatus')} ${stateLabel} | ${i18n.t('commands:cron.fieldLast')} ${last} (${lastStatusLabel})`,
          `  ${i18n.t('commands:cron.fieldPrompt')} ${j.prompt.slice(0, 80)}${j.prompt.length > 80 ? '...' : ''}`,
        ].join('\n');
      });
      return {
        reply:
          i18n.t('commands:cron.listHeader', { count: jobs.length }) + '\n\n' + lines.join('\n\n'),
      };
    }

    case 'remove': {
      if (!rest) return { reply: i18n.t('commands:cron.removeUsage') };
      const ok = deps.cronService.remove(rest);
      return {
        reply: ok
          ? i18n.t('commands:cron.removed', { id: rest })
          : i18n.t('commands:cron.notFound', { id: rest }),
      };
    }

    case 'pause': {
      if (!rest) return { reply: i18n.t('commands:cron.pauseUsage') };
      const ok = deps.cronService.pause(rest);
      return {
        reply: ok
          ? i18n.t('commands:cron.paused', { id: rest })
          : i18n.t('commands:cron.notFound', { id: rest }),
      };
    }

    case 'resume': {
      if (!rest) return { reply: i18n.t('commands:cron.resumeUsage') };
      const ok = deps.cronService.resume(rest);
      return {
        reply: ok
          ? i18n.t('commands:cron.resumed', { id: rest })
          : i18n.t('commands:cron.notFound', { id: rest }),
      };
    }

    case 'run': {
      if (!rest) return { reply: i18n.t('commands:cron.runUsage') };
      try {
        const result = await deps.cronService.runOnce(rest);
        if (result.status === 'success') {
          return {
            reply: i18n.t('commands:cron.ranSuccess', { id: rest, duration: result.durationMs }),
          };
        }
        return {
          reply: i18n.t('commands:cron.ranFailed', {
            id: rest,
            error: result.error ?? 'unknown error',
          }),
        };
      } catch (err) {
        return {
          reply: i18n.t('commands:cron.execFailed', {
            error: err instanceof Error ? err.message : String(err),
          }),
        };
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
            {
              tag: 'markdown',
              content: i18n.t('commands:cron.testCardFooter'),
              text_size: 'notation',
            },
          ],
        },
      };
      await deps.feishuClient
        .createCard(cardData)
        .then((cardId: string) => deps.feishuClient!.sendCardByCardId(targetChatId, cardId));
      return { reply: i18n.t('commands:cron.testCardSent') };
    }

    default:
      return { reply: i18n.t('commands:cron.usage') };
  }
}

function handleExtensionCommand(args: string, deps: CommandDeps): CommandResult {
  if (!deps.extensionManager) {
    return { reply: i18n.t('commands:extension.notEnabled') };
  }

  const extensions = deps.extensionManager.list();

  if (extensions.length === 0) {
    return { reply: i18n.t('commands:extension.noExtensions') };
  }

  const lines = extensions.map((ext) => {
    const statusIcon = ext.status === 'loaded' ? '✅' : '❌';
    return `${statusIcon} \`${ext.manifest.id}\` — ${ext.manifest.name} v${ext.manifest.version} (${ext.manifest.kind})`;
  });

  return {
    reply: `${i18n.t('commands:extension.loadedHeader', { count: extensions.length })}\n\n${lines.join('\n\n')}`,
  };
}

function handleAgentCommand(args: string, sessionKey: string, deps: CommandDeps): CommandResult {
  const agentManager = deps.agentManager;

  if (!agentManager) {
    return { reply: i18n.t('commands:agent.notEnabled') };
  }

  const agents = agentManager.list();

  if (!args) {
    if (agents.length === 0) {
      return { reply: i18n.t('commands:agent.noAgents') };
    }
    const lines = agents.map((a) => `- ${a.id} — ${a.description || a.name} (${a.model.primary})`);
    return { reply: `${i18n.t('commands:agent.available')}\n\n` + lines.join('\n\n') };
  }

  const parts = args.split(/\s+/);
  const targetId = parts[0]!.toLowerCase();
  const remainingMessage = parts.slice(1).join(' ');
  const agent = agentManager.get(targetId);

  if (!agent) {
    return { reply: i18n.t('commands:agent.notFound', { target: targetId }) };
  }

  // Switch session to this agent (via AgentService)
  deps.agentService.setSessionAgentId(sessionKey, agent.id);
  // Destroy old runtime so the next message creates a fresh Agent with new config
  deps.agentService.destroyRuntime(sessionKey);

  // If there's a message after the agent ID, forward it to the agent
  return {
    reply:
      i18n.t('commands:agent.switched', { name: agent.name, model: agent.model.primary }) +
      (remainingMessage ? i18n.t('commands:agent.processing') : ''),
    forwardText: remainingMessage || undefined,
  };
}

// ── /team command (v7) ─────────────────────────────────────────────────────────

function handleTeamCommand(args: string, sessionId: string, deps: CommandDeps): CommandResult {
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

async function handleDeny(sessionKey: string, deps: CommandDeps): Promise<CommandResult> {
  const resolved = deps.agentService.resolveFirstPendingApproval(sessionKey, 'reject_once');
  if (!resolved) {
    return { reply: i18n.t('commands:deny.noPending') };
  }
  return { reply: i18n.t('commands:deny.denied') };
}

// ── /answer command ────────────────────────────────────────────────────────────

function handleAnswer(args: string, sessionKey: string, deps: CommandDeps): CommandResult {
  const answer = args.trim();
  if (!answer) {
    return { reply: i18n.t('commands:answer.usage') || 'Usage: /answer <your answer>' };
  }
  const resolved = deps.agentService.resolveFirstPendingQuestion(sessionKey, answer);
  if (!resolved) {
    return { reply: i18n.t('commands:answer.noPending') || 'No pending questions to answer.' };
  }
  return { reply: i18n.t('commands:answer.answered', { answer }) || `Answered: ${answer}` };
}

// ── /permission command ───────────────────────────────────────────────────────

/** True for a plain object (a YAML mapping), not an array or a scalar. */
function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getCurrentMode(configPath?: string): PolicyMode | null {
  if (!configPath || !existsSync(configPath)) return null;
  try {
    const raw = readFileSync(configPath, 'utf-8');
    const yaml = parseYaml(raw) as Record<string, unknown> | null;
    const policy = yaml?.policy as Record<string, unknown> | undefined;
    const mode = policy?.mode;
    if (typeof mode === 'string' && (VALID_MODES as readonly string[]).includes(mode)) {
      return mode as PolicyMode;
    }
    return 'balanced'; // default when not set
  } catch {
    return null;
  }
}

/**
 * Persist `policy.mode` for `/permission <mode>`.
 *
 * Goes through the shared serialised writer (`yaml-mutation.ts`) like every
 * other `config.yaml` writer: the previous unguarded read-modify-write could
 * drop a concurrent MCP install or settings save — and lose `policy` to it.
 * Comments and formatting of the untouched sections survive, which the previous
 * `js-yaml` dump rewrote from scratch.
 */
async function setMode(
  mode: PolicyMode,
  deps: CommandDeps,
): Promise<{ ok: boolean; message: string }> {
  const configPath = deps.configPath;
  if (!configPath) {
    return { ok: false, message: i18n.t('commands:permission.noConfigPath') };
  }

  try {
    await mutateConfigYaml((doc) => {
      const next = readConfigObject(doc);
      const policy = isMapping(next.policy) ? next.policy : {};
      policy.mode = mode;
      next.policy = policy;
      applyConfigObject(doc, next);
    }, configPath);

    // Trigger config hot-reload
    deps.triggerConfigReload?.();

    return { ok: true, message: i18n.t('commands:permission.switched', { mode }) };
  } catch (err) {
    return {
      ok: false,
      message: i18n.t('commands:permission.writeFailed', {
        error: err instanceof Error ? err.message : String(err),
      }),
    };
  }
}

async function handlePermission(
  args: string,
  deps: CommandDeps,
  operator?: CommandOperator,
): Promise<CommandResult> {
  // ── Admin gate ──
  // Enforced whenever the channel supplies operator context (IM messages),
  // so group strangers cannot flip the approval mode. Channels without a
  // per-user identity — e.g. WebUI, which is already gated by bearer-token
  // auth (the token holder IS the gateway owner/admin) — pass no operator
  // and stay open by design; failing closed there would lock the owner out.
  if (operator && deps.isAdmin && !deps.isAdmin(operator)) {
    return { reply: i18n.t('commands:permission.notAuthorized') };
  }

  const sub = args.trim().toLowerCase();

  // /permission — show current mode
  if (!sub) {
    const current = getCurrentMode(deps.configPath);
    if (current === null) {
      return { reply: i18n.t('commands:permission.cannotRead') };
    }
    const modes = (VALID_MODES as readonly string[])
      .map((m) => (m === current ? `▶ **${m}**` : `  ${m}`))
      .join('\n');
    return { reply: i18n.t('commands:permission.current', { current, modes }) };
  }

  // /permission <mode> — switch to mode
  if (!(VALID_MODES as readonly string[]).includes(sub)) {
    const modes = (VALID_MODES as readonly string[]).join(', ');
    return { reply: i18n.t('commands:permission.invalidMode', { mode: sub, modes }) };
  }

  const result = await setMode(sub as PolicyMode, deps);
  return { reply: result.message };
}

/** Same ceiling the HTTP route enforces (`MAX_INSTRUCTION_CHARS` in notes-routes). */
const NOTE_INSTRUCTION_MAX_CHARS = 500;

/** Title length in the reply: long enough to recognise, short enough for a card. */
const NOTE_REPLY_TITLE_CHARS = 60;

/**
 * `/note` and `/notes` — distil this conversation into drafts (plan §11).
 *
 * One handler, two spellings: the user's word for the layer is "笔记", and
 * typing the plural while meaning "make one" is not a mistake worth an error.
 *
 * The trailing text is an **instruction**, not material: `/note 把刚才那几条命令
 * 整理出来` asks about the conversation, and capture reads it as a requirement it
 * must satisfy. That is why it also widens the window and lets the recap gate
 * pass — an explicit ask is the opposite of a model summarising on its own.
 *
 * There is no approval card in this milestone, so the reply carries the two
 * things a card would have carried: which drafts exist (their titles) and where
 * to review them. Everything still lands `draft`; the review gate is not
 * negotiable from a chat message.
 */
async function handleNote(
  args: string,
  sessionKey: string,
  deps: CommandDeps,
  operator?: CommandOperator,
): Promise<CommandResult> {
  if (!deps.notes) {
    return { reply: i18n.t('commands:note.disabled') };
  }

  const instruction = truncate(args.trim(), NOTE_INSTRUCTION_MAX_CHARS).trim();

  let result: CaptureResult;
  try {
    result = await deps.notes.capture({
      sessionId: sessionKey,
      // `/note` means "this conversation", and `session` is the only mode that can
      // deliver that: it reads everything the token budget holds and reports how many
      // messages the budget dropped. `recent` read five turns from the newest end,
      // which is a suffix — the same word, a different promise.
      mode: 'session',
      instruction: instruction || undefined,
      // Group chats default to the `channel` scope instead of the person's own
      // library, so a shared room's notes cannot leak into a 1:1 context.
      chatType: operator?.chatType,
      actor: 'user',
    });
  } catch (err) {
    // `capture()` handles model errors itself; anything reaching here is
    // infrastructure (a closed database, a full disk). The chat still gets an
    // answer rather than silence.
    return {
      reply: i18n.t('commands:note.failed', {
        error: err instanceof Error ? err.message : String(err),
      }),
    };
  }

  return { reply: renderCaptureReply(result) };
}

/**
 * What the window actually contained.
 *
 * Printed only when the budget cut something, plus a one-liner when the read was
 * narrow enough that "the whole conversation" would be a lie. Silence here would make
 * a note from the tail of a conversation indistinguishable from a note about all of
 * it — and the reviewer's job is to judge the note, not to guess its material.
 */
function readScopeLines(result: Extract<CaptureResult, { ok: true }>): string[] {
  // `> 0` rather than `<= 0`: a fixture or an older server that omits the field must
  // not print "read undefined messages".
  const lines: string[] = [];
  if (result.droppedMessages > 0) {
    lines.push(
      i18n.t('commands:note.windowTruncated', {
        read: result.readMessages,
        dropped: result.droppedMessages,
      }),
    );
  }
  // A brief that named a scope narrowed the material on purpose; saying so is what
  // keeps "the note is short" from reading as "the capture missed things".
  if (result.appliedScope?.turns !== undefined) {
    lines.push(i18n.t('commands:note.scopedTurns', { turns: result.appliedScope.turns }));
  }
  return lines;
}

/** Status label for a note the library already held, in the reply's language. */
function noteReplyStatusLabel(status: 'draft' | 'active' | 'archived'): string {
  switch (status) {
    case 'draft':
      return i18n.t('commands:note.statusDraft');
    case 'active':
      return i18n.t('commands:note.statusActive');
    case 'archived':
      return i18n.t('commands:note.statusArchived');
  }
}

/**
 * The IM reply for a capture.
 *
 * Deliberately short and front-loaded: the first line says how many drafts
 * exist, because on a phone the notification is often all that gets read. The
 * titles are what make the message actionable — "存了 2 条" without titles is a
 * claim the reader has to go and verify.
 *
 * Duplicates are reported with the status of the row that owns the title:
 * "already a note" and "already waiting in the drafts" are different answers,
 * and only one of them means the reviewer has nothing to do.
 */
function renderCaptureReply(result: CaptureResult): string {
  if (result.ok) {
    const lines: string[] = [i18n.t('commands:note.created', { count: result.notes.length })];
    for (const note of result.notes) {
      lines.push(`· ${truncate(note.title, NOTE_REPLY_TITLE_CHARS)}`);
    }
    lines.push(...readScopeLines(result));
    if (result.duplicates.length > 0) {
      lines.push(
        i18n.t('commands:note.skipped', {
          count: result.duplicates.length,
          titles: result.duplicates
            .map(
              (duplicate) =>
                `${truncate(duplicate.title, NOTE_REPLY_TITLE_CHARS)}（${noteReplyStatusLabel(
                  duplicate.status,
                )}）`,
            )
            .join('；'),
        }),
      );
    }
    lines.push(i18n.t('commands:note.reviewFooter'));
    return lines.join('\n');
  }

  switch (result.code) {
    case 'duplicate': {
      const duplicates = result.duplicates ?? [];
      const lines: string[] = [
        i18n.t('commands:note.duplicatesOnly', { count: duplicates.length }),
      ];
      for (const duplicate of duplicates) {
        lines.push(
          `· ${truncate(duplicate.title, NOTE_REPLY_TITLE_CHARS)}（${noteReplyStatusLabel(
            duplicate.status,
          )}）`,
        );
      }
      lines.push(i18n.t('commands:note.reviewFooterDuplicates'));
      return lines.join('\n');
    }
    case 'no_notes':
      // The hint is the useful half: capture without an instruction reads the
      // last few turns and asks the model what *it* thinks is worth keeping,
      // which is exactly the run that comes back empty on a working session.
      return [i18n.t('commands:note.noNotes'), i18n.t('commands:note.noNotesHint')].join('\n');
    case 'empty_window':
      return i18n.t('commands:note.emptyWindow');
    case 'model_failed':
      return i18n.t('commands:note.modelFailed');
    case 'invalid':
      return i18n.t('commands:note.invalid');
    case 'no_session':
      return i18n.t('commands:note.noSession');
    case 'disabled':
      return i18n.t('commands:note.disabled');
    default:
      return i18n.t('commands:note.failed', { error: result.message });
  }
}
