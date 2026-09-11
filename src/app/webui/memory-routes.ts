/**
 * Memory & Persona API Routes
 *
 * Provides CRUD for memories and persona management.
 */

import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import type { AppServices } from '../types.js';
import { MemoryRepository } from '../../memory/repositories/memory-repository.js';
import { EmbeddingRepository } from '../../memory/repositories/embedding-repository.js';
import {
  MemoryTermRepository,
  extractMemoryTerms,
} from '../../memory/repositories/memory-term-repository.js';
import { MaintenanceRunRepository } from '../../memory/maintenance/maintenance-run-repository.js';
import { parseEpochMs } from '../../shared/timestamp.js';

/** DreamCycle phases — mirrors the phase list in dream-cycle.ts runAll(). */
const DREAMCYCLE_PHASES = [
  'synthesize',
  'backlinks',
  'extract',
  'sceneCluster',
  'hygiene',
  'embed',
  'purge',
] as const;

const VALID_VISIBILITIES = new Set(['shared', 'private', 'agent']);

interface MemoryRouteConfig {
  db: Database.Database;
  services: AppServices;
  /**
   * Base directory for scene digest files (`scenes/<scope>_<start>_<end>.md`)
   * — mirrors SceneClusterer's baseDir (`memory.offloading.refDir || './data'`).
   * When set, GET /api/memory/:id resolves kind='scene' rows to their digest
   * Markdown instead of the raw relative path stored in `content`.
   */
  sceneBaseDir?: string;
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

/** Delete a memory row plus its derived stores (terms + embedding). */
function deleteMemoryWithDerivedStores(db: Database.Database, id: string): void {
  new MemoryRepository(db).delete(id);
  db.prepare('DELETE FROM memory_terms WHERE memory_id = ?').run(id);
  dropEmbedding(db, id);
}

/**
 * Degradation events within the last 24h, counted straight from
 * memory_observation_events (epoch-ms digit-string timestamps).
 */
function recentObservabilityEvents(db: Database.Database): {
  windowHours: number;
  total: number;
  counts: Record<string, number>;
} {
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const counts: Record<string, number> = {};
  let total = 0;
  try {
    const rows = db
      .prepare(
        'SELECT event, COUNT(*) AS n FROM memory_observation_events WHERE CAST(created_at AS INTEGER) >= ? GROUP BY event',
      )
      .all(since) as Array<{ event: string; n: number | string }>;
    for (const row of rows) {
      counts[row.event] = Number(row.n);
      total += Number(row.n);
    }
  } catch {
    // Table may not exist yet on fresh DBs — report an empty window.
  }
  return { windowHours: 24, total, counts };
}

/** All-time degradation counters from memory_observation_events. */
function allTimeObservabilityEvents(db: Database.Database): {
  total: number;
  counts: Record<string, number>;
} {
  const counts: Record<string, number> = {};
  let total = 0;
  try {
    const rows = db
      .prepare('SELECT event, COUNT(*) AS n FROM memory_observation_events GROUP BY event')
      .all() as Array<{ event: string; n: number | string }>;
    for (const row of rows) {
      counts[row.event] = Number(row.n);
      total += Number(row.n);
    }
  } catch {
    // Table may not exist yet on fresh DBs.
  }
  return { total, counts };
}

/**
 * Degradation events since the last DreamCycle run started — the "latest run
 * was clean?" signal that the rolling 24h window cannot answer.
 */
function sinceLastRunObservabilityEvents(db: Database.Database): {
  runStartedAt: number | null;
  total: number;
  counts: Record<string, number>;
} {
  let runStartedAt: number | null = null;
  try {
    const row = db
      .prepare(
        "SELECT MAX(started_at) AS started_at FROM maintenance_runs WHERE job_name LIKE 'dreamcycle_%'",
      )
      .get() as { started_at: string | null };
    const parsed = parseEpochMs(row?.started_at);
    runStartedAt = parsed > 0 ? parsed : null;
  } catch {
    // maintenance_runs may not exist yet on fresh DBs.
  }
  const counts: Record<string, number> = {};
  let total = 0;
  if (runStartedAt !== null) {
    try {
      const rows = db
        .prepare(
          'SELECT event, COUNT(*) AS n FROM memory_observation_events WHERE CAST(created_at AS INTEGER) >= ? GROUP BY event',
        )
        .all(runStartedAt) as Array<{ event: string; n: number | string }>;
      for (const row of rows) {
        counts[row.event] = Number(row.n);
        total += Number(row.n);
      }
    } catch {
      // Table may not exist yet on fresh DBs — report empty.
    }
  }
  return { runStartedAt, total, counts };
}

/**
 * Per-layer record counts for the pipeline status route, using the same L0–L3
 * mapping as MemoryPipeline (memory-pipeline.ts):
 *   L0 = raw sessions/messages, L1 = atomic memories (non-scene/persona),
 *   L2 = scene clusters, L3 = persona rows.
 */
function buildLayerCounts(db: Database.Database): Array<{
  layer: string;
  label: string;
  recordCount: number;
  lastProcessedAt: string | null;
}> {
  const scalar = (sql: string): number => {
    const row = db.prepare(sql).get() as { n?: number | string } | undefined;
    return row?.n != null ? Number(row.n) : 0;
  };
  const lastProcessed = (sql: string): string | null =>
    (db.prepare(sql).get() as { t?: string } | undefined)?.t ?? null;

  const l1 = scalar(
    "SELECT COUNT(*) AS n FROM memories WHERE status = 'active' AND kind NOT IN ('scene', 'persona')",
  );
  const l2 = scalar("SELECT COUNT(*) AS n FROM memories WHERE kind = 'scene'");
  const l3 = scalar("SELECT COUNT(*) AS n FROM memories WHERE kind = 'persona'");

  return [
    {
      layer: 'L0',
      label: 'Raw Conversation',
      recordCount: scalar('SELECT COUNT(*) AS n FROM sessions'),
      lastProcessedAt: lastProcessed('SELECT MAX(created_at) AS t FROM sessions'),
    },
    {
      layer: 'L1',
      label: 'Atomic Memories',
      recordCount: l1,
      lastProcessedAt: lastProcessed(
        "SELECT MAX(updated_at) AS t FROM memories WHERE status = 'active' AND kind NOT IN ('scene', 'persona')",
      ),
    },
    {
      layer: 'L2',
      label: 'Scene Clusters',
      recordCount: l2,
      lastProcessedAt: lastProcessed(
        "SELECT MAX(updated_at) AS t FROM memories WHERE kind = 'scene'",
      ),
    },
    {
      layer: 'L3',
      label: 'User Persona',
      recordCount: l3,
      lastProcessedAt: lastProcessed(
        "SELECT MAX(updated_at) AS t FROM memories WHERE kind = 'persona'",
      ),
    },
  ];
}

export function registerMemoryRoutes(app: FastifyInstance, cfg: MemoryRouteConfig): void {
  // ---- Memories ----

  /** Distinct filter facet values (channels, kinds) for dropdown population. */
  app.get('/api/memory/filters', async (_request, reply) => {
    try {
      const channels = (
        cfg.db
          .prepare(
            'SELECT DISTINCT source_channel FROM memories WHERE source_channel IS NOT NULL ORDER BY source_channel',
          )
          .all() as Array<{ source_channel: string }>
      ).map((r) => r.source_channel);
      const kinds = (
        cfg.db
          .prepare("SELECT DISTINCT kind FROM memories WHERE status = 'active' ORDER BY kind")
          .all() as Array<{
          kind: string;
        }>
      ).map((r) => r.kind);
      return reply.send({ channels, kinds });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: message });
    }
  });

  /** List / search memories */
  app.get('/api/memory', async (request, reply) => {
    try {
      const query = request.query as {
        q?: string;
        scope?: string;
        project_id?: string;
        agent_id?: string;
        visibility?: string;
        kind?: string;
        status?: string;
        channel?: string;
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
        // Project memories are scope='project' rows whose scope_key holds the
        // project id — match exactly (LIKE matched unrelated channel ids).
        sql += " AND scope = 'project' AND scope_key = ?";
        params.push(query.project_id);
      }
      if (query.channel && query.channel !== 'all') {
        if (query.channel === 'none') {
          sql += ' AND source_channel IS NULL';
        } else {
          sql += ' AND source_channel = ?';
          params.push(query.channel);
        }
      }
      if (query.agent_id) {
        // 'none' = unowned/global memories (agent_id IS NULL)
        if (query.agent_id === 'none') {
          sql += ' AND agent_id IS NULL';
        } else {
          sql += ' AND agent_id = ?';
          params.push(query.agent_id);
        }
      }
      if (query.visibility && query.visibility !== 'all') {
        sql += ' AND visibility = ?';
        params.push(query.visibility);
      }
      if (query.kind && query.kind !== 'all') {
        sql += ' AND kind = ?';
        params.push(query.kind);
      }
      if (query.status && query.status !== 'all') {
        sql += ' AND status = ?';
        params.push(query.status);
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
        metadata: r.metadata ?? null,
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
      // Scene rows store a relative digest path in `content` — resolve the
      // actual Markdown so the WebUI detail view shows the digest itself.
      if (row.kind === 'scene' && typeof row.content === 'string' && cfg.sceneBaseDir) {
        const refPath = row.content;
        // Only allow `scenes/<safe-name>.md` inside the scene base directory.
        if (refPath.startsWith('scenes/') && !refPath.includes('..') && refPath.endsWith('.md')) {
          try {
            const abs = path.join(cfg.sceneBaseDir, refPath);
            if (path.resolve(abs).startsWith(path.resolve(cfg.sceneBaseDir) + path.sep)) {
              row.sceneContent = readFileSync(abs, 'utf-8');
            }
          } catch {
            // File missing/unreadable — frontend falls back to the raw refPath.
          }
        }
      }
      return reply.send(row);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: message });
    }
  });

  /** Update memory content */
  /** Update memory content and/or governance fields (visibility / agent_id / status) */
  app.put<{ Params: { id: string } }>('/api/memory/:id', async (request, reply) => {
    try {
      const body = request.body as {
        content?: string;
        visibility?: string;
        agent_id?: string | null;
        status?: string;
      };

      const hasGovernanceFields =
        body.visibility !== undefined || body.agent_id !== undefined || body.status !== undefined;
      if (typeof body.content !== 'string' && !hasGovernanceFields) {
        return reply
          .status(400)
          .send({ error: 'content is required (or visibility/agent_id/status to update)' });
      }

      const row = cfg.db.prepare('SELECT * FROM memories WHERE id = ?').get(request.params.id) as
        Record<string, unknown> | undefined;
      if (!row) return reply.status(404).send({ error: 'Memory not found' });

      // hygiene_checkpoint rows are machine-managed internal bookmarks (the
      // content is the last-check epoch timestamp) — rewriting content or
      // governance fields would corrupt MemoryHygiene's bookkeeping. Deletion
      // via DELETE /api/memory/:id is still allowed.
      if (row.kind === 'hygiene_checkpoint') {
        return reply.status(400).send({
          error:
            'hygiene_checkpoint is a machine-managed internal bookmark and cannot be updated via API',
        });
      }

      const repo = new MemoryRepository(cfg.db);

      // Governance fields only — no content rewrite, so the stored embedding
      // and FTS index stay valid and are left untouched.
      const governanceUpdate: {
        visibility?: string;
        agent_id?: string | null;
        status?: string;
      } = {};
      if (body.visibility !== undefined) {
        if (!VALID_VISIBILITIES.has(body.visibility)) {
          return reply
            .status(400)
            .send({ error: `visibility must be one of: ${[...VALID_VISIBILITIES].join(', ')}` });
        }
        governanceUpdate.visibility = body.visibility;
      }
      if (body.agent_id !== undefined) {
        governanceUpdate.agent_id = body.agent_id === null ? null : String(body.agent_id);
      }
      if (body.status !== undefined) {
        if (!['active', 'superseded', 'deleted'].includes(body.status)) {
          return reply.status(400).send({ error: 'status must be active | superseded | deleted' });
        }
        governanceUpdate.status = body.status;
      }
      if (Object.keys(governanceUpdate).length > 0) {
        repo.update(request.params.id, governanceUpdate);
      }

      if (typeof body.content === 'string') {
        repo.update(request.params.id, { content: body.content });
        reindexLexicalTerms(cfg.db, request.params.id, body.content);
        // The stored vector still describes the previous text; re-embedding is an
        // async provider call this route cannot make, so drop it — lexical and
        // FTS recall keep working, and the next write re-embeds.
        dropEmbedding(cfg.db, request.params.id);
      }

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

      deleteMemoryWithDerivedStores(cfg.db, request.params.id);
      return reply.send({ ok: true, id: request.params.id });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: message });
    }
  });

  /**
   * Batch delete memories (TDAM v2.0.1-beta.2 "清空对话记忆" feature).
   * Body: { ids: string[] } — bounded at 200 to keep the sync SQLite work short.
   * Derived stores (memory_terms + embedding) are cleaned per id, same as the
   * single DELETE route.
   */
  app.post('/api/memory/batch-delete', async (request, reply) => {
    try {
      const body = request.body as { ids?: unknown };
      const ids = Array.isArray(body.ids)
        ? body.ids.filter((id): id is string => typeof id === 'string')
        : [];
      if (ids.length === 0) {
        return reply.status(400).send({ error: 'ids must be a non-empty string array' });
      }
      if (ids.length > 200) {
        return reply.status(400).send({ error: 'ids must contain at most 200 entries' });
      }

      const deleted: string[] = [];
      const missing: string[] = [];
      const deleteAll = cfg.db.transaction(() => {
        for (const id of ids) {
          const row = cfg.db.prepare('SELECT id FROM memories WHERE id = ?').get(id);
          if (!row) {
            missing.push(id);
            continue;
          }
          deleteMemoryWithDerivedStores(cfg.db, id);
          deleted.push(id);
        }
      });
      deleteAll();

      return reply.send({ ok: true, deleted, missing });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: message });
    }
  });

  /**
   * Memory pipeline status (TDAM `/v2/pipeline/status` analogue):
   * per-layer record counts, last DreamCycle phase runs, and memory
   * observability event counters. Read-only, computed live from the DB.
   */
  app.get('/api/memory/pipeline/status', async (_request, reply) => {
    try {
      const runRepo = new MaintenanceRunRepository(cfg.db);
      const dreamCycle = DREAMCYCLE_PHASES.map((phase) => {
        const run = runRepo.getLastRun(`dreamcycle_${phase}`);
        return {
          phase,
          status: run?.status ?? null,
          startedAt: run?.started_at ?? null,
          durationMs: run?.duration_ms ?? null,
          affectedRows: run?.affected_rows ?? null,
          error: run?.error ?? null,
        };
      });

      return reply.send({
        layers: buildLayerCounts(cfg.db),
        dreamCycle,
        // Recent-window counters only — the all-time count is dominated by
        // historical degradation and reads like a current fault otherwise.
        observability: recentObservabilityEvents(cfg.db),
        observabilityAllTime: allTimeObservabilityEvents(cfg.db),
        observabilitySinceLastRun: sinceLastRunObservabilityEvents(cfg.db),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: message });
    }
  });

  /**
   * Manual pipeline run trigger (DreamCycle runAll with force=true — heavy
   * phases are not grace-window-skipped). Fire-and-forget: the endpoint
   * returns immediately; poll /status for per-phase rows appearing.
   */
  app.post('/api/memory/pipeline/run', async (_request, reply) => {
    try {
      const dreamCycle = cfg.services.dreamCycle;
      if (!dreamCycle) {
        return reply.status(503).send({ error: 'DreamCycle not configured' });
      }
      dreamCycle
        .runAll({ force: true })
        .catch((err: unknown) => cfg.services.logger.warn({ err }, 'Manual DreamCycle run failed'));
      return reply.send({ ok: true, started: true });
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
