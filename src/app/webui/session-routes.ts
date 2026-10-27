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

// Re-exported after the implementation moved into session-message-view.ts so
// the two entry points share one projection; kept here for existing importers.
export { refreshPersistedDownloadUrls };

export function registerSessionRoutes(
  app: FastifyInstance,
  db: Database.Database,
  getFooterConfig?: () => FooterConfig,
): void {
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

  // List sessions for a project
  app.get('/api/projects/:projectId/sessions', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };

    const rows = db
      .prepare('SELECT * FROM sessions WHERE project_id = ? ORDER BY updated_at DESC')
      .all(projectId) as any[];

    const sessions = rows.map((s) => ({
      id: s.id,
      project_id: s.project_id,
      chat_id: s.chat_id,
      title: s.metadata ? JSON.parse(String(s.metadata)).title : undefined,
      created_at: parseInt(String(s.created_at), 10),
      updated_at: parseInt(String(s.updated_at), 10),
      metadata: s.metadata ? JSON.parse(String(s.metadata)) : {},
    }));

    return reply.send(sessions);
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
    // `before` is a millisecond UTC timestamp (INTEGER) cursor.
    const { limit: limitParam, before: beforeParam } = request.query as {
      limit?: string;
      before?: string;
    };
    const limit = Math.min(Math.max(1, parseInt(limitParam ?? '50', 10) || 50), 100);
    const before = beforeParam ? parseInt(beforeParam, 10) : undefined;

    const { messages: formattedMessages, hasMore } = loadSessionMessages(db, sid, {
      limit,
      before,
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

      // FK chain: approval_decisions → approval_requests → (session_key)
      //           messages / episodes / tool_runs → sessions(id)
      // Delete leaf tables first, then parents, so the cascade works even
      // with FK checks enabled.
      db.exec('PRAGMA foreign_keys = OFF');
      const cascadeDelete = db.transaction(() => {
        // 1. approval_decisions depends on approval_requests — delete first
        db.prepare(
          'DELETE FROM approval_decisions WHERE request_id IN (SELECT id FROM approval_requests WHERE session_key = ?)',
        ).run(sid);
        // 2. approval_requests — now safe (children removed)
        db.prepare('DELETE FROM approval_requests WHERE session_key = ?').run(sid);
        // 3. Leaf tables referencing sessions(id) directly
        db.prepare('DELETE FROM messages WHERE session_id = ?').run(sid);
        db.prepare('DELETE FROM episodes WHERE session_id = ?').run(sid);
        db.prepare('DELETE FROM tool_runs WHERE session_id = ?').run(sid);
        db.prepare("DELETE FROM memories WHERE scope = 'session' AND scope_key = ?").run(sid);
        // 4. Finally delete the session itself
        db.prepare('DELETE FROM sessions WHERE id = ?').run(sid);
      });
      cascadeDelete();
      db.exec('PRAGMA foreign_keys = ON');

      return reply.send({ ok: true });
    } catch (err) {
      // Ensure FK checks are re-enabled even on error
      try {
        db.exec('PRAGMA foreign_keys = ON');
      } catch {
        /* ignore */
      }
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: 'Delete failed', message });
    }
  });
}
