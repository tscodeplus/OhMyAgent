/**
 * beforeToolCall hook — extracted from agent-factory.ts.
 *
 * Handles two gate scenarios:
 *   1. Computer Use open_app approval — sends approval card, waits for decision
 *   2. Shell command approval — evaluates against policy, sends card if needed
 *
 * Profile gating itself lives in policy-center (tool visibility); this hook
 * carries the effective profile into the runtime policy scope.
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
import { toolApprovalSubject, type ToolPolicyInputWithSkill } from '../policy/policy-center.js';
import { approvalRiskForTool, getCapabilityForTool } from '../policy/tool-capability-registry.js';
import { getSkillToolPolicy } from './skill-activator.js';
import { generateId } from '../shared/ids.js';
import { extractPathArg } from '../shared/path-utils.js';
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
  try {
    fs.appendFileSync(CU_LOG, line + '\n', { mode: 0o600 });
  } catch {}
}

import { normalizeCommand, getReadOnlyShellBlockReason } from '../tools/shell-command-policy.js';

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
  /** Operator identity of the current message sender (e.g. Feishu open_id).
   *  Stored as the approval request's requester so approval callbacks can
   *  verify the clicker is the requester. */
  senderId?: string;
  /** Diagnostic logger (pino-compatible). */
  logger?: {
    warn: (...args: any[]) => void;
    info: (...args: any[]) => void;
    error: (...args: any[]) => void;
  };
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
  const {
    computerUseHost,
    approvalTimeoutMs,
    approvalRequestRepo,
    sessionId,
    pendingApprovals,
    agentConfig,
  } = deps;

  const appId = args?.target?.trim();
  const computerUseActions = new Set(['open_app', 'focus_app', 'close_app']);
  if (!args?.action || !computerUseActions.has(args.action) || !appId || !computerUseHost) {
    cuLog('handleComputerUseApproval: skip', {
      action: args?.action,
      appId,
      hasHost: !!computerUseHost,
    });
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
    deps.logger?.warn(
      {
        appId,
        channel: deps.channel,
        hasTurnContext: !!deps.turnContext,
        turnContextChatId: deps.turnContext?.chatId,
        fallbackChatId: deps.chatId,
      },
      '[CU:beforeToolCall] Computer Use app approval blocked: no activeChatId',
    );
    cuLog('handleComputerUseApproval: BLOCK no chatId', { appId });
    return {
      block: true,
      reason: i18n.t('feishu-cards:computerUse.notApproved', { appId }),
    } satisfies BeforeToolCallResult;
  }

  const session = resolveApprovalSession(deps, activeChatId, activeDispatcher);
  if (!session) {
    deps.logger?.warn(
      { appId, channel: deps.channel, hasChannelApprovalSender: !!deps.channelApprovalSender },
      '[CU:beforeToolCall] Computer Use app approval blocked: no approval channel available',
    );
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
      requesterId: deps.senderId,
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
  const {
    approvalGate,
    approvalTimeoutMs,
    approvalRequestRepo,
    sessionId,
    pendingApprovals,
    resolvedSkillScope,
  } = deps;

  const normalized = normalizeCommand(command);

  const evaluation = await approvalGate.evaluate({
    kind: 'shell',
    command: normalized,
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

    // Fail closed: without an interactive channel nobody can answer, so
    // awaiting a decision only stalls the turn until the inactivity watchdog
    // kills it — and a timeout_action of 'allow' would auto-approve a command
    // no human ever reviewed. Matches the file-access/generic-tool handlers.
    if (!session || !activeChatId) {
      return {
        block: true,
        reason: 'Shell command requires approval, but no interactive approval channel is available',
      } satisfies BeforeToolCallResult;
    }

    // Risk must be assessed unconditionally: approval-store only shields
    // 'high' from timeout auto-approval, so a false 'low' defeats that guard.
    const risk = assessCommandRisk(command);
    const cardMessageId = await session.present({
      requestId,
      command,
      risk,
      reason: rejectReason,
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
        targetKind: 'shell',
        reason: rejectReason,
        requesterId: deps.senderId,
      },
    );

    await session.resolve({
      requestId,
      decision: decisionType,
      cardMessageId,
      chatId: activeChatId,
      command,
    });

    if (approvalGate) {
      await approvalGate.recordDecision(requestId, decisionType, command, sessionId ?? undefined);
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
  const { approvalTimeoutMs, approvalRequestRepo, sessionId, pendingApprovals } = deps;

  const pathArg = extractApprovalPathArg(args);
  const command = `${toolName} ${pathArg}`;
  const approvalSubject = pathApprovalSubject(toolName, pathArg);
  const requestId = generateId();

  // Fail closed: without an interactive approval channel we cannot obtain user
  // consent for out-of-root file access — deny instead of silently allowing.
  // (In-root access never reaches this handler; path-policy allows it directly.)
  if (deps.channel !== 'feishu' && !deps.channelApprovalSender) {
    return {
      block: true,
      reason: `Tool "${toolName}" requires approval for ${pathArg}, but no interactive approval channel is available on this channel`,
    } satisfies BeforeToolCallResult;
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
      requesterId: deps.senderId,
      // Option B (report #6b): when a human approves this card, the store's
      // onFileServeApproved hook grants WebUI serving for this path (TTL).
      fileServePath: pathArg,
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
  const { approvalTimeoutMs, approvalRequestRepo, sessionId, pendingApprovals } = deps;
  const requestId = generateId();
  const command = `${toolName} ${JSON.stringify(args ?? {})}`;
  // Bind the recorded decision to what was actually approved. Keying it by the
  // bare tool name let one approve_session/approve_always on remote_trigger,
  // spawn_agent, memory_delete, … authorise every later call with any args.
  const subject = toolApprovalSubject(toolName, args);
  // Risk is not cosmetic: approval-store only shields 'high' requests from
  // `approval_timeout_action: allow`, so a hardcoded 'medium' silently
  // auto-approved high-risk tools when nobody was watching.
  const risk = approvalRiskForTool(toolName, args);

  const session = resolveApprovalSession(deps, activeChatId, activeDispatcher);
  if (!session || !activeChatId) {
    return {
      block: true,
      reason:
        reason ?? `Tool "${toolName}" requires approval, but no approval channel is available`,
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
      requesterId: deps.senderId,
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
  await deps.policyCenter
    .recordApprovalDecision({
      requestId: input.requestId,
      decision: input.decision,
      scope: input.decision.endsWith('_always') ? 'global' : 'session',
      kind: input.kind,
      sessionId: deps.sessionId,
      subject: input.subject,
      recordedAt: Date.now(),
    })
    .catch((err) => {
      deps.logger?.warn({ err }, 'Failed to record approval decision — non-critical');
    });
}

function pathApprovalSubject(toolName: string, path: string): string {
  return `${toolName}:${path}`;
}

function extractApprovalPathArg(args: unknown): string {
  return extractPathArg(args) ?? JSON.stringify(args);
}

// ═══════════════════════════════════════════════════════════════════════
// v4 PolicyCenter integration
// ═══════════════════════════════════════════════════════════════════════

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

  cuLog('handleViaPolicyCenter: called', {
    toolName: context.toolCall.name,
    args: JSON.stringify(context.args).slice(0, 100),
  });

  // Step 1: Build a minimal AgentPolicyScope from deps
  const scope = deps.policyScope ?? {
    toolsProfile: (deps.effectiveProfile || 'standard') as AgentPolicyScope['toolsProfile'],
    readRoots: [] as string[],
    writeRoots: [] as string[],
    deniedPatterns: [] as string[],
    shellExecMode: (deps.shellMode === 'read-only' ? 'safe' : 'balanced') as
      | 'safe'
      | 'balanced'
      | 'trusted',
    sessionApprovals: [] as string[],
    appApprovals: [] as string[],
    readOnly: deps.shellMode === 'read-only',
    // restricted is the no-escalation capability domain: no computer_use.
    computerUseEnabled: deps.effectiveProfile !== 'restricted',
    policyMode: 'balanced',
  };

  // Step 2: Build a capability descriptor for the tool
  const capability = getCapabilityForTool(context.toolCall.name, context.args);

  // Step 3: Call PolicyCenter.evaluateToolCall()
  const evaluationInput: ToolPolicyInputWithSkill = {
    toolName: context.toolCall.name,
    capability,
    args: context.args,
    sessionId: deps.sessionId,
    agentId: deps.policyAgentId ?? deps.agentConfig?.id,
    policyScope: scope,
    // Compiled skill allow/deny lists — enforced by the visibility check.
    skillToolOverrides: getSkillToolPolicy(deps.resolvedSkillScope),
  };
  const decision = await deps.policyCenter.evaluateToolCall(evaluationInput);

  // Step 4: Handle the decision
  cuLog('handleViaPolicyCenter: decision', {
    allowed: decision.allowed,
    requiresApproval: decision.requiresApproval,
    approvalKind: decision.approvalKind,
  });

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
    const action = (context.args as { action?: string })?.action;
    const computerUseResult = await handleComputerUseApproval(
      deps,
      context.args as { action?: string; target?: string },
      activeChatId ?? '',
      activeDispatcher,
    );
    if (computerUseResult) {
      return computerUseResult;
    }
    if (action === 'open_app' || action === 'focus_app' || action === 'close_app') {
      // App actions: undefined from handleComputerUseApproval means the app was
      // already approved (or got approved just now) — safe to allow.
      return undefined;
    }
    // Non-app CU actions (click_point, type_text, press_key, scroll, drag, …)
    // are mutating/high-risk too — do NOT allow silently; fall through to the
    // fail-closed generic approval path below.
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

function approveComputerUseAppFromPolicy(deps: BeforeToolCallDeps, args: unknown): void {
  if (!deps.computerUseHost || !args || typeof args !== 'object') return;
  const record = args as { action?: string; target?: string };
  if (
    record.action !== 'open_app' &&
    record.action !== 'focus_app' &&
    record.action !== 'close_app'
  ) {
    return;
  }
  const appId = record.target?.trim();
  if (!appId) return;

  deps.computerUseHost.approveApp(
    {
      sessionPath: deps.sessionId,
      agentId: deps.agentConfig?.id,
    },
    appId,
    'session',
  );
}

function checkReadOnlyShell(
  command: string,
  effectiveProfile: string,
): BeforeToolCallResult | undefined {
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
      return handleViaPolicyCenter(
        deps as BeforeToolCallDeps & {
          policyCenter: NonNullable<BeforeToolCallDeps['policyCenter']>;
        },
        context,
      );
    }

    // ── Legacy fallback path (policyCenter not injected) ──
    // v4: retained for backward compat. New code should inject policyCenter via BeforeToolCallDeps.
    const toolName = context.toolCall.name;
    const activeChatId = deps.turnContext?.chatId ?? deps.chatId;
    const activeMessageId = deps.turnContext?.messageId ?? deps.messageId;
    const activeDispatcher = deps.turnContext?.replyDispatcher;

    // ── Computer Use approval ──
    if (toolName === 'computer_use') {
      const cuArgs = context.args as { action?: string; target?: string };
      const computerUseResult = await handleComputerUseApproval(
        deps,
        cuArgs,
        activeChatId ?? '',
        activeDispatcher,
      );
      if (computerUseResult) {
        return computerUseResult;
      }
      const cuAction = cuArgs?.action;
      if (cuAction === 'open_app' || cuAction === 'focus_app' || cuAction === 'close_app') {
        // App actions: undefined from handleComputerUseApproval means the app
        // was already approved (or got approved just now) — safe to allow.
        return undefined;
      }
      // Non-app CU actions (click_point, type_text, press_key, …) are
      // mutating/high-risk — fail closed through the generic approval path.
      return handleGenericToolApproval(
        deps,
        toolName,
        context.args,
        `computer_use action "${cuAction ?? 'unknown'}" requires approval`,
        activeChatId ?? '',
        activeMessageId,
        activeDispatcher,
      );
    }

    // ── Non-shell tools ──
    // Without a PolicyCenter there is no visibility/path check, so previously
    // every tool except shell/computer_use returned `undefined` — an ungated
    // allow for memory_delete, spawn_agent, remote_trigger, … Fail closed
    // instead: anything whose capability says it needs approval goes through the
    // generic approval handler (which blocks when no UI can answer).
    if (toolName !== 'shell') {
      const capability = getCapabilityForTool(toolName, context.args);
      const needsApproval =
        capability.approvalDefault === 'high_risk' ||
        (capability.approvalDefault === 'mutating' && !capability.readOnly);
      if (!needsApproval) return undefined;

      return handleGenericToolApproval(
        deps,
        toolName,
        context.args,
        `Tool "${toolName}" requires approval`,
        activeChatId ?? '',
        activeMessageId,
        activeDispatcher,
      );
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
