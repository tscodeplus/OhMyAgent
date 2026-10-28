/**
 * Shared command handler — channel-agnostic slash command processing.
 *
 * Channel adapters (Feishu, WeChat, etc.) call handle() with the message
 * text and session key, then send the returned reply through their own
 * messaging pipeline.
 */

import { i18n } from '../i18n/index.js';
import type { ConversationSessions } from '../memory/conversation-sessions.js';
import type { KnowledgeService } from '../memory/knowledge/service-contract.js';
import type { KnowledgeCurator } from '../memory/knowledge/curate.js';
import { isPageType, type KnowledgePage, type PageType } from '../memory/knowledge/types.js';
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
   * Curated knowledge pages for `/knowledge` (plan §6 K2-5, entry point 2).
   * Absent when `knowledge.enabled` is false — the layer is inert then (no
   * tools, no curation job, no injection), so the command reports it as off
   * instead of failing on a missing dependency.
   */
  knowledgeService?: KnowledgeService;
  /**
   * Row counts for `/knowledge stats`. The `KnowledgeService` contract has no
   * aggregate accessor (its `list` is paginated), so the wiring point counts
   * pages itself — the same reason `GET /api/knowledge/stats` reads the table
   * directly. Absent means "no counts here", not "no pages".
   */
  knowledgeStats?: () => KnowledgeStatsSnapshot;
}

/** Page counts `/knowledge stats` renders. Keys are the stored enum values. */
export interface KnowledgeStatsSnapshot {
  total: number;
  byStatus: Record<string, number>;
  byPageType: Record<string, number>;
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
    case '/knowledge':
      return await handleKnowledge(args, deps);
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

// ── /knowledge command ───────────────────────────────────────────────────────

/**
 * Process-wide curator lookup for `/knowledge curate` (plan §6 K2-5, entry
 * point 2).
 *
 * The one `KnowledgeCurator` is built in `createSchedulers`, next to the
 * `DreamCycle` whose nightly phase runs the same job — the two entry points must
 * be one instance behind two triggers, not two objects over one database. But
 * `CommandDeps` is assembled before and independently of the schedulers (the
 * WebUI route table and each channel extension build their own), so it cannot
 * take a constructor-time instance. They read this resolver instead, the same
 * seam `src/judge/engine-lookup.ts` uses for the judge engine. Unset = the
 * knowledge layer is off or curation is not wired here, and the command says so
 * rather than inventing a page.
 */
let resolveKnowledgeCurator: () => KnowledgeCurator | undefined = () => undefined;

export function setKnowledgeCuratorResolver(resolve: () => KnowledgeCurator | undefined): void {
  resolveKnowledgeCurator = resolve;
}

/** The live curator, or `undefined` when nothing is wired. Never throws. */
export function currentKnowledgeCurator(): KnowledgeCurator | undefined {
  try {
    return resolveKnowledgeCurator();
  } catch {
    return undefined;
  }
}

/** Pages per `/knowledge list` / `pending` reply — a chat message, not a browse UI. */
const KNOWLEDGE_PAGE_LIST_LIMIT = 20;
/** `/knowledge show` body budget; the whole page is readable in the WebUI editor. */
const KNOWLEDGE_SHOW_MAX_CHARS = 1200;
/** Pages named in a `/knowledge curate` reply — the run is capped, the reply more so. */
const KNOWLEDGE_CURATE_REPORT_LIMIT = 10;

/** `page_type/slug` is the page's address — the same form `[[wikilink]]` resolves. */
function knowledgePageAddress(page: KnowledgePage): string {
  return `${page.page_type}/${page.slug}`;
}

/**
 * `/knowledge show` accepts both the address (`topic/excel-etl`) and the bare
 * slug, because `list` prints the address while a wikilink is often written as
 * just `[[excel-etl]]`.
 */
function parseKnowledgeShowRef(raw: string): { slug: string; pageType?: PageType } {
  const slash = raw.indexOf('/');
  if (slash > 0 && isPageType(raw.slice(0, slash))) {
    return { pageType: raw.slice(0, slash) as PageType, slug: raw.slice(slash + 1) };
  }
  return { slug: raw };
}

/** `active 9 · pending 3` — enum values are data, not prose, so they stay untranslated. */
function formatKnowledgeCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts);
  if (entries.length === 0) return i18n.t('commands:knowledge.none');
  return entries.map(([name, count]) => `${name} ${count}`).join(' · ');
}

/**
 * The pages a curation run wrote, read back from the service.
 *
 * `CurateRunReport` reports counts, not identities, and the reply has to name
 * what changed. Both statuses are read because `curate.shadow` writes `pending`
 * rows, which `list` hides by design; `list` is newest-updated-first, so the
 * run's own pages are at the front of what is scanned and a page is "touched"
 * when its `updated_at` is at or after the run started.
 */
function knowledgePagesWrittenSince(service: KnowledgeService, since: number): KnowledgePage[] {
  return [
    ...service.list({ status: 'active', limit: KNOWLEDGE_PAGE_LIST_LIMIT }),
    ...service.listPending(KNOWLEDGE_PAGE_LIST_LIMIT),
  ]
    .filter((page) => (page.updated_at ?? 0) >= since)
    .slice(0, KNOWLEDGE_CURATE_REPORT_LIMIT);
}

/**
 * `/knowledge list | show <slug> | pending | approve <id> | stats | curate |
 * share <message-id|url>`.
 *
 * Reads go through `KnowledgeService`, so `/knowledge` sees exactly what the
 * model sees: `active` pages only, except in `pending`, which is the one place
 * shadow-mode pages are visible. `/knowledge stats` is the exception — counts
 * are supplied by the wiring point (`knowledgeStats`) because the service
 * contract has no aggregate.
 *
 * `curate` is the explicit-request entry point (§6 K2-5): one curation pass, run
 * now, awaited before the reply, with the manual trigger — which is admission
 * rule 3 ("the user asked for this page"). Idempotency is the engine's: the slug
 * comes from the subject, so a second run updates the page instead of creating a
 * twin. It never throws into the chat path — the whole switch is inside a
 * try/catch that answers with a sentence.
 *
 * `share` is the third entry point: it takes one message reference and asks the
 * same curator for at most one page from it (`curateMessage`), so a link a user
 * dropped into the chat becomes knowledge without waiting for the nightly pass.
 * The two never overlap in meaning: `curate` selects its own subjects from
 * memories, `share` is about exactly one message.
 */
async function handleKnowledge(args: string, deps: CommandDeps): Promise<CommandResult> {
  const service = deps.knowledgeService;
  // `knowledge.enabled: false` leaves the layer inert, and a channel that never
  // wired it is in the same position: say so instead of throwing.
  if (!service) {
    return { reply: i18n.t('commands:knowledge.disabled') };
  }

  const parts = args.trim().split(/\s+/);
  const sub = (parts[0] ?? '').toLowerCase();
  const rest = parts.slice(1).join(' ').trim();

  try {
    switch (sub) {
      // Bare `/knowledge` lists pages, like bare `/skill` lists skills.
      case '':
      case 'list': {
        const pages = service.list({ status: 'active', limit: KNOWLEDGE_PAGE_LIST_LIMIT });
        if (pages.length === 0) return { reply: i18n.t('commands:knowledge.empty') };
        return {
          reply: i18n.t('commands:knowledge.listHeader', {
            count: pages.length,
            list: pages
              .map((page) => `- \`${knowledgePageAddress(page)}\` ${page.title}`)
              .join('\n'),
          }),
        };
      }

      case 'show': {
        if (!rest) return { reply: i18n.t('commands:knowledge.showUsage') };
        const detail = service.get(parseKnowledgeShowRef(rest));
        if (!detail) {
          return { reply: i18n.t('commands:knowledge.pageNotFound', { ref: rest }) };
        }
        const page = detail.page;
        return {
          reply: i18n.t('commands:knowledge.pageDetail', {
            title: page.title,
            address: knowledgePageAddress(page),
            version: page.version,
            status: page.status,
            sources: detail.sources.length
              ? detail.sources
                  .map((source) => `${source.source_kind}:${source.source_id}`)
                  .join(', ')
              : i18n.t('commands:knowledge.sourcesNone'),
            links: detail.links.length
              ? detail.links.map((link) => `[[${link.slug}]]${link.missing ? ' ?' : ''}`).join(' ')
              : i18n.t('commands:knowledge.linksNone'),
            content: truncate(page.content, KNOWLEDGE_SHOW_MAX_CHARS),
          }),
        };
      }

      case 'pending': {
        const pages = service.listPending(KNOWLEDGE_PAGE_LIST_LIMIT);
        if (pages.length === 0) return { reply: i18n.t('commands:knowledge.noPending') };
        return {
          reply: i18n.t('commands:knowledge.pendingHeader', {
            count: pages.length,
            // The id is what `approve` takes, so it is printed verbatim.
            list: pages
              .map((page) => `- \`${page.id}\` ${knowledgePageAddress(page)} ${page.title}`)
              .join('\n'),
          }),
        };
      }

      case 'approve': {
        if (!rest) return { reply: i18n.t('commands:knowledge.approveUsage') };
        if (!service.setStatus(rest, 'active', 'user')) {
          return { reply: i18n.t('commands:knowledge.approveNotFound', { id: rest }) };
        }
        return { reply: i18n.t('commands:knowledge.approved', { id: rest }) };
      }

      case 'stats': {
        const snapshot = deps.knowledgeStats?.();
        if (!snapshot) return { reply: i18n.t('commands:knowledge.countsUnavailable') };
        return {
          reply: i18n.t('commands:knowledge.stats', {
            total: snapshot.total,
            statuses: formatKnowledgeCounts(snapshot.byStatus),
            types: formatKnowledgeCounts(snapshot.byPageType),
          }),
        };
      }

      case 'curate': {
        // No seam for a topic filter: `CurateRunOptions` is trigger + signal, and
        // the engine picks its own subjects. An argument is a usage error rather
        // than a silent "curated something else".
        if (rest) return { reply: i18n.t('commands:knowledge.curateUsage') };
        // The instance the nightly phase uses, resolved from the schedulers.
        const curator = currentKnowledgeCurator();
        if (!curator) return { reply: i18n.t('commands:knowledge.curateUnavailable') };

        const startedAt = Date.now();
        // `manual` is the trigger that counts as admission rule 3, and the page
        // cap is the configured `curate.max_pages_per_run` — `run()` has no
        // per-call cap, by design (one budget, one place to read it).
        const report = await curator.run({ trigger: 'manual' });
        if (report.skipped) {
          return { reply: i18n.t('commands:knowledge.curateSkipped', { reason: report.skipped }) };
        }

        const pages = knowledgePagesWrittenSince(service, startedAt);
        if (pages.length === 0) {
          return {
            reply: i18n.t('commands:knowledge.curateNoPages', {
              rejected: formatKnowledgeCounts(report.rejected),
              failed: report.failed,
            }),
          };
        }
        return {
          reply: i18n.t('commands:knowledge.curateDone', {
            created: report.created,
            updated: report.updated,
            failed: report.failed,
            pages: pages
              .map((page) => `- \`${knowledgePageAddress(page)}\` ${page.title}`)
              .join('\n'),
          }),
        };
      }

      case 'share': {
        // A shared link/attachment is a message, so the entry point is a message
        // reference — an id, or the URL that message contains. `/knowledge
        // curate` stays argument-free: it curates a window, this curates one
        // thing, and conflating the two would make `/knowledge curate <id>` mean
        // something the engine's options cannot express.
        if (!rest) return { reply: i18n.t('commands:knowledge.shareUsage') };
        const curator = currentKnowledgeCurator();
        if (!curator) return { reply: i18n.t('commands:knowledge.curateUnavailable') };

        const startedAt = Date.now();
        // `manual` is the trigger that counts as admission rule 3 — the user
        // pressed the command, so one shared message is enough to make a page.
        const report = await curator.curateMessage(rest, { trigger: 'manual' });
        if (report.skipped === 'message_not_found') {
          return { reply: i18n.t('commands:knowledge.shareMessageNotFound', { ref: rest }) };
        }
        if (report.skipped) {
          return { reply: i18n.t('commands:knowledge.shareSkipped', { reason: report.skipped }) };
        }

        const page = knowledgePagesWrittenSince(service, startedAt)[0];
        if (!page) {
          return {
            reply: i18n.t('commands:knowledge.shareNoPage', {
              rejected: formatKnowledgeCounts(report.rejected),
              failed: report.failed,
            }),
          };
        }
        // Shadow mode is a review queue, not a failure: say which one happened so
        // "it worked" and "it is waiting for you" are not the same sentence.
        return {
          reply: i18n.t(
            page.status === 'active'
              ? 'commands:knowledge.shareDone'
              : 'commands:knowledge.shareDonePending',
            { address: knowledgePageAddress(page), title: page.title },
          ),
        };
      }

      default:
        return { reply: i18n.t('commands:knowledge.usage') };
    }
  } catch (err) {
    // A malformed JSON column (a hand-edited row) must not take the channel down.
    return {
      reply: i18n.t('commands:knowledge.failed', {
        error: err instanceof Error ? err.message : String(err),
      }),
    };
  }
}
