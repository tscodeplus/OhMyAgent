import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema } from '../../src/memory/schema.js';
import { MemoryRepository } from '../../src/memory/repositories/memory-repository.js';
import { MemoryHygiene } from '../../src/memory/memory-hygiene.js';

describe('MemoryHygiene', () => {
  let db: Database.Database;
  let repo: MemoryRepository;
  let hygiene: MemoryHygiene;

  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db);
    repo = new MemoryRepository(db);
    hygiene = new MemoryHygiene(repo, db, {
      tempRetentionDays: 90,
      checkIntervalMs: 0,  // always run for testing
    });
  });

  function insertMemory(id: string, kind: string, daysAgo: number) {
    const pastDate = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 19)
      .replace('T', ' ');
    db.prepare(`INSERT INTO memories (id, scope, scope_key, kind, content, created_at, updated_at) VALUES (?, 'user', 'u1', ?, 'test', ?, ?)`)
      .run(id, kind, pastDate, pastDate);
    // Also insert an embedding row to test cascade
    db.prepare('INSERT INTO memory_embeddings (id, memory_id, embedding, model, dimension) VALUES (?, ?, ?, ?, ?)')
      .run(`emb-${id}`, id, Buffer.alloc(16), 'test-model', 4);
  }

  it('cleans old temporary memories', () => {
    insertMemory('m1', 'fact', 100);
    insertMemory('m2', 'task', 95);
    insertMemory('m3', 'device_state', 91);

    const report = hygiene.clean();
    expect(report.cleanedCount).toBe(3);
    expect(report.cleanedKinds['fact']).toBe(1);
    expect(report.cleanedKinds['task']).toBe(1);
    expect(report.cleanedKinds['device_state']).toBe(1);
  });

  it('preserves preference memories', () => {
    insertMemory('m1', 'preference', 100);
    insertMemory('m2', 'fact', 100);

    const report = hygiene.clean();
    expect(report.cleanedCount).toBe(1);  // only the fact
    expect(repo.findById('m1')).toBeDefined();  // preference survived
    expect(repo.findById('m2')).toBeUndefined();
  });

  it('preserves summary memories', () => {
    insertMemory('m1', 'summary', 100);
    insertMemory('m2', 'task', 100);

    const report = hygiene.clean();
    expect(repo.findById('m1')).toBeDefined();
    expect(repo.findById('m2')).toBeUndefined();
  });

  it('does not clean memories younger than retention period', () => {
    insertMemory('m1', 'fact', 30);
    insertMemory('m2', 'fact', 60);

    const report = hygiene.clean();
    expect(report.cleanedCount).toBe(0);
    expect(repo.findById('m1')).toBeDefined();
    expect(repo.findById('m2')).toBeDefined();
  });

  it('compares cutoff using SQLite datetime format on the retention boundary day', () => {
    const now = Date.now();
    const oldEnough = new Date(now - 90 * 24 * 60 * 60 * 1000 - 60_000)
      .toISOString()
      .slice(0, 19)
      .replace('T', ' ');
    const tooNew = new Date(now - 90 * 24 * 60 * 60 * 1000 + 60_000)
      .toISOString()
      .slice(0, 19)
      .replace('T', ' ');

    db.prepare(`INSERT INTO memories (id, scope, scope_key, kind, content, created_at, updated_at) VALUES (?, 'user', 'u1', 'fact', 'old', ?, ?)`)
      .run('old-boundary', oldEnough, oldEnough);
    db.prepare(`INSERT INTO memories (id, scope, scope_key, kind, content, created_at, updated_at) VALUES (?, 'user', 'u1', 'fact', 'new', ?, ?)`)
      .run('new-boundary', tooNew, tooNew);

    const report = hygiene.clean();

    expect(report.cleanedCount).toBe(1);
    expect(repo.findById('old-boundary')).toBeUndefined();
    expect(repo.findById('new-boundary')).toBeDefined();
  });

  it('deletes associated embeddings', () => {
    insertMemory('m1', 'fact', 100);
    const embBefore = db.prepare("SELECT COUNT(*) as cnt FROM memory_embeddings WHERE memory_id = 'm1'").get() as { cnt: number };
    expect(embBefore.cnt).toBe(1);

    hygiene.clean();

    const embAfter = db.prepare("SELECT COUNT(*) as cnt FROM memory_embeddings WHERE memory_id = 'm1'").get() as { cnt: number };
    expect(embAfter.cnt).toBe(0);
  });

  it('returns zero when nothing to clean', () => {
    insertMemory('m1', 'fact', 10);
    const report = hygiene.clean();
    expect(report.cleanedCount).toBe(0);
  });

  it('handles empty database gracefully', () => {
    const report = hygiene.clean();
    expect(report.cleanedCount).toBe(0);
    expect(report.error).toBeUndefined();
  });

  it('updates checkpoint after cleaning', () => {
    insertMemory('m1', 'fact', 100);
    hygiene.clean();

    // Check that the checkpoint was written
    const checkpoint = repo.findById('__hygiene_last_check__');
    expect(checkpoint).toBeDefined();
    expect(checkpoint!.kind).toBe('hygiene_checkpoint');
  });
});
