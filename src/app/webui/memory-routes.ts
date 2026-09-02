/**
 * Memory & Persona API Routes
 *
 * Provides CRUD for memories and persona management.
 */

import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { AppServices } from '../types.js';
import { MemoryRepository } from '../../memory/repositories/memory-repository.js';
import { EmbeddingRepository } from '../../memory/repositories/embedding-repository.js';
import {
  MemoryTermRepository,
  extractMemoryTerms,
} from '../../memory/repositories/memory-term-repository.js';

interface MemoryRouteConfig {
  db: Database.Database;
  services: AppServices;
}

/**
 * `memories` is the write target, but three derived stores read it back: the
 * jieba FTS index (synced inside MemoryRepository), `memory_terms` and
 * `vec_memory_embeddings` — the latter two have no FK cascade, so a raw
 * UPDATE/DELETE here would leave the edited memory matching its OLD text and a
 * deleted memory matchable at all.
 */
function reindexLexicalTerms(db: Database.Database, id: string, content: string): void {
  try {
    new MemoryTermRepository(db).replaceForMemory(id, extractMemoryTerms(content));
  } catch {
    // Term reindex is an optimization; the row itself is already persisted.
  }
}

function dropEmbedding(db: Database.Database, id: string): void {
  try {
    new EmbeddingRepository(db).deleteByMemoryId(id);
  } catch {
    // vec0 may be unavailable on this platform — nothing to invalidate.
  }
}

export function registerMemoryRoutes(app: FastifyInstance, cfg: MemoryRouteConfig): void {
  // ---- Memories ----

  /** List / search memories */
  app.get('/api/memory', async (request, reply) => {
    try {
      const query = request.query as {
        q?: string;
        scope?: string;
        project_id?: string;
        offset?: string;
        limit?: string;
      };

      let sql = 'SELECT * FROM memories WHERE 1=1';
      const params: (string | number)[] = [];

      if (query.q) {
        sql += ' AND content LIKE ?';
        params.push(`%${query.q}%`);
      }
      if (query.scope && query.scope !== 'all') {
        sql += ' AND scope = ?';
        params.push(query.scope);
      }
      if (query.project_id && query.project_id !== 'all') {
        sql += ' AND scope_key LIKE ?';
        params.push(`%${query.project_id}%`);
      }

      sql += ' ORDER BY updated_at DESC';

      const limit = Math.min(parseInt(query.limit || '20', 10) || 20, 100);
      const offset = parseInt(query.offset || '0', 10) || 0;
      sql += ' LIMIT ? OFFSET ?';
      params.push(limit, offset);

      const rows = cfg.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;

      const memories = rows.map((r: any) => ({
        id: r.id,
        scope: r.scope,
        scope_key: r.scope_key,
        kind: r.kind,
        content: typeof r.content === 'string' ? r.content : JSON.stringify(r.content),
        agent_id: r.agent_id || null,
        visibility: r.visibility || 'shared',
        status: r.status || 'active',
        confidence: r.confidence ?? 0.5,
        source_channel: r.source_channel || null,
        created_at: r.created_at,
        updated_at: r.updated_at,
      }));

      return reply.send(memories);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: message });
    }
  });

  /** Get single memory */
  app.get<{ Params: { id: string } }>('/api/memory/:id', async (request, reply) => {
    try {
      const row = cfg.db.prepare('SELECT * FROM memories WHERE id = ?').get(request.params.id) as
        Record<string, unknown> | undefined;
      if (!row) return reply.status(404).send({ error: 'Memory not found' });
      return reply.send(row);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: message });
    }
  });

  /** Update memory content */
  app.put<{ Params: { id: string } }>('/api/memory/:id', async (request, reply) => {
    try {
      const { content } = request.body as { content?: string };
      if (typeof content !== 'string') {
        return reply.status(400).send({ error: 'content is required' });
      }

      const row = cfg.db.prepare('SELECT * FROM memories WHERE id = ?').get(request.params.id) as
        Record<string, unknown> | undefined;
      if (!row) return reply.status(404).send({ error: 'Memory not found' });

      new MemoryRepository(cfg.db).update(request.params.id, { content });
      reindexLexicalTerms(cfg.db, request.params.id, content);
      // The stored vector still describes the previous text; re-embedding is an
      // async provider call this route cannot make, so drop it — lexical and
      // FTS recall keep working, and the next write re-embeds.
      dropEmbedding(cfg.db, request.params.id);

      return reply.send({ ok: true, id: request.params.id });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: message });
    }
  });

  /** Delete memory */
  app.delete<{ Params: { id: string } }>('/api/memory/:id', async (request, reply) => {
    try {
      const row = cfg.db.prepare('SELECT * FROM memories WHERE id = ?').get(request.params.id);
      if (!row) return reply.status(404).send({ error: 'Memory not found' });

      new MemoryRepository(cfg.db).delete(request.params.id);
      cfg.db.prepare('DELETE FROM memory_terms WHERE memory_id = ?').run(request.params.id);
      dropEmbedding(cfg.db, request.params.id);
      return reply.send({ ok: true, id: request.params.id });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: message });
    }
  });

  // ---- Persona ----

  /** Get current persona */
  app.get('/api/persona', async (_request, reply) => {
    try {
      if (cfg.services.approvalGate) {
        // PersonaStore is accessed via memoryRepo
        const personaStore = (cfg.services as any).personaStore;
        if (personaStore?.get) {
          const persona = personaStore.get();
          return reply.send(persona || {});
        }
      }

      // Fallback: read directly from memories table
      const row = cfg.db
        .prepare(
          "SELECT * FROM memories WHERE kind = 'persona' AND scope = 'user' ORDER BY updated_at DESC LIMIT 1",
        )
        .get() as Record<string, unknown> | undefined;

      if (row) {
        try {
          return reply.send(JSON.parse(row.content as string));
        } catch {
          return reply.send({});
        }
      }
      return reply.send({});
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: message });
    }
  });

  /** Save persona (full replacement) */
  app.put('/api/persona', async (request, reply) => {
    try {
      const persona = request.body as Record<string, unknown>;
      if (!persona || typeof persona !== 'object') {
        return reply.status(400).send({ error: 'Invalid persona data' });
      }

      // Try via PersonaStore first
      const personaStore = (cfg.services as any).personaStore;
      if (personaStore?.save) {
        const { createEmptyPersona } = await import('../../memory/persona-model.js');
        const base = personaStore.get() ?? createEmptyPersona();
        const updated = { ...base, ...persona, lastUpdated: new Date().toISOString() };
        personaStore.save(updated);
        return reply.send({ ok: true });
      }

      // Fallback: write directly to memories table
      const content = JSON.stringify({ ...persona, lastUpdated: new Date().toISOString() });
      const existing = cfg.db
        .prepare("SELECT id FROM memories WHERE kind = 'persona' AND scope = 'user' LIMIT 1")
        .get() as { id: string } | undefined;

      if (existing) {
        // Route through the repository (syncs jieba FTS) and refresh the
        // derived stores — lexical terms and the stale vector — the same way
        // PUT /:id above does. The old raw UPDATE left all three stale.
        new MemoryRepository(cfg.db).update(existing.id, { content });
        reindexLexicalTerms(cfg.db, existing.id, content);
        dropEmbedding(cfg.db, existing.id);
      } else {
        // create() syncs jieba FTS internally; terms need explicit indexing.
        const created = new MemoryRepository(cfg.db).create({
          id: '__persona__',
          scope: 'user',
          scope_key: '__persona__',
          kind: 'persona',
          content,
          visibility: 'shared',
        });
        reindexLexicalTerms(cfg.db, created.id, content);
      }

      return reply.send({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: message });
    }
  });
}
