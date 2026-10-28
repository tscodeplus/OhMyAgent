/**
 * Session CRUD API Routes for WebUI
 *
 * Operates on the existing sessions table. WebUI sessions have project_id set,
 * IM sessions have project_id IS NULL.
 */

import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { FooterConfig } from '../types.js';
import { loadSessionMessages, refreshPersistedDownloadUrls } from './session-message-view.js';
import { deleteSessionCascade } from '../../memory/session-delete.js';
import { SessionRepository } from '../../memory/repositories/session-repository.js';

/** Sessions per list page (the endpoint accepts 1..200). */
const LIST_DEFAULT_LIMIT = 50;
const LIST_MAX_LIMIT = 200;

/** Clamp `limit` to 1..LIST_MAX_LIMIT, falling back to the default when unparsable. */
function parseLimit(raw: string | undefined): number {
  const parsed = parseInt(raw ?? String(LIST_DEFAULT_LIMIT), 10);
  if (!Number.isFinite(parsed)) return LIST_DEFAULT_LIMIT;
  return Math.min(Math.max(1, parsed), LIST_MAX_LIMIT);
}

/** Exclusive epoch-ms cursor; anything unparsable means "no cursor". */
function parseBefore(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Completes the cursor into `(updated_at, id)`; empty means "absent". */
function parseBeforeId(raw: string | undefined): string | undefined {
  return raw === undefined || raw === '' ? undefined : raw;
}

// Re-exported after the implementation moved into session-message-view.ts so
// the two entry points share one projection; kept here for existing importers.
export { refreshPersistedDownloadUrls };

export function registerSessionRoutes(
  app: FastifyInstance,
  db: Database.Database,
  getFooterConfig?: () => FooterConfig,
): void {
  const sessionRepository = new SessionRepository(db);

  // Create session
  app.post('/api/projects/:projectId/sessions', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const body = request.body as { baseTitle?: string } | undefined;
    const { v4: uuidv4 } = await import('uuid');

    const id = uuidv4();
    const chatId = `webui:${projectId}`;
    const baseTitle = body?.baseTitle || 'New Chat';

    // Generate unique title by appending incrementing number if needed
    const existing = db
      .prepare('SELECT metadata FROM sessions WHERE project_id = ?')
      .all(projectId) as Array<{ metadata: string | null }>;

    const titles = new Set<string>();
    for (const row of existing) {
      if (!row.metadata) continue;
      try {
        const meta = JSON.parse(String(row.metadata));
        if (meta.title) titles.add(String(meta.title));
      } catch {
        /* ignore malformed metadata */
      }
    }

    let title = baseTitle;
    if (titles.has(baseTitle)) {
      let n = 1;
      while (titles.has(`${baseTitle}${n}`)) n++;
      title = `${baseTitle}${n}`;
    }

    const now = Date.now();
    const metadata = JSON.stringify({ title });
    db.prepare(
      `
      INSERT INTO sessions (id, chat_id, user_id, project_id, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(id, chatId, 'webui-user', projectId, metadata, now, now);

    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as any;

    return reply.status(201).send({
      id: session.id,
      project_id: session.project_id,
      chat_id: session.chat_id,
      title: session.metadata ? JSON.parse(String(session.metadata)).title : undefined,
      created_at: parseInt(String(session.created_at), 10),
      updated_at: parseInt(String(session.updated_at), 10),
      metadata: session.metadata ? JSON.parse(String(session.metadata)) : {},
    });
  });

  // List sessions for a project, newest activity first, paged by the same
  // `(updated_at, id)` cursor the inbox and archive use.
  //
  // Archived conversations are excluded by default: they live under
  // /api/archive until they are restored (or receive a new turn, which clears
  // the flag — see AgentService). One consequence is deliberate: the WebUI's
  // "open the most recent session" bootstrap cannot land on an archived
  // conversation.
  //
  // `?includeArchived=1` widens the filter; `?id=<sid>` narrows the list to the
  // one session a caller already knows by id (the desktop caption's title
  // lookup), because a page of 50 cannot be counted on to contain it.
  app.get('/api/projects/:projectId/sessions', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const {
      includeArchived: includeArchivedParam,
      id: idParam,
      limit: limitParam,
      before: beforeParam,
      beforeId: beforeIdParam,
    } = request.query as {
      includeArchived?: string;
      id?: string;
      limit?: string;
      before?: string;
      beforeId?: string;
    };

    const limit = parseLimit(limitParam);
    // One extra row decides `hasMore` without a second COUNT query.
    const rows = sessionRepository.listByProject({
      projectId,
      limit: limit + 1,
      before: parseBefore(beforeParam),
      beforeId: parseBeforeId(beforeIdParam),
      includeArchived: includeArchivedParam === '1' || includeArchivedParam === 'true',
      id: idParam === undefined || idParam === '' ? undefined : idParam,
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    return reply.send({
      items: page.map((s) => {
        const row = s as unknown as Record<string, unknown>;
        return {
          id: row.id,
          project_id: row.project_id,
          chat_id: row.chat_id,
          title: row.metadata ? JSON.parse(String(row.metadata)).title : undefined,
          created_at: parseInt(String(row.created_at), 10),
          updated_at: parseInt(String(row.updated_at), 10),
          metadata: row.metadata ? JSON.parse(String(row.metadata)) : {},
        };
      }),
      hasMore,
    });
  });

  // Get single session with messages
  app.get('/api/projects/:projectId/sessions/:sid', async (request, reply) => {
    const { projectId, sid } = request.params as { projectId: string; sid: string };

    const session = db
      .prepare('SELECT * FROM sessions WHERE id = ? AND project_id = ?')
      .get(sid, projectId) as any;

    if (!session) {
      return reply.status(404).send({ error: 'Not Found', message: 'Session not found' });
    }

    // Read limit/before from query params for pagination.
    // `before` is a millisecond UTC timestamp (INTEGER) cursor; `beforeId`
    // completes it into `(created_at, id)` so same-millisecond siblings are not
    // lost at a page boundary.
    const {
      limit: limitParam,
      before: beforeParam,
      beforeId: beforeIdParam,
    } = request.query as { limit?: string; before?: string; beforeId?: string };
    const limit = Math.min(Math.max(1, parseInt(limitParam ?? '50', 10) || 50), 100);
    const before = beforeParam ? parseInt(beforeParam, 10) : undefined;

    const { messages: formattedMessages, hasMore } = loadSessionMessages(db, sid, {
      limit,
      before,
      beforeId: parseBeforeId(beforeIdParam),
      getFooterConfig,
    });

    return reply.send({
      id: session.id,
      project_id: session.project_id,
      title: session.metadata ? JSON.parse(String(session.metadata)).title : undefined,
      created_at: parseInt(String(session.created_at), 10),
      updated_at: parseInt(String(session.updated_at), 10),
      messages: formattedMessages,
      hasMore,
    });
  });

  // Update session title
  app.put('/api/projects/:projectId/sessions/:sid/title', async (request, reply) => {
    const { projectId, sid } = request.params as { projectId: string; sid: string };
    const { title } = request.body as { title?: string };

    const session = db
      .prepare('SELECT * FROM sessions WHERE id = ? AND project_id = ?')
      .get(sid, projectId) as any;

    if (!session) {
      return reply.status(404).send({ error: 'Not Found', message: 'Session not found' });
    }

    const metadata = session.metadata ? JSON.parse(String(session.metadata)) : {};
    if (title !== undefined) metadata.title = title;
    const newMeta = JSON.stringify(metadata);

    db.prepare('UPDATE sessions SET metadata = ?, updated_at = ? WHERE id = ?').run(
      newMeta,
      Date.now(),
      sid,
    );

    return reply.send({ ok: true, title });
  });

  // Delete session
  app.delete('/api/projects/:projectId/sessions/:sid', async (request, reply) => {
    try {
      const { projectId, sid } = request.params as { projectId: string; sid: string };

      const session = db
        .prepare('SELECT * FROM sessions WHERE id = ? AND project_id = ?')
        .get(sid, projectId) as any;

      if (!session) {
        return reply.status(404).send({ error: 'Not Found', message: 'Session not found' });
      }

      // Shared with the IM inbox delete so both entry points cascade identically.
      deleteSessionCascade(db, sid);

      return reply.send({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: 'Delete failed', message });
    }
  });
}
