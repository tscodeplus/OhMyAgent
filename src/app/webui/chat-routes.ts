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
import type { ApprovalDecisionType } from '../types.js';
import type { CommandDeps } from '../../commands/command-handler.js';
import type { CommandRegistry } from '../../commands/command-registry.js';
import type { WebSocketManager } from './websocket.js';
import { handleCommand } from '../../commands/command-handler.js';
import { computeCacheHitRate } from '../../channel/usage-summary.js';
import { createWebUIApprovalSender } from './approval-sender.js';
import { safeEqual } from '../../shared/safe-equal.js';
import { createSendMediaTool } from '../../tools/builtins/multimodal/send-media-tool.js';
import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEBUG_LOG = path.resolve('./data/webui-debug.log');
function debugLog(msg: string, data?: Record<string, unknown>): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}${data ? ' ' + JSON.stringify(data) : ''}\n`;
  try { fs.appendFileSync(DEBUG_LOG, line); } catch { /* ignore */ }
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

  constructor(
    callback: SSECallback,
    footerConfig?: FooterConfig,
    db?: Database.Database,
    sessionId?: string,
  ) {
    this.callback = callback;
    this.footerConfig = footerConfig ?? {
      showAgentName: true, showModel: true, showCompleted: false,
      showElapsed: true, showUsage: false, showCacheHitRate: false,
    };
    this.db = db;
    this.sessionId = sessionId;
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
    // Send as text_delta so it renders inline with the message stream,
    // persists to DB naturally, and survives page refresh.
    this.callback({ type: 'text_delta', data: `\n> ⚡️ 技能激活: **${skillName}**\n` });
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
        this.persistApprovalMessage(record.requestId, record.command, record.risk, 'pending', record.reason);
      } else {
        this.callback({
          type: 'approval_resolved',
          approvalId: record.requestId,
          decision: record.decision ?? (record.status === 'approved' ? 'approve_once' : 'reject_once'),
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
      this.db.prepare(
        "INSERT OR REPLACE INTO messages (id, session_id, role, content, created_at, metadata) VALUES (?, ?, 'assistant', ?, ?, ?)",
      ).run(msgId, this.sessionId, '', Date.now(), meta);
      this.approvalMsgIds.set(approvalId, msgId);
    } catch (err) {
      console.warn('[chat] Failed to persist approval message:', err);
    }
  }

  /** Update an existing approval message's status after resolution. */
  private updateApprovalMessage(
    approvalId: string,
    status: string,
    decision?: string,
  ): void {
    if (!this.db || !this.sessionId) return;
    try {
      // Message ID uses the same format as persistApprovalMessage and the
      // frontend streaming id — "approval-{approvalId}".
      const msgId = `approval-${approvalId}`;
      const row = this.db.prepare(
        'SELECT metadata FROM messages WHERE id = ?',
      ).get(msgId) as { metadata: string | null } | undefined;
      if (row) {
        let meta: Record<string, unknown> = {};
        try { meta = row.metadata ? JSON.parse(String(row.metadata)) : {}; } catch { /* ignore */ }
        const approval = (meta.approval || {}) as Record<string, unknown>;
        approval.status = status;
        if (decision) approval.decision = decision;
        meta.approval = approval;
        this.db.prepare(
          'UPDATE messages SET metadata = ? WHERE id = ?',
        ).run(JSON.stringify(meta), msgId);
        this.approvalMsgIds.set(approvalId, msgId);
      }
    } catch (err) {
      console.warn('[chat] Failed to update approval message:', err);
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
    this.callback({ type: 'tool_call_start', toolName: name, data: args, toolCallId });
  }

  onToolEnd(name: string, result: unknown, isError?: boolean, toolCallId?: string): void {
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
        usage: usage ? {
          input: usage.input,
          output: usage.output,
          cacheRead: usage.cacheRead,
          cacheWrite: usage.cacheWrite,
        } : undefined,
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
}

// ─── Chat Route Config ───

export interface ChatRouteConfig {
  agentService: AgentService;
  projectStore: ProjectStore;
  db?: Database.Database;
  getFooterConfig?: () => FooterConfig;
  agentManager?: AgentManager;
  commandDeps?: CommandDeps;
  commandRegistry?: CommandRegistry;
  wsManager?: WebSocketManager;
}

export function registerChatRoutes(app: FastifyInstance, cfg: ChatRouteConfig): void {
  // Auth endpoint — used by frontend to validate token
  app.post('/api/auth/login', async (request, reply) => {
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

  // Health check
  app.get('/api/health', async (_request, reply) => {
    let version: string | undefined;
    try {
      // Walk up from __dirname to find the project root package.json.
      // Works in both dev (tsx from src/) and production (node from dist/).
      let dir = __dirname;
      for (let i = 0; i < 10; i++) {
        const pkgPath = path.join(dir, 'package.json');
        if (fs.existsSync(pkgPath)) {
          version = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version;
          break;
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    } catch { /* best effort */ }
    return reply.send({
      ok: true,
      version,
      timestamp: new Date().toISOString(),
    });
  });

  // SSE chat endpoint
  app.post('/api/projects/:projectId/chat', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const { sessionId, message: rawMessage } = request.body as { sessionId?: string; message?: string };

    if (!sessionId || !rawMessage?.trim()) {
      return reply.status(400).send({ error: 'Bad Request', message: 'sessionId and message are required' });
    }

    let message = rawMessage.trim();

    // Verify project exists
    const project = cfg.projectStore.getById(projectId);
    if (!project) {
      return reply.status(404).send({ error: 'Not Found', message: 'Project not found' });
    }

    // Set SSE headers
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const sendSSE = (data: Record<string, unknown>): void => {
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      // ── Slash command routing ──
      if (message.startsWith('/')) {
        const chatId = `webui:${projectId}`;

        // 1. Try built-in commands (/stop, /clear, /skill, /cron, /team, etc.)
        if (cfg.commandDeps) {
          const result = await handleCommand(message, sessionId, cfg.commandDeps, undefined, chatId);
          if (result) {
            // Persist messages so they survive frontend refetch.
            // Always persist the user command message, plus the assistant
            // reply when present (so all input types are visible in history).
            if (cfg.db) {
              try {
                const { v4: uuidv4 } = await import('uuid');
                const now = Date.now();
                // Always persist user command message
                cfg.db.prepare(
                  "INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, 'user', ?, ?)",
                ).run(uuidv4(), sessionId, rawMessage.trim(), now);
                if (result.reply) {
                  cfg.db.prepare(
                    "INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, 'assistant', ?, ?)",
                  ).run(uuidv4(), sessionId, result.reply, now);
                }
                cfg.db.prepare(
                  "UPDATE sessions SET updated_at = ? WHERE id = ?",
                ).run(now, sessionId);
              } catch (dbErr) {
                // FK may fail if session doesn't exist — non-fatal
                console.warn('[chat] Failed to persist command message:', dbErr);
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
                cfg.db.prepare(
                  "INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, 'user', ?, ?)",
                ).run(uuidv4(), sessionId, rawMessage.trim(), now);
                if (extResult.reply) {
                  cfg.db.prepare(
                    "INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, 'assistant', ?, ?)",
                  ).run(uuidv4(), sessionId, extResult.reply, now);
                }
                cfg.db.prepare(
                  "UPDATE sessions SET updated_at = ? WHERE id = ?",
                ).run(now, sessionId);
              } catch (dbErr) {
                console.warn('[chat] Failed to persist ext command message:', dbErr);
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
      ? ((project.agent_id
          ? cfg.agentManager.get(project.agent_id)?.name
          : undefined) ?? cfg.agentManager.getDefault()?.name)
      : undefined;
    const dispatcher = new SSEReplyDispatcher(sendSSE, cfg.getFooterConfig?.(), cfg.db, sessionId);
    if (agentName) {
      dispatcher.setAgentName(agentName);
    }

    // WebUI approval sender — sends approval requests via the SSE stream
    // so the frontend can render interactive ApprovalCards.
    const approvalSender = createWebUIApprovalSender(sendSSE, cfg.db, sessionId);

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
              '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
              '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
              '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
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

    try {
      await cfg.agentService.execute(message, {
        sessionId: sessionId,
        chatId: `webui:${projectId}`,
        agentId: project.agent_id,
        replyDispatcherOverride: dispatcher,
        channel: 'webui',
        channelApprovalSender: approvalSender,
        extraTools: [createSendMediaTool()],
        eagerPersistUserMessage: true,
        images,
      });
    } catch (err: unknown) {
      completionStatus = 'error';
      const errorMsg = err instanceof Error ? err.message : String(err);
      sendSSE({ type: 'error', error: errorMsg });
    } finally {
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

  // Steer/FollowUp endpoint — injects a message into the running agent
  // without creating a new SSE connection. Uses the same shared command
  // handler as Feishu, so /steer, /btw, /queue work identically across
  // all channels. The response streams through the existing SSE connection.
  app.post('/api/projects/:projectId/chat/steer', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const { sessionId, message: rawMessage } = request.body as { sessionId?: string; message?: string };

    if (!sessionId || !rawMessage?.trim()) {
      return reply.status(400).send({ error: 'Bad Request', message: 'sessionId and message are required' });
    }

    const project = cfg.projectStore.getById(projectId);
    if (!project) {
      return reply.status(404).send({ error: 'Not Found', message: 'Project not found' });
    }

    const chatId = `webui:${projectId}`;

    // Route through the shared command handler (same as Feishu). Commands like
    // /steer, /btw, /stop call agentService.steer/followUp/abort directly.
    if (cfg.commandDeps) {
      const result = await handleCommand(rawMessage.trim(), sessionId, cfg.commandDeps, undefined, chatId);
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
}
