/**
 * beforeToolCall hook — extracted from agent-factory.ts.
 *
 * Handles two gate scenarios:
 *   1. Computer Use open_app approval — sends approval card, waits for decision
 *   2. Shell command approval — evaluates against policy, sends card if needed
 *
 * Also enforces read-only shell mode for minimal-profile agents.
 */

import type { BeforeToolCallResult } from '../pi-mono/agent/types.js';
import type { ApprovalGate, ReplyDispatcher, ApprovalDecisionType } from '../app/types.js';
import type { AgentTurnContext } from './agent-factory.js';
import type { ApprovalRequestRepository } from '../memory/repositories/approval-request-repository.js';
import type {
  ApprovalUiPort,
  ApprovalUiSession,
  ApprovalUiSessionCache,
  ChannelApprovalSender,
} from './approval-ui-port.js';
import { channelSenderToSession } from './approval-ui-port.js';
import type { ComputerUseHost } from '../computer-use/computer-host.js';
import type { ResolvedAgentConfig } from './config-types.js';
import type { PendingApprovalStore } from './approval-store.js';
import type { AgentPolicyScope, ApprovalKind } from '../policy/types.js';
import { generateId } from '../shared/ids.js';
import { i18n } from '../i18n/index.js';
import { computerUseApprovalSubject } from '../computer-use/app-approval-subject.js';
import { assessCommandRisk } from '../tools/shell-command-policy.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Opt-in Computer Use approval tracing.
 *
 * Enabled only when OHMYAGENT_CU_DEBUG is set. Previously this always appended
 * to a world-readable /tmp/cu-debug.log and emitted console.warn on every
 * approval — leaking chat/app metadata into a shared path and spamming logs in
 * production. When disabled it is a no-op.
 */
const CU_DEBUG = !!process.env.OHMYAGENT_CU_DEBUG;
const CU_LOG = path.join(os.tmpdir(), `ohmyagent-cu-debug-${process.pid}.log`);
function cuLog(msg: string, data?: unknown) {
  if (!CU_DEBUG) return;
  const line = `[${new Date().toISOString()}] ${msg} ${data ? JSON.stringify(data) : ''}`;
  try { fs.appendFileSync(CU_LOG, line + '\n', { mode: 0o600 }); } catch {}
}

import {
  normalizeCommand,
  getReadOnlyShellBlockReason,
} from '../tools/shell-command-policy.js';

// ═══════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════

export interface BeforeToolCallDeps {
  approvalGate: ApprovalGate;
  /** Channel-agnostic approval UI port (Feishu impl injected at bootstrap). */
  approvalPort?: ApprovalUiPort;
  approvalTimeoutMs: number;
  approvalRequestRepo?: ApprovalRequestRepository;
  computerUseHost?: ComputerUseHost;
  pendingApprovals: PendingApprovalStore;
  sessionId?: string;
  chatId?: string;
  messageId?: string;
  turnContext?: AgentTurnContext;
  agentConfig?: ResolvedAgentConfig;
  resolvedSkillScope: { scope: 'global' | 'skill'; scopeKey: string };
  effectiveProfile: string;
  shellMode: 'full' | 'read-only';
  /** Non-Feishu channel approval message sender. */
  channelApprovalSender?: ChannelApprovalSender;
  /** Channel identifier for routing approval UI. */
  channel?: 'feishu' | 'telegram' | 'qq' | 'wechat';
  /** Optional v4 PolicyCenter for delegated tool gating. */
  policyCenter?: import('../policy/policy-center.js').PolicyCenter;
  /** Runtime policy scope, used by orchestrated child agents. */
  policyScope?: AgentPolicyScope;
  /** Runtime policy agent id, used by orchestrated child agents. */
  policyAgentId?: string;
}

/**
 * Resolve the approval UI session for this turn.
 *
 * Non-Feishu channels carry an explicit `channelApprovalSender`; everything
 * else goes through the injected `approvalPort` (Feishu). Returns undefined
 * when no approval UI is wired — callers decide whether that means block,
 * auto-allow, or proceed-without-card.
 */
function resolveApprovalSession(
  deps: BeforeToolCallDeps,
  activeChatId: string,
  activeDispatcher: ReplyDispatcher | undefined,
): ApprovalUiSession | undefined {
  if (deps.channel !== 'feishu' && deps.channelApprovalSender) {
    return channelSenderToSession(deps.channelApprovalSender);
  }
  if (deps.approvalPort && activeChatId) {
    return deps.approvalPort.getSession(
      { chatId: activeChatId, replyDispatcher: activeDispatcher },
      (deps.turnContext ?? {}) as ApprovalUiSessionCache,
    );
  }
  return undefined;
}

// ═══════════════════════════════════════════════════════════════════════
// Handlers
// ═══════════════════════════════════════════════════════════════════════

async function handleComputerUseApproval(
  deps: BeforeToolCallDeps,
  args: { action?: string; target?: string },
  activeChatId: string,
  activeDispatcher?: ReplyDispatcher,
): Promise<BeforeToolCallResult | undefined> {
  const { computerUseHost, approvalTimeoutMs, approvalRequestRepo, sessionId,
          pendingApprovals, agentConfig } = deps;

  const appId = args?.target?.trim();
  const computerUseActions = new Set(['open_app', 'focus_app', 'close_app']);
  if (!args?.action || !computerUseActions.has(args.action) || !appId || !computerUseHost) {
    cuLog('handleComputerUseApproval: skip', { action: args?.action, appId, hasHost: !!computerUseHost });
    return undefined;
  }

  const computerCtx = {
    sessionPath: sessionId,
    agentId: agentConfig?.id,
  };
  if (computerUseHost.isAppApproved(computerCtx, appId)) {
    cuLog('handleComputerUseApproval: app already approved', { appId, allowedApps: 'checking' });
    return undefined;
  }

  if (!activeChatId) {
    console.warn('[CU:beforeToolCall]', {
      appId,
      channel: deps.channel,
      hasTurnContext: !!deps.turnContext,
      turnContextChatId: deps.turnContext?.chatId,
      fallbackChatId: deps.chatId,
    }, 'Computer Use app approval blocked: no activeChatId');
    cuLog('handleComputerUseApproval: BLOCK no chatId', { appId });
    return {
      block: true,
      reason: i18n.t('feishu-cards:computerUse.notApproved', { appId }),
    } satisfies BeforeToolCallResult;
  }

  const session = resolveApprovalSession(deps, activeChatId, activeDispatcher);
  if (!session) {
    console.warn('[CU:beforeToolCall]', {
      appId,
      channel: deps.channel,
      hasChannelApprovalSender: !!deps.channelApprovalSender,
    }, 'Computer Use app approval blocked: no approval channel available');
    cuLog('handleComputerUseApproval: BLOCK no channel', { appId, channel: deps.channel });
    return {
      block: true,
      reason: i18n.t('feishu-cards:computerUse.notApproved', { appId }),
    } satisfies BeforeToolCallResult;
  }

  cuLog('handleComputerUseApproval: sending approval card', { appId, requestId: 'generating...' });

  const requestId = generateId();
  const approvalCommand = `computer_use open_app ${appId}`;
  const reason = i18n.t('feishu-cards:computerUse.notInAllowedApps', { appId });

  const cardMessageId = await session.present({
    requestId,
    command: approvalCommand,
    risk: 'high',
    reason,
    chatId: activeChatId,
    sessionId: sessionId ?? '',
  });

  const decisionType = await pendingApprovals.create(
    requestId,
    approvalTimeoutMs,
    approvalRequestRepo,
    sessionId ?? '',
    approvalCommand,
    'high',
    {
      chatId: activeChatId,
      threadId: deps.messageId,
      cardMessageId,
      targetKind: 'tool',
      toolName: 'computer_use',
      reason,
    },
  );

  await session.resolve({
    requestId,
    decision: decisionType,
    cardMessageId,
    chatId: activeChatId,
    command: approvalCommand,
  });

  if (decisionType.startsWith('reject')) {
    return {
      block: true,
      reason: i18n.t('feishu-cards:computerUse.rejectedByUser'),
    } satisfies BeforeToolCallResult;
  }

  // approve_once: allow just this one execution (one-shot, consumed on use)
  // approve_session: persist for the session so subsequent calls skip approval
  // approve_always: persist globally
  if (decisionType === 'approve_always') {
    await recordPolicyApprovalDecision(deps, {
      requestId,
      decision: decisionType,
      kind: 'tool',
      subject: computerUseApprovalSubject(args.action, appId),
    });
    computerUseHost.approveApp(computerCtx, appId, 'global');
  } else if (decisionType === 'approve_session') {
    await recordPolicyApprovalDecision(deps, {
      requestId,
      decision: decisionType,
      kind: 'tool',
      subject: computerUseApprovalSubject(args.action, appId),
    });
    computerUseHost.approveApp(computerCtx, appId, 'session');
  } else {
    // approve_once: one-shot, consumed by the next successful createLease
    computerUseHost.approveApp(computerCtx, appId, 'once');
  }
  return undefined;
}

async function handleShellApproval(
  deps: BeforeToolCallDeps,
  command: string,
  activeChatId: string,
  activeMessageId: string | undefined,
  activeDispatcher: ReplyDispatcher | undefined,
): Promise<BeforeToolCallResult | undefined> {
  const { approvalGate, approvalTimeoutMs, approvalRequestRepo, sessionId,
          pendingApprovals, resolvedSkillScope } = deps;

  const normalized = normalizeCommand(command);

  const evaluation = await approvalGate.evaluate({
    kind: 'shell',
    command: normalized as any,
    sessionKey: sessionId ?? '',
    scope: resolvedSkillScope.scope,
    scopeKey: resolvedSkillScope.scopeKey,
  });

  if (evaluation === 'rejected') {
    return {
      block: true,
      reason: 'Command denied by policy',
    } satisfies BeforeToolCallResult;
  }

  if (evaluation === 'requires_approval') {
    const requestId = generateId();
    const rejectReason = approvalGate?.lastRejectReason;
    const session = resolveApprovalSession(deps, activeChatId, activeDispatcher);

    const risk = session && activeChatId ? assessCommandRisk(command) : 'low';
    let cardMessageId: string | undefined;

    if (session && activeChatId) {
      cardMessageId = await session.present({
        requestId,
        command,
        risk,
        reason: rejectReason,
        chatId: activeChatId,
        sessionId: sessionId ?? '',
      });
    }

    const decisionType = await pendingApprovals.create(
      requestId,
      approvalTimeoutMs,
      approvalRequestRepo,
      sessionId ?? '',
      command,
      risk,
      {
        chatId: activeChatId,
        threadId: activeMessageId,
        cardMessageId,
        targetKind: 'shell',
        reason: rejectReason,
      },
    );

    if (session && activeChatId) {
      await session.resolve({
        requestId,
        decision: decisionType,
        cardMessageId,
        chatId: activeChatId,
        command,
      });
    }

    if (approvalGate) {
      await approvalGate.recordDecision(
        requestId,
        decisionType,
        command,
        sessionId ?? undefined,
      );
    }

    if (decisionType.startsWith('reject')) {
      return {
        block: true,
        reason: 'Command rejected by user',
      } satisfies BeforeToolCallResult;
    }
  }

  return undefined;
}

// ═══════════════════════════════════════════════════════════════════════
// File access approval (file_read / file_search path outside allowed roots)
// ═══════════════════════════════════════════════════════════════════════

async function handleFileAccessApproval(
  deps: BeforeToolCallDeps,
  toolName: string,
  args: unknown,
  reason: string,
  activeChatId: string,
  activeMessageId: string | undefined,
  activeDispatcher: ReplyDispatcher | undefined,
): Promise<BeforeToolCallResult | undefined> {
  const { approvalTimeoutMs, approvalRequestRepo, sessionId,
          pendingApprovals } = deps;

  const pathArg = extractApprovalPathArg(args);
  const command = `${toolName} ${pathArg}`;
  const approvalSubject = pathApprovalSubject(toolName, pathArg);
  const requestId = generateId();

  // Channels without interactive approval UI (e.g. WeChat) auto-allow
  // file access. Their send_media tools are already scoped by allowedRoots.
  if (deps.channel !== 'feishu' && !deps.channelApprovalSender) {
    return undefined;
  }

  const session = resolveApprovalSession(deps, activeChatId, activeDispatcher);
  let cardMessageId: string | undefined;

  if (session && activeChatId) {
    cardMessageId = await session.present({
      requestId,
      command,
      risk: 'low',
      reason,
      chatId: activeChatId,
      sessionId: sessionId ?? '',
    });
  }

  const decisionType = await pendingApprovals.create(
    requestId,
    approvalTimeoutMs,
    approvalRequestRepo,
    sessionId ?? '',
    command,
    'low',
    {
      chatId: activeChatId,
      threadId: activeMessageId,
      cardMessageId,
      targetKind: 'tool',
      toolName,
      reason,
      policyScope: 'path',
    },
  );

  if (session && activeChatId) {
    await session.resolve({
      requestId,
      decision: decisionType,
      cardMessageId,
      chatId: activeChatId,
      command,
    });
  }

  await recordPolicyApprovalDecision(deps, {
    requestId,
    decision: decisionType,
    kind: 'path',
    subject: approvalSubject,
  });

  if (decisionType.startsWith('reject')) {
    return {
      block: true,
      reason: 'File access rejected by user',
    } satisfies BeforeToolCallResult;
  }

  return undefined;
}

async function handleGenericToolApproval(
  deps: BeforeToolCallDeps,
  toolName: string,
  args: unknown,
  reason: string | undefined,
  activeChatId: string,
  activeMessageId: string | undefined,
  activeDispatcher: ReplyDispatcher | undefined,
): Promise<BeforeToolCallResult | undefined> {
  const { approvalTimeoutMs, approvalRequestRepo, sessionId,
          pendingApprovals } = deps;
  const requestId = generateId();
  const command = `${toolName} ${JSON.stringify(args ?? {})}`;
  const subject = toolName;
  const risk: 'low' | 'medium' | 'high' = 'medium';

  const session = resolveApprovalSession(deps, activeChatId, activeDispatcher);
  if (!session || !activeChatId) {
    return {
      block: true,
      reason: reason ?? `Tool "${toolName}" requires approval, but no approval channel is available`,
    } satisfies BeforeToolCallResult;
  }

  const cardMessageId = await session.present({
    requestId,
    command,
    risk,
    reason,
    chatId: activeChatId,
    sessionId: sessionId ?? '',
  });

  const decisionType = await pendingApprovals.create(
    requestId,
    approvalTimeoutMs,
    approvalRequestRepo,
    sessionId ?? '',
    command,
    risk,
    {
      chatId: activeChatId,
      threadId: activeMessageId,
      cardMessageId,
      targetKind: 'tool',
      toolName,
      reason,
    },
  );

  await session.resolve({
    requestId,
    decision: decisionType,
    cardMessageId,
    chatId: activeChatId,
    command,
  });

  await recordPolicyApprovalDecision(deps, {
    requestId,
    decision: decisionType,
    kind: 'tool',
    subject,
  });

  if (decisionType.startsWith('reject')) {
    return {
      block: true,
      reason: `Tool "${toolName}" rejected by user`,
    } satisfies BeforeToolCallResult;
  }

  return undefined;
}

async function recordPolicyApprovalDecision(
  deps: BeforeToolCallDeps,
  input: {
    requestId: string;
    decision: ApprovalDecisionType;
    kind: ApprovalKind;
    subject: string;
  },
): Promise<void> {
  if (!deps.policyCenter) return;
  if (input.decision === 'approve_once' || input.decision === 'reject_once') return;
  await deps.policyCenter.recordApprovalDecision({
    requestId: input.requestId,
    decision: input.decision,
    scope: input.decision.endsWith('_always') ? 'global' : 'session',
    kind: input.kind,
    sessionId: deps.sessionId,
    subject: input.subject,
    recordedAt: Date.now(),
  }).catch(() => {});
}

function pathApprovalSubject(toolName: string, path: string): string {
  return `${toolName}:${path}`;
}

function extractApprovalPathArg(args: unknown): string {
  if (!args || typeof args !== 'object') return JSON.stringify(args);
  const argsAny = args as Record<string, unknown>;
  for (const key of ['path', 'filePath', 'directory', 'imagePath', 'audioPath', 'cwd', 'outputPath', 'outputDir']) {
    const value = argsAny[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return JSON.stringify(args);
}

// ═══════════════════════════════════════════════════════════════════════
// v4 PolicyCenter integration
// ═══════════════════════════════════════════════════════════════════════

function getCapabilityForTool(
  toolName: string,
  args?: unknown,
): import('../tools/platform/tool-capabilities.js').ToolCapabilityDescriptor {
  if (toolName === 'send_message' && (args as { route?: string } | undefined)?.route === 'external') {
    return {
      category: 'task',
      readOnly: false,
      writesFiles: false,
      readsFiles: false,
      usesShell: false,
      usesNetwork: true,
      usesComputerUse: false,
      pathAccess: 'none',
      approvalDefault: 'high_risk',
    };
  }
	  // cronjob remove action is destructive — requires approval
	  if (toolName === 'cronjob' && (args as { action?: string } | undefined)?.action === 'remove') {
	    return {
	      category: 'cron',
	      readOnly: false,
	      writesFiles: false,
	      readsFiles: false,
	      usesShell: false,
	      usesNetwork: false,
	      usesComputerUse: false,
	      pathAccess: 'none',
	      approvalDefault: 'mutating',
	    };
	  }

  const map: Record<string, any> = {
    shell:          { category: 'shell', readOnly: false, writesFiles: true, readsFiles: true, usesShell: true,  usesNetwork: false, usesComputerUse: false, pathAccess: 'read_write', approvalDefault: 'mutating' },
    file_read:      { category: 'file', readOnly: true,  writesFiles: false, readsFiles: true, usesShell: false, usesNetwork: false, usesComputerUse: false, pathAccess: 'read', approvalDefault: 'none' },
    file_write:     { category: 'file', readOnly: false, writesFiles: true, readsFiles: false, usesShell: false, usesNetwork: false, usesComputerUse: false, pathAccess: 'write', approvalDefault: 'mutating' },
    file_edit:      { category: 'file', readOnly: false, writesFiles: true, readsFiles: true, usesShell: false, usesNetwork: false, usesComputerUse: false, pathAccess: 'read_write', approvalDefault: 'mutating' },
    file_search:    { category: 'file', readOnly: true,  writesFiles: false, readsFiles: true, usesShell: false, usesNetwork: false, usesComputerUse: false, pathAccess: 'read', approvalDefault: 'none' },
    memory_recall:  { category: 'memory', readOnly: true, writesFiles: false, readsFiles: false, usesShell: false, usesNetwork: false, usesComputerUse: false, pathAccess: 'none', approvalDefault: 'none' },
    memory_store:   { category: 'memory', readOnly: false, writesFiles: false, readsFiles: false, usesShell: false, usesNetwork: false, usesComputerUse: false, pathAccess: 'none', approvalDefault: 'mutating' },
    memory_list:    { category: 'memory', readOnly: true, writesFiles: false, readsFiles: false, usesShell: false, usesNetwork: false, usesComputerUse: false, pathAccess: 'none', approvalDefault: 'none' },
    memory_delete:  { category: 'memory', readOnly: false, writesFiles: false, readsFiles: false, usesShell: false, usesNetwork: false, usesComputerUse: false, pathAccess: 'none', approvalDefault: 'mutating' },
    memory_update:  { category: 'memory', readOnly: false, writesFiles: false, readsFiles: false, usesShell: false, usesNetwork: false, usesComputerUse: false, pathAccess: 'none', approvalDefault: 'mutating' },
    session_summarize: { category: 'session', readOnly: true, writesFiles: false, readsFiles: false, usesShell: false, usesNetwork: false, usesComputerUse: false, pathAccess: 'none', approvalDefault: 'none' },
    web_fetch:      { category: 'web', readOnly: true, writesFiles: false, readsFiles: false, usesShell: false, usesNetwork: true, usesComputerUse: false, pathAccess: 'none', approvalDefault: 'none' },
    web_search:     { category: 'web', readOnly: true, writesFiles: false, readsFiles: false, usesShell: false, usesNetwork: true, usesComputerUse: false, pathAccess: 'none', approvalDefault: 'none' },
    image_to_text:  { category: 'multimodal', readOnly: true, writesFiles: false, readsFiles: true, usesShell: false, usesNetwork: false, usesComputerUse: false, pathAccess: 'read', approvalDefault: 'none' },
    computer_use:   { category: 'computer_use', readOnly: false, writesFiles: false, readsFiles: false, usesShell: false, usesNetwork: false, usesComputerUse: true, pathAccess: 'none', approvalDefault: 'high_risk' },
    spawn_agent:    { category: 'agent', readOnly: false, writesFiles: false, readsFiles: false, usesShell: false, usesNetwork: false, usesComputerUse: false, pathAccess: 'none', approvalDefault: 'mutating' },
    cronjob:        { category: 'cron', readOnly: false, writesFiles: false, readsFiles: false, usesShell: false, usesNetwork: false, usesComputerUse: false, pathAccess: 'none', approvalDefault: 'none' },
    ask_user_question: { category: 'session', readOnly: true, writesFiles: false, readsFiles: false, usesShell: false, usesNetwork: false, usesComputerUse: false, pathAccess: 'none', approvalDefault: 'none' },
    todo_write:     { category: 'session', readOnly: false, writesFiles: false, readsFiles: false, usesShell: false, usesNetwork: false, usesComputerUse: false, pathAccess: 'none', approvalDefault: 'mutating' },
    task_create:    { category: 'task', readOnly: false, writesFiles: false, readsFiles: false, usesShell: false, usesNetwork: false, usesComputerUse: false, pathAccess: 'none', approvalDefault: 'none' },
    task_get:       { category: 'task', readOnly: true,  writesFiles: false, readsFiles: false, usesShell: false, usesNetwork: false, usesComputerUse: false, pathAccess: 'none', approvalDefault: 'none' },
    task_list:      { category: 'task', readOnly: true,  writesFiles: false, readsFiles: false, usesShell: false, usesNetwork: false, usesComputerUse: false, pathAccess: 'none', approvalDefault: 'none' },
    task_stop:      { category: 'task', readOnly: false, writesFiles: false, readsFiles: false, usesShell: false, usesNetwork: false, usesComputerUse: false, pathAccess: 'none', approvalDefault: 'none' },
    task_output:    { category: 'task', readOnly: true,  writesFiles: false, readsFiles: false, usesShell: false, usesNetwork: false, usesComputerUse: false, pathAccess: 'none', approvalDefault: 'none' },
    task_update:    { category: 'task', readOnly: false, writesFiles: false, readsFiles: false, usesShell: false, usesNetwork: false, usesComputerUse: false, pathAccess: 'none', approvalDefault: 'none' },
    send_message:   { category: 'task', readOnly: false, writesFiles: false, readsFiles: false, usesShell: false, usesNetwork: false, usesComputerUse: false, pathAccess: 'none', approvalDefault: 'none' },
    team_create:    { category: 'task', readOnly: false, writesFiles: false, readsFiles: false, usesShell: false, usesNetwork: false, usesComputerUse: false, pathAccess: 'none', approvalDefault: 'mutating' },
    team_delete:    { category: 'task', readOnly: false, writesFiles: false, readsFiles: false, usesShell: false, usesNetwork: false, usesComputerUse: false, pathAccess: 'none', approvalDefault: 'mutating' },
    enter_plan_mode: { category: 'session', readOnly: false, writesFiles: false, readsFiles: false, usesShell: false, usesNetwork: false, usesComputerUse: false, pathAccess: 'none', approvalDefault: 'none' },
    exit_plan_mode: { category: 'session', readOnly: false, writesFiles: false, readsFiles: false, usesShell: false, usesNetwork: false, usesComputerUse: false, pathAccess: 'none', approvalDefault: 'none' },
    enter_worktree: { category: 'session', readOnly: false, writesFiles: true, readsFiles: true, usesShell: true, usesNetwork: false, usesComputerUse: false, pathAccess: 'read_write', approvalDefault: 'mutating' },
    exit_worktree:  { category: 'session', readOnly: false, writesFiles: true, readsFiles: true, usesShell: true, usesNetwork: false, usesComputerUse: false, pathAccess: 'read_write', approvalDefault: 'mutating' },
    // New v4 final tools
    notebook_edit:  { category: 'file', readOnly: false, readsFiles: true, writesFiles: true, usesShell: false, usesNetwork: false, usesComputerUse: false, pathAccess: 'read_write', approvalDefault: 'mutating' },
    remote_trigger: { category: 'web', readOnly: false, writesFiles: false, readsFiles: false, usesShell: false, usesNetwork: true, usesComputerUse: false, pathAccess: 'none', approvalDefault: 'high_risk' },
    image_generation: { category: 'multimodal', readOnly: false, writesFiles: true, readsFiles: false, usesShell: false, usesNetwork: true, usesComputerUse: false, pathAccess: 'write', approvalDefault: 'mutating' },
    // Channel media tools
	    feishu_send_media: { category: 'session', readOnly: false, writesFiles: false, readsFiles: true, usesShell: false, usesNetwork: true, usesComputerUse: false, pathAccess: 'read', approvalDefault: 'none' },
	    wechat_send_media: { category: 'session', readOnly: false, writesFiles: false, readsFiles: true, usesShell: false, usesNetwork: true, usesComputerUse: false, pathAccess: 'read', approvalDefault: 'none' },
	    qq_send_media:     { category: 'session', readOnly: false, writesFiles: false, readsFiles: true, usesShell: false, usesNetwork: true, usesComputerUse: false, pathAccess: 'read', approvalDefault: 'none' },
	    telegram_send_media: { category: 'session', readOnly: false, writesFiles: false, readsFiles: true, usesShell: false, usesNetwork: true, usesComputerUse: false, pathAccess: 'read', approvalDefault: 'none' },
	    webui_send_media: { category: 'session', readOnly: true, writesFiles: false, readsFiles: true, usesShell: false, usesNetwork: false, usesComputerUse: false, pathAccess: 'read', approvalDefault: 'none' },
  };
  return map[toolName] ?? { category: 'session', readOnly: true, writesFiles: false, readsFiles: false, usesShell: false, usesNetwork: false, usesComputerUse: false, pathAccess: 'none', approvalDefault: 'none' };
}

async function handleViaPolicyCenter(
  deps: BeforeToolCallDeps & { policyCenter: NonNullable<BeforeToolCallDeps['policyCenter']> },
  context: { toolCall: { name: string }; args: unknown },
): Promise<BeforeToolCallResult | undefined> {
  const activeChatId = deps.turnContext?.chatId ?? deps.chatId;
  const activeMessageId = deps.turnContext?.messageId ?? deps.messageId;
  const activeDispatcher = deps.turnContext?.replyDispatcher;

  // Eagerly create the approval UI session before any await so parallel tool
  // calls in the same batch share one session (no lazy-init race).
  if (deps.channel === 'feishu' && activeChatId) {
    resolveApprovalSession(deps, activeChatId, activeDispatcher);
  }

  cuLog('handleViaPolicyCenter: called', { toolName: context.toolCall.name, args: JSON.stringify(context.args).slice(0, 100) });

  // Step 1: Build a minimal AgentPolicyScope from deps
  const scope = deps.policyScope ?? {
    toolsProfile: (deps.effectiveProfile || 'standard') as 'minimal' | 'standard' | 'advanced' | 'full',
    readRoots: [] as string[],
    writeRoots: [] as string[],
    deniedPatterns: [] as string[],
    shellExecMode: (deps.shellMode === 'read-only' ? 'safe' : 'balanced') as 'safe' | 'balanced' | 'trusted',
    sessionApprovals: [] as string[],
    appApprovals: [] as string[],
    readOnly: deps.shellMode === 'read-only',
    computerUseEnabled: deps.effectiveProfile !== 'minimal',
  };

  // Step 2: Build a capability descriptor for the tool
  const capability = getCapabilityForTool(context.toolCall.name, context.args);

  // Step 3: Call PolicyCenter.evaluateToolCall()
  const decision = await deps.policyCenter.evaluateToolCall({
    toolName: context.toolCall.name,
    capability,
    args: context.args,
    sessionId: deps.sessionId,
    agentId: deps.policyAgentId ?? deps.agentConfig?.id,
    policyScope: scope,
  });

  // Step 4: Handle the decision
  cuLog('handleViaPolicyCenter: decision', { allowed: decision.allowed, requiresApproval: decision.requiresApproval, approvalKind: decision.approvalKind });

  if (decision.allowed) {
    cuLog('handleViaPolicyCenter: allowed, approving app from policy');
    approveComputerUseAppFromPolicy(deps, context.args);
    return undefined; // allow
  }

  if (!decision.requiresApproval) {
    cuLog('handleViaPolicyCenter: BLOCK denied', { reason: decision.reason });
    return { block: true, reason: decision.reason ?? 'Denied by policy' };
  }

  // Step 5: Requires approval → reuse existing approval UI send logic
  if (context.toolCall.name === 'shell') {
    const shellArgs = context.args as { command?: string };
    return handleShellApproval(
      deps,
      shellArgs?.command ?? '',
      activeChatId ?? '',
      activeMessageId,
      activeDispatcher,
    );
  }

  if (context.toolCall.name === 'computer_use') {
    const computerUseResult = await handleComputerUseApproval(
      deps,
      context.args as { action?: string; target?: string },
      activeChatId ?? '',
      activeDispatcher,
    );
    const action = (context.args as { action?: string })?.action;
    if (computerUseResult || action === 'open_app' || action === 'focus_app' || action === 'close_app') {
      return computerUseResult;
    }
    return undefined;
  }

  if (decision.approvalKind === 'path') {
    return handleFileAccessApproval(
      deps,
      context.toolCall.name,
      context.args,
      decision.reason ?? '',
      activeChatId ?? '',
      activeMessageId,
      activeDispatcher,
    );
  }

  return handleGenericToolApproval(
    deps,
    context.toolCall.name,
    context.args,
    decision.reason,
    activeChatId ?? '',
    activeMessageId,
    activeDispatcher,
  );
}

function approveComputerUseAppFromPolicy(
  deps: BeforeToolCallDeps,
  args: unknown,
): void {
  if (!deps.computerUseHost || !args || typeof args !== 'object') return;
  const record = args as { action?: string; target?: string };
  if (
    record.action !== 'open_app'
    && record.action !== 'focus_app'
    && record.action !== 'close_app'
  ) {
    return;
  }
  const appId = record.target?.trim();
  if (!appId) return;

  deps.computerUseHost.approveApp({
    sessionPath: deps.sessionId,
    agentId: deps.agentConfig?.id,
  }, appId, 'session');
}

function checkReadOnlyShell(command: string, effectiveProfile: string): BeforeToolCallResult | undefined {
  const reason = getReadOnlyShellBlockReason(command, effectiveProfile);
  if (reason) return { block: true, reason } satisfies BeforeToolCallResult;
  return undefined;
}

// ═══════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════

/**
 * Create the beforeToolCall hook that gates shell commands and
 * Computer Use app launches behind user approval.
 */
export function createBeforeToolCall(deps: BeforeToolCallDeps) {
  return async (context: {
    toolCall: { name: string };
    args: unknown;
  }): Promise<BeforeToolCallResult | undefined> => {

    // ── v4 path: delegate to PolicyCenter ──
    if (deps.policyCenter) {
      return handleViaPolicyCenter(deps as any, context);
    }

    // ── Legacy fallback path (policyCenter not injected) ──
    // v4: retained for backward compat. New code should inject policyCenter via BeforeToolCallDeps.
    const toolName = context.toolCall.name;
    const activeChatId = deps.turnContext?.chatId ?? deps.chatId;
    const activeMessageId = deps.turnContext?.messageId ?? deps.messageId;
    const activeDispatcher = deps.turnContext?.replyDispatcher;

    // ── Computer Use open_app approval ──
    if (toolName === 'computer_use') {
      return handleComputerUseApproval(
        deps,
        context.args as { action?: string; target?: string },
        activeChatId ?? '',
        activeDispatcher,
      );
    }

    // ── Only gate the shell tool ──
    if (toolName !== 'shell') {
      return undefined;
    }

    const args = context.args as { command?: string };
    if (!args?.command) {
      return undefined;
    }

    // ── Read-only shell mode check ──
    if (deps.shellMode === 'read-only') {
      const blocked = checkReadOnlyShell(args.command, deps.effectiveProfile);
      if (blocked) return blocked;
    }

    // ── Shell approval gate ──
    return handleShellApproval(
      deps,
      args.command,
      activeChatId ?? '',
      activeMessageId,
      activeDispatcher,
    );
  };
}

function summarizeApprovalCommand(command: string): string {
  const normalized = command.trim().replace(/\s+/g, ' ');
  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
}
