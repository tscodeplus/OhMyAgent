// ---------------------------------------------------------------------------
// Tests for write-side knowledge page invalidation (plan §8 S1, revision A3).
//
// The bug: `knowledge_sources` has no FK to `memories`, so correcting a memory
// left every page that cites it `active` — and an `active` page wins every read,
// including the per-turn injection lane, which never goes through
// `unified-search`. The fix re-queues the citing pages on the write side.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema } from '../../src/memory/schema';
import { openDatabase } from '../../src/memory/db';
import { invalidatePagesCitingMemory } from '../../src/memory/knowledge/memory-page-invalidation';

describe('invalidatePagesCitingMemory', () => {
  let db: Database.Database;

  beforeEach(() => {
    // openDatabase runs every migration, so migration-v14's knowledge tables
    // exist exactly as they do in production.
    db = openDatabase(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  function seedPage(options: {
    id: string;
    status?: string;
    cites?: string[];
    asOf?: number;
  }): void {
    const now = options.asOf ?? Date.now();
    db.prepare(
      `INSERT INTO knowledge_pages (id, page_type, slug, title, content, version, status, created_at, updated_at, updated_by)
       VALUES (?, 'topic', ?, ?, 'body', 3, ?, ?, ?, 'agent')`,
    ).run(options.id, options.id, options.id, options.status ?? 'active', now, now);
    for (const source of options.cites ?? []) {
      db.prepare(
        `INSERT INTO knowledge_sources (page_id, source_kind, source_id, created_at)
         VALUES (?, 'memory', ?, ?)`,
      ).run(options.id, source, now);
    }
  }

  function pageStatus(id: string): { status: string; version: number } {
    return db.prepare('SELECT status, version FROM knowledge_pages WHERE id = ?').get(id) as {
      status: string;
      version: number;
    };
  }

  function logRows(pageId: string): Array<{ action: string; actor: string; reason: string }> {
    return db
      .prepare('SELECT action, actor, reason FROM knowledge_log WHERE page_id = ?')
      .all(pageId) as Array<{ action: string; actor: string; reason: string }>;
  }

  it('re-queues an active page that cites the memory, with a log row saying why', async () => {
    seedPage({ id: 'page-a', cites: ['mem-1'] });

    const flipped = await invalidatePagesCitingMemory(db, 'mem-1', 'update');

    expect(flipped).toBe(1);
    expect(pageStatus('page-a')).toEqual({ status: 'pending', version: 4 });
    const rows = logRows('page-a');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'pending', actor: 'system' });
    expect(rows[0].reason).toContain('mem-1');
  });

  it('touches nothing when no page cites the memory', async () => {
    seedPage({ id: 'page-a', cites: ['mem-other'] });

    const flipped = await invalidatePagesCitingMemory(db, 'mem-1', 'update');

    expect(flipped).toBe(0);
    expect(pageStatus('page-a').status).toBe('active');
    expect(logRows('page-a')).toHaveLength(0);
  });

  it('leaves pages that already left `active` alone (idempotent, no log spam)', async () => {
    seedPage({ id: 'page-a', status: 'pending', cites: ['mem-1'] });

    expect(await invalidatePagesCitingMemory(db, 'mem-1', 'update')).toBe(0);
    expect(await invalidatePagesCitingMemory(db, 'mem-1', 'update')).toBe(0);
    expect(pageStatus('page-a')).toEqual({ status: 'pending', version: 3 });
    expect(logRows('page-a')).toHaveLength(0);
  });

  it('re-queues only once when the same memory is written twice', async () => {
    seedPage({ id: 'page-a', cites: ['mem-1'] });

    expect(await invalidatePagesCitingMemory(db, 'mem-1', 'update')).toBe(1);
    expect(await invalidatePagesCitingMemory(db, 'mem-1', 'update')).toBe(0);
    expect(logRows('page-a')).toHaveLength(1);
  });

  it('re-queues every page citing one memory', async () => {
    seedPage({ id: 'page-a', cites: ['mem-1'] });
    seedPage({ id: 'page-b', cites: ['mem-1', 'mem-2'] });
    seedPage({ id: 'page-c', cites: ['mem-2'] });

    expect(await invalidatePagesCitingMemory(db, 'mem-1', 'write')).toBe(2);
    expect(pageStatus('page-a').status).toBe('pending');
    expect(pageStatus('page-b').status).toBe('pending');
    expect(pageStatus('page-c').status).toBe('active');
  });

  it('is a no-op rather than a throw on a database without the knowledge layer', async () => {
    const bare = new Database(':memory:');
    applySchema(bare); // memories only, no migration-v14 tables
    try {
      await expect(invalidatePagesCitingMemory(bare, 'mem-1', 'update')).resolves.toBe(0);
    } finally {
      bare.close();
    }
  });

  it('is a no-op when the writer was built without a database', async () => {
    await expect(invalidatePagesCitingMemory(undefined, 'mem-1', 'update')).resolves.toBe(0);
  });
});
