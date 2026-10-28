/**
 * IM Inbox API Routes (read-only)
 *
 * The WebUI lists project sessions through `/api/projects/:projectId/sessions`.
 * IM sessions (Feishu/Telegram/WeChat/QQ) are created by the channel extensions
 * with `project_id IS NULL`, so they belong to no project and were invisible in
 * the WebUI. These routes expose those transcripts as an inbox.
 *
 * There is no endpoint that injects messages: replying into an IM chat from the
 * WebUI would race the channel's own dispatcher (duplicate delivery, card/thread
 * state it does not own) and is out of scope. Housekeeping on the transcript is
 * supported — retitling and deleting a conversation — because those are database
 * facts the dispatcher does not own.
 *
 * Message formatting is NOT reimplemented: `loadSessionMessages` from
 * session-message-view.ts is the same projection the project-scoped route
 * uses, so both entry points return the identical message shape.
 */

import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { FooterConfig } from '../types.js';
import { loadSessionMessages, titleFromMetadata } from './session-message-view.js';
import { inferChannel, isInboxChannel } from '../../memory/session-channel.js';
import { SessionRepository } from '../../memory/repositories/session-repository.js';
import {
  ConversationSessions,
  normalizeConversationTitle,
} from '../../memory/conversation-sessions.js';
import { resolveBotNames, type BotNameResolver } from './bot-names.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Clamp `limit` to 1..MAX_LIMIT, falling back to the default when unparsable. */
function parseLimit(raw: string | undefined): number {
  const parsed = parseInt(raw ?? String(DEFAULT_LIMIT), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.min(Math.max(1, parsed), MAX_LIMIT);
}

/** `before` is an exclusive epoch-ms cursor; anything unparsable means "no cursor". */
function parseBefore(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * `beforeId` completes the cursor into `(updated_at, id)`; see
 * `sessionCursorWhere` for why a timestamp alone loses rows. Empty means
 * "absent", so `?before=1&beforeId=` degrades to the single-field cursor.
 */
function parseBeforeId(raw: string | undefined): string | undefined {
  return raw === undefined || raw === '' ? undefined : raw;
}

/**
 * Live-state hooks for transcript housekeeping. Both are optional so the route
 * module stays usable without an agent service (tests, tooling).
 */
export interface InboxWriteHooks {
  /** True while this conversation has a turn in flight. */
  isRunning?: (sessionId: string) => boolean;
  /**
   * Drop the in-memory conversation. Without it, deleting the current transcript
   * would leave an agent that still holds the deleted history in its context and
   * keeps answering from it.
   */
  destroyRuntime?: (sessionId: string) => void;
}

export function registerInboxRoutes(
  app: FastifyInstance,
  db: Database.Database,
  getFooterConfig?: () => FooterConfig,
  /**
   * Bot display name for a channel ("小书" for Feishu). Lets a sidebar group read
   * "小书 · 飞书" instead of a bare channel name, which matters as soon as more
   * than one bot posts into the same inbox. May be async — the name is normally
   * asked of the platform itself. Optional: unconfigured channels and
   * every non-bot channel degrade to the plain label.
   */
  getBotName?: BotNameResolver,
  hooks?: InboxWriteHooks,
): void {
  const sessionRepository = new SessionRepository(db);
  const conversations = new ConversationSessions(db);

  // Inbox list: IM sessions only (project_id IS NULL), newest activity first.
  app.get('/api/inbox', async (request, reply) => {
    const {
      channel: channelParam,
      limit: limitParam,
      before: beforeParam,
      beforeId: beforeIdParam,
    } = request.query as {
      channel?: string;
      limit?: string;
      before?: string;
      beforeId?: string;
    };

    const channel = channelParam === undefined || channelParam === '' ? undefined : channelParam;
    if (channel !== undefined && !isInboxChannel(channel)) {
      return reply
        .status(400)
        .send({ error: 'Bad Request', message: `Unknown channel: ${channel}` });
    }

    const limit = parseLimit(limitParam);
    const before = parseBefore(beforeParam);

    // One extra row decides `hasMore` without a second COUNT query; the page
    // itself is cut back to `limit` below.
    const rows = sessionRepository.listInbox({
      channel,
      limit: limit + 1,
      before,
      beforeId: parseBeforeId(beforeIdParam),
    });
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;

    const channelCounts = sessionRepository.countByChannel();
    // Resolve per distinct channel, not per row: name lookups can hit the
    // platform, and every group normally holds several sessions.
    const botNames = await resolveBotNames(
      getBotName,
      channelCounts.map((entry) => entry.channel),
    );

    return reply.send({
      items: items.map((row) => ({
        id: row.id,
        channel: row.channel,
        external_chat_id: row.external_chat_id,
        title: row.title,
        updated_at: row.updated_at,
        message_count: row.message_count,
        preview: row.preview,
      })),
      hasMore,
      // Each channel count carries the bot that owns it, so the UI can label the
      // group without asking for config separately.
      channels: channelCounts.map((entry) => {
        const botName = botNames.get(entry.channel);
        return botName ? { ...entry, bot_name: botName } : entry;
      }),
    });
  });

  // One inbox transcript. 404 for project sessions: those are served by
  // /api/projects/:projectId/sessions/:sid and must not be readable here.
  app.get('/api/inbox/:sid/messages', async (request, reply) => {
    const { sid } = request.params as { sid: string };
    const {
      limit: limitParam,
      before: beforeParam,
      beforeId: beforeIdParam,
    } = request.query as { limit?: string; before?: string; beforeId?: string };

    const session = db
      .prepare(
        'SELECT id, chat_id, project_id, channel, external_chat_id, title, metadata, created_at, updated_at FROM sessions WHERE id = ?',
      )
      .get(sid) as
      | {
          id: string;
          chat_id: string;
          project_id: string | null;
          channel: string | null;
          external_chat_id: string | null;
          title: string | null;
          metadata: string | null;
          created_at: string;
          updated_at: string;
        }
      | undefined;

    if (!session || session.project_id !== null) {
      return reply.status(404).send({ error: 'Not Found', message: 'Session not found' });
    }

    const limit = parseLimit(limitParam);
    const before = parseBefore(beforeParam);

    const { messages, hasMore } = loadSessionMessages(db, sid, {
      limit,
      before,
      beforeId: parseBeforeId(beforeIdParam),
      getFooterConfig,
    });

    const channel = session.channel ?? inferChannel(session.id, session.chat_id);
    const botName = await getBotName?.(channel);
    return reply.send({
      id: session.id,
      channel,
      ...(botName ? { bot_name: botName } : {}),
      external_chat_id: session.external_chat_id,
      title: session.title ?? titleFromMetadata(session.metadata),
      created_at: parseInt(String(session.created_at), 10),
      updated_at: parseInt(String(session.updated_at), 10),
      messages,
      hasMore,
    });
  });

  // Retitle a conversation. The same title the /rename command writes, so an IM
  // chat and the inbox cannot end up disagreeing about what a conversation is
  // called.
  app.put('/api/inbox/:sid/title', async (request, reply) => {
    const { sid } = request.params as { sid: string };
    const { title } = (request.body ?? {}) as { title?: string };

    const session = await findInboxSession(sid);
    if (!session) {
      return reply.status(404).send({ error: 'Not Found', message: 'Session not found' });
    }

    const normalized = normalizeConversationTitle(title);
    if (!normalized) {
      return reply.status(400).send({ error: 'Bad Request', message: 'title is required' });
    }

    sessionRepository.setTitle(sid, normalized);
    return reply.send({ ok: true, title: normalized });
  });

  // Delete a conversation: its messages, tool runs, episodes, approvals and
  // session-scoped memories go with it (see deleteSessionCascade). Refused while
  // a turn is running, because the persister would write into a row that no
  // longer exists.
  app.delete('/api/inbox/:sid', async (request, reply) => {
    const { sid } = request.params as { sid: string };

    const session = await findInboxSession(sid);
    if (!session) {
      return reply.status(404).send({ error: 'Not Found', message: 'Session not found' });
    }
    if (hooks?.isRunning?.(sid)) {
      return reply.status(409).send({
        error: 'Conflict',
        message: '这个会话正在回复中，请等它结束后再删除',
      });
    }

    const result = conversations.forget(sid);
    // Even when a replacement transcript was opened, the *old* id must lose its
    // in-memory history, otherwise the next reply would remember what was deleted.
    hooks?.destroyRuntime?.(sid);
    return reply.send({
      ok: true,
      messages: result.messages,
      replacement_id: result.replacementId,
    });
  });

  /**
   * The session row, if it is an inbox conversation (no project). Shared so the
   * write endpoints cannot drift from the read endpoint's 404 rules, which keep
   * project sessions unreachable here.
   */
  async function findInboxSession(sid: string): Promise<{ id: string } | undefined> {
    const row = db.prepare('SELECT id, project_id FROM sessions WHERE id = ?').get(sid) as
      { id: string; project_id: string | null } | undefined;
    if (!row || row.project_id !== null) return undefined;
    return row;
  }
}
