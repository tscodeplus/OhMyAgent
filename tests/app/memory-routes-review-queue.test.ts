// ---------------------------------------------------------------------------
// Tests for GET /api/memory/review-queue (plan §8 S6).
//
// The queue is the memory-side counterpart of the knowledge `pending` review
// path. It is a read-only view over existing rows — no `pending` status column,
// no new write path — so these tests pin (a) which rows surface, (b) which
// reason each carries, and (c) that the scan stays bounded.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import Database from 'better-sqlite3';
import { applySchema } from '../../src/memory/schema';
import { MemoryRepository } from '../../src/memory/repositories/memory-repository';
import { registerMemoryRoutes } from '../../src/app/webui/memory-routes';
import { resetWebUIToken } from '../../src/app/webui-auth';

interface QueueItem {
  id: string;
  scope: string;
  scope_key: string | null;
  kind: string;
  content: string;
  reasons: string[];
  duplicate_of: string | null;
}

interface QueueResponse {
  items: QueueItem[];
  limit: number;
  window: number;
  scanned: number;
  counts: { volatile: number; duplicate: number };
}

describe('memory routes — review queue', () => {
  let app: ReturnType<typeof Fastify>;
  let db: Database.Database;
  let repo: MemoryRepository;

  beforeEach(() => {
    vi.resetModules();
    db = new Database(':memory:');
    applySchema(db);
    repo = new MemoryRepository(db);
    app = Fastify({ logger: false });
    registerMemoryRoutes(app, { db, services: {} as any });
  });

  afterEach(async () => {
    await app.close();
    db.close();
    resetWebUIToken();
  });

  function seed(overrides: {
    content?: string;
    scope?: string;
    scopeKey?: string;
    kind?: string;
    status?: string;
    /** Epoch-ms string: `memories.created_at` is a TEXT column. */
    createdAt?: string;
  }): string {
    const id = `mem-${Math.random().toString(36).slice(2, 10)}`;
    repo.create({
      id,
      scope: overrides.scope ?? 'user',
      scope_key: overrides.scopeKey ?? 'session-1',
      kind: overrides.kind ?? 'fact',
      content: overrides.content ?? 'plain content',
      status: overrides.status ?? 'active',
      created_at: overrides.createdAt,
    });
    return id;
  }

  async function fetchQueue(query = ''): Promise<QueueResponse> {
    const res = await app.inject({ method: 'GET', url: `/api/memory/review-queue${query}` });
    expect(res.statusCode).toBe(200);
    return res.json() as QueueResponse;
  }

  it('flags a cached directory listing as volatile', async () => {
    const id = seed({ content: 'E:\\Excel 目录下当前有 4 个 Excel 文件。' });
    const body = await fetchQueue();

    const item = body.items.find((i) => i.id === id);
    expect(item?.reasons).toEqual(['volatile']);
    expect(body.counts.volatile).toBe(1);
  });

  it('leaves a durable memory out of the queue', async () => {
    seed({ content: '叫我 Boss' });
    const body = await fetchQueue();
    expect(body.items).toEqual([]);
  });

  it('flags the older copy of a duplicate pair and names the newer one', async () => {
    const older = seed({ content: '同一个事实', createdAt: '1000' });
    const newer = seed({ content: '同一个事实', createdAt: '2000' });

    const body = await fetchQueue();
    const item = body.items.find((i) => i.id === older);

    expect(item?.reasons).toEqual(['duplicate']);
    expect(item?.duplicate_of).toBe(newer);
    // The newest copy is the survivor, so it is not itself queued.
    expect(body.items.some((i) => i.id === newer)).toBe(false);
  });

  it('does not pair identical text from different conversations', async () => {
    seed({ content: '同一个事实', scopeKey: 'session-a' });
    seed({ content: '同一个事实', scopeKey: 'session-b' });

    const body = await fetchQueue();
    expect(body.counts.duplicate).toBe(0);
  });

  it('only queues active memories', async () => {
    seed({ content: 'E:\\Excel 目录下当前有 4 个 Excel 文件。', status: 'deleted' });
    const body = await fetchQueue();
    expect(body.items).toEqual([]);
  });

  it('caps items at limit while still reporting how many rows were scanned', async () => {
    for (let i = 0; i < 5; i++) seed({ content: `共 ${i} 条待办事项` });

    const body = await fetchQueue('?limit=2&window=50');
    expect(body.items).toHaveLength(2);
    expect(body.limit).toBe(2);
    expect(body.window).toBe(50);
    expect(body.scanned).toBe(5);
  });

  it('clamps limit and window into their supported ranges', async () => {
    const body = await fetchQueue('?limit=9999&window=1');
    expect(body.limit).toBe(200);
    expect(body.window).toBe(50);
  });
});
