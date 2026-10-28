/**
 * IM Inbox API Routes (read-only)
 *
 * The WebUI lists project sessions through `/api/projects/:projectId/sessions`.
 * IM sessions (Feishu/Telegram/WeChat/QQ) are created by the channel extensions
 * with `project_id IS NULL`, so they belong to no project and were invisible in
 * the WebUI. These routes expose those transcripts as an inbox.
 *
 * READ-ONLY BY DESIGN: there is no POST/PUT/DELETE here. Replying into an IM
 * chat from the WebUI would race the channel's own dispatcher (duplicate
 * delivery, card/thread state it does not own) and is out of scope.
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

export function registerInboxRoutes(
  app: FastifyInstance,
  db: Database.Database,
  getFooterConfig?: () => FooterConfig,
  /**
   * Bot display name for a channel ("小书" for Feishu). Lets a sidebar group read
   * "小书 · 飞书" instead of a bare channel name, which matters as soon as more
   * than one bot posts into the same inbox. Optional: unconfigured channels and
   * every non-bot channel degrade to the plain label.
   */
  getBotName?: (channel: string) => string | undefined,
): void {
  const sessionRepository = new SessionRepository(db);

  // Inbox list: IM sessions only (project_id IS NULL), newest activity first.
  app.get('/api/inbox', async (request, reply) => {
    const {
      channel: channelParam,
      limit: limitParam,
      before: beforeParam,
    } = request.query as { channel?: string; limit?: string; before?: string };

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
    });
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;

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
      channels: sessionRepository.countByChannel().map((entry) => {
        const botName = getBotName?.(entry.channel);
        return botName ? { ...entry, bot_name: botName } : entry;
      }),
    });
  });

  // One inbox transcript. 404 for project sessions: those are served by
  // /api/projects/:projectId/sessions/:sid and must not be readable here.
  app.get('/api/inbox/:sid/messages', async (request, reply) => {
    const { sid } = request.params as { sid: string };
    const { limit: limitParam, before: beforeParam } = request.query as {
      limit?: string;
      before?: string;
    };

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
      getFooterConfig,
    });

    const channel = session.channel ?? inferChannel(session.id, session.chat_id);
    return reply.send({
      id: session.id,
      channel,
      ...(getBotName?.(channel) ? { bot_name: getBotName?.(channel) } : {}),
      external_chat_id: session.external_chat_id,
      title: session.title ?? titleFromMetadata(session.metadata),
      created_at: parseInt(String(session.created_at), 10),
      updated_at: parseInt(String(session.updated_at), 10),
      messages,
      hasMore,
    });
  });
}
