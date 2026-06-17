/**
 * Session CRUD API Routes for WebUI
 *
 * Operates on the existing sessions table. WebUI sessions have project_id set,
 * IM sessions have project_id IS NULL.
 */

import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { FooterConfig } from '../types.js';
import { stripXmlTag } from '../../shared/text-extract.js';

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
    const existing = db.prepare(
      'SELECT metadata FROM sessions WHERE project_id = ?'
    ).all(projectId) as Array<{ metadata: string | null }>;

    const titles = new Set<string>();
    for (const row of existing) {
      if (!row.metadata) continue;
      try {
        const meta = JSON.parse(String(row.metadata));
        if (meta.title) titles.add(String(meta.title));
      } catch { /* ignore malformed metadata */ }
    }

    let title = baseTitle;
    if (titles.has(baseTitle)) {
      let n = 1;
      while (titles.has(`${baseTitle}${n}`)) n++;
      title = `${baseTitle}${n}`;
    }

    const now = Date.now();
    const metadata = JSON.stringify({ title });
    db.prepare(`
      INSERT INTO sessions (id, chat_id, user_id, project_id, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, chatId, 'webui-user', projectId, metadata, now, now);

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

    const rows = db.prepare(
      'SELECT * FROM sessions WHERE project_id = ? ORDER BY updated_at DESC'
    ).all(projectId) as any[];

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

    const session = db.prepare(
      'SELECT * FROM sessions WHERE id = ? AND project_id = ?'
    ).get(sid, projectId) as any;

    if (!session) {
      return reply.status(404).send({ error: 'Not Found', message: 'Session not found' });
    }

    // Read limit/before from query params for pagination.
    // `before` is a millisecond UTC timestamp (INTEGER) cursor.
    const { limit: limitParam, before: beforeParam } = request.query as { limit?: string; before?: string };
    const limit = Math.min(Math.max(1, parseInt(limitParam ?? '50', 10) || 50), 100);
    const before = beforeParam ? parseInt(beforeParam, 10) : undefined;

    // Fetch the latest (or cursor-bounded) N messages, returned in ASC order
    // (oldest first) so the frontend renders oldest at top, newest at bottom.
    // created_at is INTEGER ms — deterministic ordering, no rowid tiebreaker needed.
    let messages: any[];
    if (before !== undefined && !isNaN(before)) {
      messages = db.prepare(`
        SELECT * FROM (
          SELECT * FROM messages WHERE session_id = ? AND created_at < ?
          ORDER BY created_at DESC LIMIT ?
        ) ORDER BY created_at ASC
      `).all(sid, before, limit) as any[];
    } else {
      messages = db.prepare(`
        SELECT * FROM (
          SELECT * FROM messages WHERE session_id = ?
          ORDER BY created_at DESC LIMIT ?
        ) ORDER BY created_at ASC
      `).all(sid, limit) as any[];
    }

    // Determine if there are more messages beyond the oldest one we returned.
    // created_at is INTEGER ms — simple comparison works for hasMore check.
    let hasMore = false;
    if (messages.length === limit && messages.length > 0) {
      const oldest = messages[0];
      const countRow = db.prepare(
        'SELECT COUNT(*) as cnt FROM messages WHERE session_id = ? AND created_at < ?'
      ).get(sid, oldest.created_at) as { cnt: number };
      hasMore = countRow.cnt > 0;
    }

    const formattedMessages = messages.map((m) => {
      let meta: Record<string, unknown> | null = null;
      try { meta = m.metadata ? JSON.parse(String(m.metadata)) : null; } catch { /* ignore */ }

      // Strip injected date/time prefix from user messages.
      // The prefix is prepended with \n\n by context-transform, so ^ alone
      // won't match — use ^[\s\n]* to skip leading whitespace.
      let content = m.content;
      if (m.role === 'user') {
        content = stripXmlTag(content, 'system-reminder').trimStart();
        content = content.replace(/^[\s\n]*\[当前(时间|日期):[^\]]+\][\s\n]*/g, '')
          .replace(/^[\s\n]*\[Current (time|date):[^\]]+\][\s\n]*/gi, '');
      }

      // Collect images/files from 3 sources:
      // 1. Persisted metadata (compact, written by persistMessages)
      // 2. Content markdown ![alt](url) patterns
      // 3. Tool call outputs (webui_send_media embeds ![img](url) in results)
      const images: { url: string; alt?: string }[] = [];
      const files: { name: string; path: string }[] = [];
      const seenUrls = new Set<string>();

      // Source 1: persisted metadata images/files
      const metaImages = meta?.images as Array<{ url: string; alt?: string }> | undefined;
      if (metaImages) {
        for (const img of metaImages) {
          if (!seenUrls.has(img.url)) {
            seenUrls.add(img.url);
            images.push(img);
          }
        }
      }
      const metaFiles = meta?.files as Array<{ name: string; path: string }> | undefined;
      if (metaFiles) {
        for (const f of metaFiles) {
          if (!seenUrls.has(f.path)) {
            seenUrls.add(f.path);
            files.push(f);
          }
        }
      }

      const extractImagesFrom = (text: string) => {
        const imgRegex = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
        let m: RegExpExecArray | null;
        while ((m = imgRegex.exec(text)) !== null) {
          const url = m[2];
          if (!seenUrls.has(url)) {
            seenUrls.add(url);
            images.push({ alt: m[1] || undefined, url });
          }
        }
      };

      // Source 2+3: content + tool call outputs
      if (m.role === 'assistant') {
        extractImagesFrom(content);
        const toolCalls = meta?.tool_calls as Array<{ output?: string }> | undefined;
        if (toolCalls) {
          for (const tc of toolCalls) {
            if (tc.output) extractImagesFrom(tc.output);
          }
        }
      }

      const result: any = {
        id: m.id,
        session_id: m.session_id,
        role: m.role,
        content,
        tool_calls: meta?.tool_calls,
        created_at: m.created_at,
        ...(meta?.approval ? { approval: meta.approval } : {}),
        ...(meta?.skill_activated ? { skill_activated: meta?.skill_activated } : {}),
        ...(images.length > 0 ? { images } : {}),
        ...(files.length > 0 ? { files } : {}),
      };

      // Reconstruct segments from persisted block-order metadata so the
      // frontend can render text and tool calls interleaved (same as during
      // streaming). Segments store {type: 'text', content} and
      // {type: 'tool_call', id} entries; tool_call entries are resolved
      // against meta.tool_calls to build full ToolCall objects.
      if (meta?.segments && Array.isArray(meta.segments) && meta.segments.length > 0) {
        const toolCallsById = new Map<string, Record<string, unknown>>();
        const toolCalls = meta?.tool_calls as Array<{ id: string; name: string; arguments: Record<string, unknown> }> | undefined;
        if (toolCalls) {
          for (const tc of toolCalls) {
            if (tc.id) toolCallsById.set(tc.id, tc as unknown as Record<string, unknown>);
          }
        }

        const segments: Array<{ type: 'text' | 'tool_call'; content?: string; toolCall?: Record<string, unknown> }> = [];
        for (const seg of meta.segments as Array<{ type: string; content?: string; id?: string }>) {
          if (seg.type === 'text') {
            segments.push({ type: 'text', content: seg.content || '' });
          } else if (seg.type === 'tool_call' && seg.id) {
            const tc = toolCallsById.get(seg.id);
            if (tc) {
              segments.push({
                type: 'tool_call',
                toolCall: {
                  id: tc.id,
                  name: tc.name,
                  arguments: tc.arguments,
                  // Historical tool calls completed for this response to exist
                  status: 'success',
                },
              });
            }
          }
        }

        if (segments.length > 0) {
          result.segments = segments;
        }
      }

      // Reconstruct footer from persisted metadata.
      // Use the footer config SNAPSHOT stored at message-save time so that
      // each message retains its original footer display regardless of
      // subsequent global config changes. Falls back to the current config
      // for messages saved before footer config was persisted.
      if (meta && (meta.usage || meta.model || meta.elapsed)) {
        const fc = (meta.footerConfig as FooterConfig | undefined) ?? getFooterConfig?.() ?? {
          showAgentName: true,
          showModel: true,
          showCompleted: false,
          showElapsed: true,
          showUsage: false,
          showCacheHitRate: false,
        };
        result.footer = {
          agentName: fc.showAgentName ? meta.agentName as string | undefined : undefined,
          model: fc.showModel ? meta.model as string | undefined : undefined,
          elapsed: fc.showElapsed ? meta.elapsed as number | undefined : undefined,
          usage: meta.usage as { input?: number; output?: number; cacheRead?: number; cacheWrite?: number },
          showUsage: fc.showUsage ?? false,
          showCacheHitRate: fc.showCacheHitRate ?? false,
        };
      }

      return result;
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

    const session = db.prepare(
      'SELECT * FROM sessions WHERE id = ? AND project_id = ?'
    ).get(sid, projectId) as any;

    if (!session) {
      return reply.status(404).send({ error: 'Not Found', message: 'Session not found' });
    }

    const metadata = session.metadata ? JSON.parse(String(session.metadata)) : {};
    if (title !== undefined) metadata.title = title;
    const newMeta = JSON.stringify(metadata);

    db.prepare(
      'UPDATE sessions SET metadata = ?, updated_at = ? WHERE id = ?'
    ).run(newMeta, Date.now(), sid);

    return reply.send({ ok: true, title });
  });

  // Delete session
  app.delete('/api/projects/:projectId/sessions/:sid', async (request, reply) => {
    try {
      const { projectId, sid } = request.params as { projectId: string; sid: string };

      const session = db.prepare(
        'SELECT * FROM sessions WHERE id = ? AND project_id = ?'
      ).get(sid, projectId) as any;

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
          'DELETE FROM approval_decisions WHERE request_id IN (SELECT id FROM approval_requests WHERE session_key = ?)'
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
      try { db.exec('PRAGMA foreign_keys = ON'); } catch { /* ignore */ }
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: 'Delete failed', message });
    }
  });
}
