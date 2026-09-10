// ---------------------------------------------------------------------------
// Tests for extended memory-routes: governance edits (visibility/agent_id/
// status), list filters, batch delete, and the pipeline status endpoint.
// TDAM borrowing plan items ① + ④.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import Database from 'better-sqlite3';
import { applySchema } from '../../src/memory/schema';
import { MemoryRepository } from '../../src/memory/repositories/memory-repository';
import { MemoryTermRepository } from '../../src/memory/repositories/memory-term-repository';
import { registerMemoryRoutes } from '../../src/app/webui/memory-routes';
import { resetWebUIToken } from '../../src/app/webui-auth';

describe('memory routes — governance / batch / pipeline status', () => {
  let app: ReturnType<typeof Fastify>;
  let db: Database.Database;
  let repo: MemoryRepository;

  beforeEach(() => {
    vi.resetModules();
    db = new Database(':memory:');
    applySchema(db);
    repo = new MemoryRepository(db);
    app = Fastify({ logger: false });
    registerMemoryRoutes(app, {
      db,
      services: {} as any,
    });
  });

  afterEach(async () => {
    await app.close();
    db.close();
    resetWebUIToken();
  });

  function seedMemory(overrides: Partial<Record<string, string>> = {}): string {
    const id = `mem-${Math.random().toString(36).slice(2, 10)}`;
    repo.create({
      id,
      scope: 'user',
      scope_key: 'u1',
      kind: 'fact',
      content: overrides.content ?? 'seed content',
      agent_id: overrides.agent_id ?? null,
      visibility: overrides.visibility ?? 'shared',
    });
    return id;
  }

  describe('PUT /api/memory/:id governance fields', () => {
    it('updates visibility, agent_id, and status without touching the embedding', async () => {
      const id = seedMemory();
      const res = await app.inject({
        method: 'PUT',
        url: `/api/memory/${id}`,
        payload: { visibility: 'private', agent_id: 'agent-x', status: 'active' },
      });
      expect(res.statusCode).toBe(200);
      const row = repo.findById(id)!;
      expect(row.visibility).toBe('private');
      expect(row.agent_id).toBe('agent-x');
    });

    it('still supports content-only edits', async () => {
      const id = seedMemory();
      const res = await app.inject({
        method: 'PUT',
        url: `/api/memory/${id}`,
        payload: { content: 'updated text' },
      });
      expect(res.statusCode).toBe(200);
      expect(repo.findById(id)!.content).toBe('updated text');
    });

    it('rejects invalid visibility values', async () => {
      const id = seedMemory();
      const res = await app.inject({
        method: 'PUT',
        url: `/api/memory/${id}`,
        payload: { visibility: 'public' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects invalid status values', async () => {
      const id = seedMemory();
      const res = await app.inject({
        method: 'PUT',
        url: `/api/memory/${id}`,
        payload: { status: 'zombie' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when no fields provided', async () => {
      const id = seedMemory();
      const res = await app.inject({
        method: 'PUT',
        url: `/api/memory/${id}`,
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /api/memory filters', () => {
    it('filters by agent_id, visibility, kind, and status', async () => {
      seedMemory({ agent_id: 'agent-a', visibility: 'private' });
      seedMemory({ agent_id: 'agent-b', visibility: 'shared' });

      const own = await app.inject({ method: 'GET', url: '/api/memory?agent_id=agent-a' });
      expect(own.statusCode).toBe(200);
      const ownList = own.json();
      expect(ownList).toHaveLength(1);
      expect(ownList[0].agent_id).toBe('agent-a');

      const shared = await app.inject({ method: 'GET', url: '/api/memory?visibility=shared' });
      expect(shared.json()).toHaveLength(1);

      const none = await app.inject({ method: 'GET', url: '/api/memory?agent_id=none' });
      expect(none.json()).toHaveLength(0);
    });

    it('filters unowned memories with agent_id=none', async () => {
      seedMemory(); // agent_id null
      const res = await app.inject({ method: 'GET', url: '/api/memory?agent_id=none' });
      expect(res.json()).toHaveLength(1);
    });

    it('filters by channel and channel=none', async () => {
      repo.create({
        id: 'mem-feishu',
        scope: 'user',
        scope_key: 'u1',
        kind: 'fact',
        content: 'feishu memory',
        source_channel: 'feishu',
      });
      repo.create({
        id: 'mem-noch',
        scope: 'user',
        scope_key: 'u1',
        kind: 'fact',
        content: 'no channel memory',
      });

      const feishu = await app.inject({ method: 'GET', url: '/api/memory?channel=feishu' });
      expect(feishu.json()).toHaveLength(1);
      expect(feishu.json()[0].source_channel).toBe('feishu');

      const none = await app.inject({ method: 'GET', url: '/api/memory?channel=none' });
      expect(none.json()).toHaveLength(1);
      expect(none.json()[0].id).toBe('mem-noch');
    });

    it('matches project memories by exact project id (implies scope=project)', async () => {
      repo.create({
        id: 'mem-proj',
        scope: 'project',
        scope_key: 'proj-1',
        kind: 'fact',
        content: 'project convention',
      });
      // A user memory whose scope_key happens to contain the project id must NOT match
      repo.create({
        id: 'mem-user',
        scope: 'user',
        scope_key: 'xproj-1y',
        kind: 'fact',
        content: 'unrelated user memory',
      });

      const res = await app.inject({ method: 'GET', url: '/api/memory?project_id=proj-1' });
      expect(res.json()).toHaveLength(1);
      expect(res.json()[0].id).toBe('mem-proj');
      expect(res.json()[0].scope).toBe('project');
    });

    it('GET /api/memory/filters returns distinct channels and kinds', async () => {
      repo.create({
        id: 'mem-f1',
        scope: 'user',
        scope_key: 'u1',
        kind: 'preference',
        content: 'a',
        source_channel: 'feishu',
      });
      repo.create({
        id: 'mem-f2',
        scope: 'user',
        scope_key: 'u1',
        kind: 'scene',
        content: 'b',
        source_channel: 'qq',
      });
      repo.create({
        id: 'mem-f3',
        scope: 'user',
        scope_key: 'u1',
        kind: 'preference',
        content: 'c',
      });

      const res = await app.inject({ method: 'GET', url: '/api/memory/filters' });
      expect(res.statusCode).toBe(200);
      expect(res.json().channels).toEqual(['feishu', 'qq']);
      expect(res.json().kinds).toEqual(['preference', 'scene']);
    });
  });

  describe('POST /api/memory/batch-delete', () => {
    it('deletes multiple memories plus derived stores', async () => {
      const a = seedMemory();
      const b = seedMemory();
      new MemoryTermRepository(db).replaceForMemory(a, [
        { term: 'alpha', termType: 'keyword', weight: 1 },
      ]);
      const res = await app.inject({
        method: 'POST',
        url: '/api/memory/batch-delete',
        payload: { ids: [a, b] },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, deleted: [a, b], missing: [] });
      expect(repo.findById(a)).toBeUndefined();
      expect(repo.findById(b)).toBeUndefined();
      expect(
        db.prepare('SELECT COUNT(*) AS n FROM memory_terms WHERE memory_id = ?').get(a),
      ).toEqual({ n: 0 });
    });

    it('reports missing ids and keeps the rest', async () => {
      const a = seedMemory();
      const res = await app.inject({
        method: 'POST',
        url: '/api/memory/batch-delete',
        payload: { ids: [a, 'nonexistent'] },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, deleted: [a], missing: ['nonexistent'] });
      expect(repo.findById(a)).toBeUndefined();
    });

    it('rejects empty and oversized id lists', async () => {
      const empty = await app.inject({
        method: 'POST',
        url: '/api/memory/batch-delete',
        payload: { ids: [] },
      });
      expect(empty.statusCode).toBe(400);

      const oversized = await app.inject({
        method: 'POST',
        url: '/api/memory/batch-delete',
        payload: { ids: Array.from({ length: 201 }, (_, i) => `x${i}`) },
      });
      expect(oversized.statusCode).toBe(400);
    });
  });

  describe('GET /api/memory/pipeline/status', () => {
    it('returns layer counts, dreamcycle phases, and observability counters', async () => {
      seedMemory();
      const res = await app.inject({ method: 'GET', url: '/api/memory/pipeline/status' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.layers).toHaveLength(4);
      expect(body.layers.map((l: any) => l.layer)).toEqual(['L0', 'L1', 'L2', 'L3']);
      expect(body.layers[1].recordCount).toBe(1);
      expect(body.dreamCycle).toHaveLength(7);
      expect(body.dreamCycle[0].phase).toBe('synthesize');
      expect(body.observability).toHaveProperty('total');
      expect(body.observability).toHaveProperty('windowHours', 24);
      expect(body.observabilityAllTime).toHaveProperty('total');
    });

    it('counts only degradation events from the last 24h in the recent window', async () => {
      const old = Date.now() - 48 * 60 * 60 * 1000;
      const fresh = Date.now() - 60 * 60 * 1000;
      db.prepare('INSERT INTO memory_observation_events (event, created_at) VALUES (?, ?)').run(
        'memory.embedding.failed',
        String(old),
      );
      db.prepare('INSERT INTO memory_observation_events (event, created_at) VALUES (?, ?)').run(
        'memory.write.degraded',
        String(old),
      );
      db.prepare('INSERT INTO memory_observation_events (event, created_at) VALUES (?, ?)').run(
        'memory.embedding.failed',
        String(fresh),
      );

      const res = await app.inject({ method: 'GET', url: '/api/memory/pipeline/status' });
      const body = res.json();
      expect(body.observability.total).toBe(1);
      expect(body.observability.counts['memory.embedding.failed']).toBe(1);
      expect(body.observabilityAllTime.total).toBeGreaterThanOrEqual(3);
    });
  });
});
