/**
 * Chat SSE Streaming Routes
 *
 * POST /api/projects/:projectId/chat
 * Body: { sessionId, message }
 * Returns: SSE stream with text_delta, tool_call_start, tool_call_end, thinking, done, error events
 */

import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { AgentService } from '../../agent/agent-service.js';
import type { ReplyDispatcher, Usage, FooterConfig } from '../types.js';
import type { ProjectStore } from './project-store.js';
import type { AgentManager } from '../../agent/agent-manager.js';
import type { AppConfig } from '../../app/types.js';
import { resolveModelRef } from '../../agent/model-resolver.js';
import type { ApprovalDecisionType } from '../types.js';
import type { CommandDeps } from '../../commands/command-handler.js';
import type { CommandRegistry } from '../../commands/command-registry.js';
import type { WebSocketManager } from './websocket.js';
import { handleCommand } from '../../commands/command-handler.js';
import { computeCacheHitRate } from '../../channel/usage-summary.js';
import { createWebUIApprovalSender } from './approval-sender.js';
import { createWebUIUserQuestionSender } from './user-question-sender.js';
import type { UserQuestionSender } from '../../agent/user-question-port.js';
import { safeEqual } from '../../shared/safe-equal.js';
// Reuse the gateway's existing sliding-window limiter rather than a second
// implementation. (Ideally this class lives in src/shared — src/ should not
// depend on extensions/ — but moving it is out of scope for these routes.)
import { SlidingWindowRateLimiter } from '../../../extensions/channel-telegram/rate-limiter.js';
import { createSendMediaTool } from '../../tools/builtins/multimodal/send-media-tool.js';
import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAppVersion } from '../version.js';
import { dataPath } from '../../shared/agent-home.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEBUG_LOG = dataPath('webui-debug.log');
function debugLog(msg: string, data?: Record<string, unknown>): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}${data ? ' ' + JSON.stringify(data) : ''}\n`;
  try {
    fs.appendFileSync(DEBUG_LOG, line);
  } catch {
    /* ignore */
  }
}

// ─── SSE-aware ReplyDispatcher ───

interface SSECallback {
  (event: Record<string, unknown>): void;
}

class SSEReplyDispatcher implements ReplyDispatcher {
  private callback: SSECallback;
  private replyMessageId?: string;
  private model = '';
  private agentName = '';
  private startTime = 0;
  private footerConfig: FooterConfig;
  private db: Database.Database | undefined;
  private sessionId: string | undefined;
  /** Maps approvalId → messageId for updates on resolution. */
  private approvalMsgIds = new Map<string, string>();
  private showSkillCalls: boolean;
  showToolCalls: boolean; // public — read by agent-service for persistence gating
  private logger?: { warn: (...args: any[]) => void };

  constructor(
    callback: SSECallback,
    footerConfig?: FooterConfig,
    db?: Database.Database,
    sessionId?: string,
    showSkillCalls = true,
    showToolCalls = true,
    logger?: { warn: (...args: any[]) => void },
    harnessRegistry?: Map<
      string,
      (result: import('../../harness/types.js').HarnessApprovalResult) => void
    >,
  ) {
    this._harnessRegistry = harnessRegistry;
    this.callback = callback;
    this.footerConfig = footerConfig ?? {
      showAgentName: true,
      showModel: true,
      showCompleted: false,
      showElapsed: true,
      showUsage: false,
      showCacheHitRate: false,
    };
    this.db = db;
    this.sessionId = sessionId;
    this.showSkillCalls = showSkillCalls;
    this.showToolCalls = showToolCalls;
    this.logger = logger;
  }

  onStart(): void {
    this.startTime = Date.now();
    // Signal frontend to create a new assistant message bubble for this turn.
    // This separates steer/follow-up responses from the original reply.
    debugLog('SSE onStart → turn_start');
    this.callback({ type: 'turn_start' });
  }
  setModel(model: string): void {
    this.model = model;
  }
  setAgentName(name: string): void {
    this.agentName = name;
  }
  onSkillActivated(skillName: string): void {
    if (!this.showSkillCalls) return;
    // Send as a dedicated skill_activated event so the frontend can render it
    // as a card-style segment (like tool calls) and persist it in block-order
    // metadata for survival across page refreshes.
    this.callback({ type: 'skill_activated', data: skillName });
  }
  onStreamRetry(info: {
    scope: 'retry' | 'fallback';
    failedModel: string;
    model: string;
    attempt: number;
    maxRetries: number;
    delayMs: number;
  }): void {
    // Transient status — the WebUI renders it as a streaming indicator line.
    this.callback({ type: 'stream_retry', data: JSON.stringify(info) });
  }
  setApprovalStatus(status: string | null): void {
    if (status) {
      this.callback({ type: 'approval_status', data: status });
    }
  }
  setApprovalRecords(
    records: Array<{
      requestId: string;
      command: string;
      risk: 'low' | 'medium' | 'high';
      status: 'pending' | 'approved' | 'rejected';
      decision?: ApprovalDecisionType;
      reason?: string;
      updatedAt: number;
    }>,
    _expanded: boolean,
  ): void {
    // Forward approval records as SSE events so the frontend can render them.
    // Each record maps to an approval card in the chat view.
    for (const record of records) {
      if (record.status === 'pending') {
        this.callback({
          type: 'approval_required',
          approvalId: record.requestId,
          command: record.command,
          risk: record.risk,
          reason: record.reason ?? '',
        });
        // Persist approval request as a message so it survives page refresh
        this.persistApprovalMessage(
          record.requestId,
          record.command,
          record.risk,
          'pending',
          record.reason,
        );
      } else {
        this.callback({
          type: 'approval_resolved',
          approvalId: record.requestId,
          decision:
            record.decision ?? (record.status === 'approved' ? 'approve_once' : 'reject_once'),
        });
        // Update the persisted approval message with resolved status
        this.updateApprovalMessage(record.requestId, record.status, record.decision);
      }
    }
  }

  /** Save an approval request as a message in the database. */
  private persistApprovalMessage(
    approvalId: string,
    command: string,
    risk: string,
    status: string,
    reason?: string,
  ): void {
    if (!this.db || !this.sessionId) return;
    try {
      // Use the same ID format as the frontend streaming message
      // so the merge in MessageList.displayMessages deduplicates by ID.
      const msgId = `approval-${approvalId}`;
      const meta = JSON.stringify({
        approval: { approvalId, command, risk, status, reason: reason ?? '' },
      });
      // Use INSERT OR REPLACE to handle the case where the approval is
      // re-sent (e.g. after agent restart with recovered approvals).
      this.db
        .prepare(
          "INSERT OR REPLACE INTO messages (id, session_id, role, content, created_at, metadata) VALUES (?, ?, 'assistant', ?, ?, ?)",
        )
        .run(msgId, this.sessionId, '', Date.now(), meta);
      this.approvalMsgIds.set(approvalId, msgId);
    } catch (err) {
      this.logger?.warn('[chat] Failed to persist approval message:', err);
    }
  }

  /** Update an existing approval message's status after resolution. */
  private updateApprovalMessage(approvalId: string, status: string, decision?: string): void {
    if (!this.db || !this.sessionId) return;
    try {
      // Message ID uses the same format as persistApprovalMessage and the
      // frontend streaming id — "approval-{approvalId}".
      const msgId = `approval-${approvalId}`;
      const row = this.db.prepare('SELECT metadata FROM messages WHERE id = ?').get(msgId) as
        { metadata: string | null } | undefined;
      if (row) {
        let meta: Record<string, unknown> = {};
        try {
          meta = row.metadata ? JSON.parse(String(row.metadata)) : {};
        } catch {
          /* ignore */
        }
        const approval = (meta.approval || {}) as Record<string, unknown>;
        approval.status = status;
        if (decision) approval.decision = decision;
        meta.approval = approval;
        this.db
          .prepare('UPDATE messages SET metadata = ? WHERE id = ?')
          .run(JSON.stringify(meta), msgId);
        this.approvalMsgIds.set(approvalId, msgId);
      }
    } catch (err) {
      this.logger?.warn({ err }, '[chat] Failed to update approval message');
    }
  }
  getReplyMessageId(): string | undefined {
    return this.replyMessageId;
  }

  onTextDelta(delta: string): void {
    this.callback({ type: 'text_delta', data: delta });
  }

  onReasoningDelta(delta: string): void {
    this.callback({ type: 'thinking', data: delta });
  }

  onToolStart(name: string, args: unknown, toolCallId?: string): void {
    if (!this.showToolCalls) return;
    this.callback({ type: 'tool_call_start', toolName: name, data: args, toolCallId });
  }

  onToolEnd(name: string, result: unknown, isError?: boolean, toolCallId?: string): void {
    if (!this.showToolCalls) return;
    this.callback({
      type: 'tool_call_end',
      toolName: name,
      data: typeof result === 'string' ? result : JSON.stringify(result),
      isError: !!isError,
      toolCallId,
    });
  }

  /**
   * Build footer parts matching Feishu's buildCompletedCard format.
   * Order: agentName · completed · elapsed · model · usage · cacheHitRate
   */
  onComplete(usage?: Usage): void {
    const elapsed = this.startTime ? Date.now() - this.startTime : 0;
    debugLog('SSE onComplete → done', { elapsed });
    this.callback({
      type: 'done',
      footer: {
        model: this.footerConfig.showModel ? this.model : undefined,
        agentName: this.footerConfig.showAgentName ? this.agentName : undefined,
        completed: this.footerConfig.showCompleted !== false,
        elapsed: this.footerConfig.showElapsed ? elapsed : undefined,
        usage: usage
          ? {
              input: usage.input,
              output: usage.output,
              cacheRead: usage.cacheRead,
              cacheWrite: usage.cacheWrite,
            }
          : undefined,
        showUsage: this.footerConfig.showUsage ?? false,
        showCacheHitRate: this.footerConfig.showCacheHitRate ?? false,
      },
    });
  }

  onError(error: Error): void {
    debugLog('SSE onError', { error: error.message });
    this.callback({ type: 'error', error: error.message });
  }

  onAborted(): void {
    debugLog('SSE onAborted');
    this.callback({ type: 'error', error: 'Aborted' });
  }

  // ── Harness improvement proposal support ──

  /** Shared registry (per ChatRouteConfig) that the decide endpoint uses to
   *  resolve a user's button click back to the pending promise. */
  private _harnessRegistry?: Map<
    string,
    (result: import('../../harness/types.js').HarnessApprovalResult) => void
  >;

  async requestHarnessApproval(
    prompt: import('../../harness/types.js').HarnessImprovementPrompt,
    timeoutMs?: number,
  ): Promise<import('../../harness/types.js').HarnessApprovalResult> {
    // Send SSE event to the frontend
    this.callback({ type: 'harness_improvement', proposal: prompt });

    // Create a promise that resolves when the user responds (or times out)
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this._harnessRegistry?.delete(prompt.id);
        resolve({ decision: 'timeout' as import('../../harness/types.js').ApprovalDecision });
      }, timeoutMs ?? 120_000);

      // Store the resolver keyed by proposal ID in the shared registry so
      // POST /api/harness/proposals/:id/decide can resolve it.
      if (!this._harnessRegistry) {
        // No registry wired (e.g. tests): resolve on timeout only.
        return;
      }
      this._harnessRegistry.set(prompt.id, (result) => {
        this._harnessRegistry?.delete(prompt.id);
        clearTimeout(timeout);
        resolve(result);
      });
    });
  }
}

// ─── Chat Route Config ───

export interface ChatRouteConfig {
  agentService: AgentService;
  projectStore: ProjectStore;
  db?: Database.Database;
  getFooterConfig?: () => FooterConfig;
  /** Lazy getter for showSkillCalls — reads current config so setting changes take effect immediately. */
  getShowSkillCalls?: () => boolean;
  /** Lazy getter for showToolCalls. */
  getShowToolCalls?: () => boolean;
  agentManager?: AgentManager;
  /** Lazy getter for the app config — used to resolve the chat input's
   *  model override (provider/modelId ref → ModelInstance). */
  getConfig?: () => AppConfig;
  commandDeps?: CommandDeps;
  commandRegistry?: CommandRegistry;
  wsManager?: WebSocketManager;
  /** Registry for per-session UserQuestionSender instances (ask_user_question tool). */
  userQuestionSenderRegistry?: Map<string, UserQuestionSender>;
  /** Registry for pending harness approval promises (SSE → decide endpoint). */
  harnessApprovalRegistry?: Map<
    string,
    (result: import('../../harness/types.js').HarnessApprovalResult) => void
  >;
}

// ─── Login throttling ───
//
// POST /api/auth/login is the only authentication factor on the public API
// surface and used to be unlimited. Budgets (documented on purpose):
//   per IP: 20 attempts / 60 s. The WebUI attempts exactly one login per page
//     load, so this tolerates a whole office or phone fleet behind one NAT
//     egress (≈20 reloads a minute) while still cutting online guessing of a
//     weak WEBUI_TOKEN by two orders of magnitude.
//   global: 120 attempts / 60 s across all clients. The per-IP key is only as
//     good as the client address, and the server runs with trustProxy enabled
//     (extensions/channel-feishu/feishu-server.ts), so X-Forwarded-For can be
//     rotated. Without a direct-connection deployment the global window is the
//     limit that actually bounds a brute-force run.
export const LOGIN_WINDOW_MS = 60_000;
export const LOGIN_MAX_ATTEMPTS_PER_IP = 20;
export const LOGIN_MAX_ATTEMPTS_GLOBAL = 120;

let loginRateLimiter = new SlidingWindowRateLimiter(LOGIN_MAX_ATTEMPTS_PER_IP, LOGIN_WINDOW_MS);
let loginRateLimiterGlobal = new SlidingWindowRateLimiter(
  LOGIN_MAX_ATTEMPTS_GLOBAL,
  LOGIN_WINDOW_MS,
);

/** Test seam: drop all accumulated login-attempt state. */
export function resetLoginRateLimits(): void {
  loginRateLimiter.destroy();
  loginRateLimiterGlobal.destroy();
  loginRateLimiter = new SlidingWindowRateLimiter(LOGIN_MAX_ATTEMPTS_PER_IP, LOGIN_WINDOW_MS);
  loginRateLimiterGlobal = new SlidingWindowRateLimiter(LOGIN_MAX_ATTEMPTS_GLOBAL, LOGIN_WINDOW_MS);
}

export function registerChatRoutes(app: FastifyInstance, cfg: ChatRouteConfig): void {
  // Auth endpoint — used by frontend to validate token
  app.post('/api/auth/login', async (request, reply) => {
    // Counted before the token comparison so guessing and reload storms share
    // one budget. Rejecting a legitimate user for a minute is recoverable;
    // an unthrottled oracle is not.
    const throttled =
      !loginRateLimiter.check(request.ip || 'unknown') || !loginRateLimiterGlobal.check('global');
    if (throttled) {
      return reply
        .header('Retry-After', String(Math.ceil(LOGIN_WINDOW_MS / 1000)))
        .status(429)
        .send({ error: 'Too Many Requests', message: 'Too many login attempts, try again later' });
    }

    const { token } = request.body as { token?: string };
    const { getWebUIToken } = await import('../webui-auth.js');
    if (!token || !safeEqual(token, getWebUIToken())) {
      return reply.status(401).send({ error: 'Unauthorized', message: 'Invalid token' });
    }
    return reply.send({ ok: true, token: getWebUIToken() });
  });

  // Verify token endpoint
  app.get('/api/auth/verify', async (request, reply) => {
    const header = request.headers.authorization;
    if (!header) {
      return reply.send({ valid: false });
    }
    const token = header.split(' ')[1];
    const { getWebUIToken } = await import('../webui-auth.js');
    return reply.send({ valid: safeEqual(token, getWebUIToken()) });
  });

  // Health check — uses cached version so in-flight git updates
  // don't change the reported version before restart.
  app.get('/api/health', async (_request, reply) => {
    return reply.send({
      ok: true,
      version: getAppVersion(),
      timestamp: new Date().toISOString(),
    });
  });

  // SSE chat endpoint
  app.post('/api/projects/:projectId/chat', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const {
      sessionId,
      message: rawMessage,
      clientMsgId,
      agentId: requestedAgentId,
      model: requestedModelRef,
      reasoningLevel: requestedReasoningLevel,
    } = request.body as {
      sessionId?: string;
      message?: string;
      /** Frontend-generated message ID — reused as the persisted user message
       *  id so the WebUI can dedupe its local streaming copy against the
       *  refetched API copy (avoids double bubbles after turn completion). */
      clientMsgId?: string;
      /** Chat input's agent selector: overrides the project's default agent
       *  for this turn (and sticks for the session, like the /agents command). */
      agentId?: string;
      /** Chat input's model selector: "provider/modelId" ref. Resolved into a
       *  ModelInstance and passed as an explicit model override (wins over the
       *  agent's primary model). */
      model?: string;
      /** Chat input's per-turn reasoning level (off|minimal|low|medium|high|
       *  xhigh|max). Wins over the per-model config and the global
       *  defaultReasoningLevel. Invalid values are ignored (fall back to the
       *  configured defaults). */
      reasoningLevel?: string;
    };
    // Only accept well-formed ids — never let arbitrary user input become a DB primary key.
    const safeClientMsgId =
      typeof clientMsgId === 'string' && clientMsgId.length >= 8 && clientMsgId.length <= 64
        ? clientMsgId
        : undefined;

    if (!sessionId || !rawMessage?.trim()) {
      return reply
        .status(400)
        .send({ error: 'Bad Request', message: 'sessionId and message are required' });
    }

    let message = rawMessage.trim();

    // Verify project exists
    const project = cfg.projectStore.getById(projectId);
    if (!project) {
      return reply.status(404).send({ error: 'Not Found', message: 'Project not found' });
    }

    // ── Chat input selectors (agent / model) ──
    // Agent: only accept ids the manager actually knows — anything else falls
    // back to the project's default agent. When the user explicitly picked an
    // agent we ALSO pin it to the session map so steer/follow-up turns (which
    // read the session map, not the per-turn option) keep using it.
    let effectiveAgentId = project.agent_id;
    if (requestedAgentId && cfg.agentManager?.get(requestedAgentId)) {
      effectiveAgentId = requestedAgentId;
      // Always pin (even back to the project default) so switching back
      // clears a previous session-level override.
      cfg.agentService.setSessionAgentId(sessionId, effectiveAgentId);
    }
    // Model: resolve the "provider/modelId" ref into a ModelInstance here so
    // an unresolvable selection degrades to the agent's primary model instead
    // of failing the turn.
    const explicitModel = requestedModelRef
      ? resolveModelRef(requestedModelRef, cfg.getConfig?.())
      : undefined;
    if (requestedModelRef && !explicitModel) {
      app.log.warn(
        { model: requestedModelRef },
        '[chat] Model override could not be resolved — using agent default',
      );
    }

    // Reasoning level: only well-known values pass through — anything else
    // (undefined included) falls back to the configured defaults server-side.
    const REASONING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    const reasoningLevel = REASONING_LEVELS.includes(requestedReasoningLevel ?? '')
      ? requestedReasoningLevel
      : undefined;

    // Set SSE headers
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const sendSSE = (data: Record<string, unknown>): void => {
      // A tab closed mid-turn makes this write throw, and any uncaught
      // exception takes the whole gateway down (src/index.ts exit handlers) —
      // the same reason the keepalive below is wrapped.
      try {
        reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
      } catch {
        /* connection already closed */
      }
    };

    // SSE keepalive — write an SSE comment every 15s so the connection stays
    // active during long silent phases (tool execution, approval/user-question
    // waits) and proxies don't buffer/close idle streams. Comment lines are
    // ignored by SSE parsers; the frontend feeds them to its heartbeat so a
    // running tool no longer trips the client's 60s no-event timeout.
    const pingTimer = setInterval(() => {
      try {
        reply.raw.write(': ping\n\n');
      } catch {
        /* connection already closed */
      }
    }, 15_000);
    // 'close' fires when the response ends (including early slash-command returns).
    reply.raw.on('close', () => clearInterval(pingTimer));

    try {
      // ── Slash command routing ──
      if (message.startsWith('/')) {
        const chatId = `webui:${projectId}`;

        // 1. Try built-in commands (/stop, /clear, /skill, /cron, /team, etc.)
        if (cfg.commandDeps) {
          const result = await handleCommand(
            message,
            sessionId,
            cfg.commandDeps,
            undefined,
            chatId,
          );
          if (result) {
            // Persist messages so they survive frontend refetch.
            // Always persist the user command message, plus the assistant
            // reply when present (so all input types are visible in history).
            if (cfg.db) {
              try {
                const { v4: uuidv4 } = await import('uuid');
                const now = Date.now();
                // Always persist user command message (reuse clientMsgId when provided
                // so the frontend can dedupe its streaming copy against this row)
                cfg.db
                  .prepare(
                    "INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, 'user', ?, ?)",
                  )
                  .run(safeClientMsgId ?? uuidv4(), sessionId, rawMessage.trim(), now);
                if (result.reply) {
                  cfg.db
                    .prepare(
                      "INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, 'assistant', ?, ?)",
                    )
                    .run(uuidv4(), sessionId, result.reply, now);
                }
                cfg.db
                  .prepare('UPDATE sessions SET updated_at = ? WHERE id = ?')
                  .run(now, sessionId);
              } catch (dbErr) {
                // FK may fail if session doesn't exist — non-fatal
                app.log.warn({ err: dbErr }, '[chat] Failed to persist command message');
              }
            }
            if (result.reply) {
              sendSSE({ type: 'text_delta', data: result.reply });
            }
            if (result.forwardText) {
              message = result.forwardText;
              // Fall through to agent execution below
            } else {
              sendSSE({ type: 'done' });
              reply.raw.end();
              return;
            }
          }
        }

        // 2. Try extension-registered commands
        if (cfg.commandRegistry && cfg.commandDeps && message.startsWith('/')) {
          const extResult = await cfg.commandRegistry.handle(message, {
            sessionKey: sessionId,
            args: '',
            deps: cfg.commandDeps,
            chatId,
          });
          if (extResult) {
            if (cfg.db) {
              try {
                const { v4: uuidv4 } = await import('uuid');
                const now = Date.now();
                cfg.db
                  .prepare(
                    "INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, 'user', ?, ?)",
                  )
                  .run(safeClientMsgId ?? uuidv4(), sessionId, rawMessage.trim(), now);
                if (extResult.reply) {
                  cfg.db
                    .prepare(
                      "INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, 'assistant', ?, ?)",
                    )
                    .run(uuidv4(), sessionId, extResult.reply, now);
                }
                cfg.db
                  .prepare('UPDATE sessions SET updated_at = ? WHERE id = ?')
                  .run(now, sessionId);
              } catch (dbErr) {
                app.log.warn({ err: dbErr }, '[chat] Failed to persist ext command message');
              }
            }
            if (extResult.reply) {
              sendSSE({ type: 'text_delta', data: extResult.reply });
            }
            sendSSE({ type: 'done' });
            reply.raw.end();
            return;
          }
        }

        // Unrecognized slash command — let it flow to the agent
      }
    } catch (err) {
      sendSSE({ type: 'error', error: err instanceof Error ? err.message : String(err) });
      reply.raw.end();
      return;
    }

    // Resolve agent name upfront — the event-bridge also calls setAgentName
    // during agent_end, but doing it here ensures it's always available.
    const agentName = cfg.agentManager
      ? ((project.agent_id ? cfg.agentManager.get(project.agent_id)?.name : undefined) ??
        cfg.agentManager.getDefault()?.name)
      : undefined;
    const dispatcher = new SSEReplyDispatcher(
      sendSSE,
      cfg.getFooterConfig?.(),
      cfg.db,
      sessionId,
      cfg.getShowSkillCalls?.(),
      cfg.getShowToolCalls?.(),
      app.log,
      cfg.harnessApprovalRegistry,
    );
    if (agentName) {
      dispatcher.setAgentName(agentName);
    }

    // WebUI approval sender — sends approval requests via the SSE stream
    // so the frontend can render interactive ApprovalCards.
    const approvalSender = createWebUIApprovalSender(sendSSE, cfg.db, sessionId, app.log);

    // WebUI user question sender — sends ask_user_question prompts via SSE
    const userQuestionSender = createWebUIUserQuestionSender(sendSSE, cfg.db, sessionId, app.log);
    const questionSessionKey = `webui:${sessionId}`;
    cfg.userQuestionSenderRegistry?.set(questionSessionKey, userQuestionSender);

    let completionStatus: 'complete' | 'error' = 'complete';

    // Extract attached images from markdown in the user message and convert
    // them to multimodal ImageContent so vision-capable models can "see" them.
    let images: { type: 'image'; data: string; mimeType: string }[] | undefined;
    const imageRegex = /!\[([^\]]*)\]\((\/api\/files\/serve\?path=[^)\s]+)\)/g;
    const imageMatches = [...message.matchAll(imageRegex)];
    if (imageMatches.length > 0) {
      images = [];
      for (const match of imageMatches) {
        try {
          const serveUrl = match[2];
          const urlParams = new URLSearchParams(new URL(serveUrl, 'http://localhost').search);
          const filePath = urlParams.get('path');
          if (filePath && fs.existsSync(filePath)) {
            const ext = path.extname(filePath).toLowerCase();
            const mimeMap: Record<string, string> = {
              '.png': 'image/png',
              '.jpg': 'image/jpeg',
              '.jpeg': 'image/jpeg',
              '.gif': 'image/gif',
              '.webp': 'image/webp',
              '.bmp': 'image/bmp',
              '.svg': 'image/svg+xml',
              '.ico': 'image/x-icon',
            };
            const mimeType = mimeMap[ext] || 'image/png';
            const buf = await readFile(filePath);
            const data = buf.toString('base64');
            images.push({ type: 'image', data, mimeType });
          }
        } catch {
          // Skip unreadable images — non-fatal
        }
      }
      if (images.length === 0) images = undefined;
    }

    // WebUI screenshot delivery — computer_use send_screenshot hands the
    // image here when the model cannot carry it as a tool result (text-only
    // models drop image content). We write the PNG under
    // data/computer-use-screenshots (servable via /api/files/serve, see
    // computeServeAllowedRoots) and return a markdown image in the tool
    // output — the SAME path webui_send_media uses: the SSE frontend renders
    // it as a media segment, and on reload session-routes re-extracts it
    // from the persisted tool_call output. No separate assistant message is
    // persisted: one that also carried markdown would render twice (React-
    // Markdown + the extracted-images array in MessageBubble).
    const computerUseImageSender = async (image: {
      data: string;
      mimeType: string;
    }): Promise<string> => {
      const dir = dataPath('computer-use-screenshots');
      fs.mkdirSync(dir, { recursive: true });
      const ext =
        image.mimeType === 'image/jpeg'
          ? '.jpg'
          : image.mimeType === 'image/webp'
            ? '.webp'
            : image.mimeType === 'image/gif'
              ? '.gif'
              : '.png';
      const fileName = `screenshot-${Date.now()}${ext}`;
      const filePath = path.join(dir, fileName);
      fs.writeFileSync(filePath, Buffer.from(image.data, 'base64'));
      const serveUrl = `/api/files/serve?path=${encodeURIComponent(filePath)}`;
      return `Sent to chat as image\n\n![${fileName}](${serveUrl})`;
    };

    try {
      await cfg.agentService.execute(message, {
        sessionId: sessionId,
        chatId: `webui:${projectId}`,
        agentId: effectiveAgentId,
        model: explicitModel,
        reasoningLevel,
        replyDispatcherOverride: dispatcher,
        channel: 'webui',
        channelApprovalSender: approvalSender,
        extraTools: [createSendMediaTool()],
        eagerPersistUserMessage: true,
        clientMsgId: safeClientMsgId,
        images,
        computerUseImageSender,
      });
    } catch (err: unknown) {
      completionStatus = 'error';
      const errorMsg = err instanceof Error ? err.message : String(err);
      sendSSE({ type: 'error', error: errorMsg });
    } finally {
      // Clean up the per-session user question sender
      cfg.userQuestionSenderRegistry?.delete(questionSessionKey);

      // Notify all WebSocket clients so the frontend can refetch the
      // latest messages even if the SSE connection was lost mid-stream
      // (page refresh, browser close, navigation away).
      if (cfg.wsManager && sessionId) {
        cfg.wsManager.broadcast({
          type: 'agent_turn_complete',
          sessionId,
          status: completionStatus,
        });
      }
      reply.raw.end();
    }
  });

  // ── User Question Answer endpoint ──
  // Frontend calls this when the user selects an option or types an answer
  // in response to an ask_user_question prompt.
  app.post('/api/questions/:id/answer', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { answer } = request.body as { answer?: string };

    if (!answer) {
      return reply.status(400).send({ error: 'answer is required' });
    }

    const resolved = cfg.agentService.resolveUserQuestion(id, answer);

    if (!resolved) {
      return reply.status(404).send({
        error: 'Question not found or already answered',
      });
    }

    return reply.send({ ok: true, requestId: id, answer });
  });

  // Steer/FollowUp endpoint — injects a message into the running agent
  // without creating a new SSE connection. Uses the same shared command
  // handler as Feishu, so /steer, /btw, /queue work identically across
  // all channels. The response streams through the existing SSE connection.
  app.post('/api/projects/:projectId/chat/steer', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const { sessionId, message: rawMessage } = request.body as {
      sessionId?: string;
      message?: string;
    };

    if (!sessionId || !rawMessage?.trim()) {
      return reply
        .status(400)
        .send({ error: 'Bad Request', message: 'sessionId and message are required' });
    }

    const project = cfg.projectStore.getById(projectId);
    if (!project) {
      return reply.status(404).send({ error: 'Not Found', message: 'Project not found' });
    }

    const chatId = `webui:${projectId}`;

    // Route through the shared command handler (same as Feishu). Commands like
    // /steer, /btw, /stop call agentService.steer/followUp/abort directly.
    if (cfg.commandDeps) {
      const result = await handleCommand(
        rawMessage.trim(),
        sessionId,
        cfg.commandDeps,
        undefined,
        chatId,
      );
      if (result) {
        if (result.steered || (!result.reply && !result.forwardText)) {
          return reply.send({ ok: true });
        }
        // If the command returns forwardText (agent not running), use steer
        // so the message is queued rather than creating a new SSE.
        if (result.forwardText) {
          const ok = cfg.agentService.steer(sessionId, result.forwardText);
          return reply.send({ ok });
        }
        if (result.reply) {
          return reply.send({ ok: true, reply: result.reply });
        }
      }
    }

    // Fallback: plain text — steer the running agent. Unlike Feishu we
    // do NOT call swapCard here because it creates a dispatcher via the
    // channel-agnostic factory (intended for Feishu cards), not the SSE
    // connection. Instead we rely on the agent's natural turn lifecycle:
    // when the steer message is dequeued, agent_start fires → turn_start
    // SSE event → frontend creates a new bubble via beginTurn().
    //
    // Auto-reject pending approvals BEFORE steering so the SSE stream
    // sends approval_resolved events before the new turn starts.
    cfg.agentService.rejectPendingApprovals(sessionId, 'steered');
    debugLog('/chat/steer — steering agent', { sessionId, msg: rawMessage.trim().slice(0, 40) });
    const ok = cfg.agentService.steer(sessionId, rawMessage.trim());
    return reply.send({ ok });
  });

  // ── Harness proposal decision endpoint ──
  // Frontend calls this when the user clicks a button on a harness improvement
  // proposal card.  The resolver was registered in the shared
  // harnessApprovalRegistry by requestHarnessApproval() when the SSE event
  // was emitted; this endpoint resolves the pending promise with the user's
  // decision (and edited value for edit_submit).
  app.post('/api/harness/proposals/:id/decide', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { action, editedValue } = request.body as { action: string; editedValue?: string };

    debugLog('/api/harness/proposals/:id/decide called', { id, action, editedValue });

    // Map frontend actions onto backend decisions.
    let decision: import('../../harness/types.js').ApprovalDecision;
    if (action === 'approve') {
      decision = 'approve';
    } else if (action === 'reject') {
      decision = 'reject';
    } else if (action === 'ignore') {
      // Align with other channels (Feishu/QQ/Telegram), which resolve the
      // ignore button to 'dismiss' rather than 'reject'.
      decision = 'dismiss';
    } else if (action === 'edit_submit') {
      decision = 'edit';
    } else {
      return reply.status(400).send({ ok: false, error: `unknown action: ${action}` });
    }

    const resolver = cfg.harnessApprovalRegistry?.get(id);
    if (!resolver) {
      return reply.status(404).send({ ok: false, error: 'unknown or expired proposal' });
    }
    cfg.harnessApprovalRegistry?.delete(id);
    resolver({ decision, editedValue });
    return { ok: true };
  });
}
