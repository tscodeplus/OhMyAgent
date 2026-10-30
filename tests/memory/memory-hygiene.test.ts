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
      checkIntervalMs: 0, // always run for testing
    });
  });

  function insertMemory(id: string, kind: string, daysAgo: number) {
    // Production format: memories.updated_at stores epoch milliseconds as TEXT
    // (schema default cast(strftime('%s','now') as integer) * 1000).
    const pastMs = String(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
    db.prepare(
      `INSERT INTO memories (id, scope, scope_key, kind, content, created_at, updated_at) VALUES (?, 'user', 'u1', ?, 'test', ?, ?)`,
    ).run(id, kind, pastMs, pastMs);
    // Also insert an embedding row to test cascade
    db.prepare(
      'INSERT INTO memory_embeddings (id, memory_id, embedding, model, dimension) VALUES (?, ?, ?, ?, ?)',
    ).run(`emb-${id}`, id, Buffer.alloc(16), 'test-model', 4);
  }

  it('cleans old temporary memories', () => {
    // Create enough non-expired temp memories so the expired ratio stays < 80%
    insertMemory('m1', 'fact', 100);
    insertMemory('m2', 'task', 95);
    insertMemory('m3', 'device_state', 91);
    // Fresh temp-kind memories to keep ratio below safety threshold
    insertMemory('m4', 'fact', 5);
    insertMemory('m5', 'task', 3);

    const report = hygiene.clean();
    expect(report.cleanedCount).toBe(3);
    expect(report.cleanedKinds['fact']).toBe(1);
    expect(report.cleanedKinds['task']).toBe(1);
    expect(report.cleanedKinds['device_state']).toBe(1);
  });

  it('preserves preference memories', () => {
    insertMemory('m1', 'preference', 100);
    insertMemory('m2', 'fact', 100);
    // Add fresh temp memories to keep expired ratio < 80%
    insertMemory('m3', 'fact', 5);
    insertMemory('m4', 'task', 3);

    const report = hygiene.clean();
    expect(report.cleanedCount).toBe(1); // only the fact
    expect(repo.findById('m1')).toBeDefined(); // preference survived
    expect(repo.findById('m2')).toBeUndefined();
  });

  it('preserves summary memories', () => {
    insertMemory('m1', 'summary', 100);
    insertMemory('m2', 'task', 100);
    // Add fresh temp memories to keep expired ratio < 80%
    insertMemory('m3', 'fact', 5);
    insertMemory('m4', 'device_state', 3);

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

  it('compares cutoff using the stored epoch-milliseconds format on the retention boundary day', () => {
    const now = Date.now();
    const oldEnough = String(now - 90 * 24 * 60 * 60 * 1000 - 60_000);
    const tooNew = String(now - 90 * 24 * 60 * 60 * 1000 + 60_000);

    db.prepare(
      `INSERT INTO memories (id, scope, scope_key, kind, content, created_at, updated_at) VALUES (?, 'user', 'u1', 'fact', 'old', ?, ?)`,
    ).run('old-boundary', oldEnough, oldEnough);
    db.prepare(
      `INSERT INTO memories (id, scope, scope_key, kind, content, created_at, updated_at) VALUES (?, 'user', 'u1', 'fact', 'new', ?, ?)`,
    ).run('new-boundary', tooNew, tooNew);

    const report = hygiene.clean();

    expect(report.cleanedCount).toBe(1);
    expect(repo.findById('old-boundary')).toBeUndefined();
    expect(repo.findById('new-boundary')).toBeDefined();
  });

  it('deletes associated embeddings', () => {
    insertMemory('m1', 'fact', 100);
    // Add fresh temp memories to keep expired ratio < 80%
    insertMemory('m2', 'fact', 5);
    insertMemory('m3', 'task', 3);
    const embBefore = db
      .prepare("SELECT COUNT(*) as cnt FROM memory_embeddings WHERE memory_id = 'm1'")
      .get() as { cnt: number };
    expect(embBefore.cnt).toBe(1);

    hygiene.clean();

    const embAfter = db
      .prepare("SELECT COUNT(*) as cnt FROM memory_embeddings WHERE memory_id = 'm1'")
      .get() as { cnt: number };
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
    // Add fresh temp memories to keep expired ratio < 80%
    insertMemory('m2', 'fact', 5);
    hygiene.clean();

    // Check that the checkpoint was written
    const checkpoint = repo.findById('__hygiene_last_check__');
    expect(checkpoint).toBeDefined();
    expect(checkpoint!.kind).toBe('hygiene_checkpoint');
  });

  /**
   * Plan §8 S2 / review finding F5: the delete decision needs to know that a page
   * was citing the row. Counted before the delete — afterwards the citation is
   * dangling and the question is unanswerable.
   */
  it('reports how many deleted memories an active page still cites', () => {
    db.exec(`
      CREATE TABLE knowledge_pages (id TEXT PRIMARY KEY, status TEXT);
      CREATE TABLE knowledge_sources (page_id TEXT, source_kind TEXT, source_id TEXT);
    `);
    insertMemory('m1', 'fact', 100);
    insertMemory('m2', 'fact', 95);
    insertMemory('m3', 'fact', 5); // fresh, keeps the expired ratio under 80%
    db.prepare("INSERT INTO knowledge_pages (id, status) VALUES ('p1', 'active')").run();
    db.prepare("INSERT INTO knowledge_pages (id, status) VALUES ('p2', 'archived')").run();
    db.prepare(
      "INSERT INTO knowledge_sources (page_id, source_kind, source_id) VALUES ('p1', 'memory', 'm1')",
    ).run();
    // An archived page is not read anywhere, so it is not a loss.
    db.prepare(
      "INSERT INTO knowledge_sources (page_id, source_kind, source_id) VALUES ('p2', 'memory', 'm2')",
    ).run();

    const report = hygiene.clean();

    expect(report.cleanedCount).toBe(2);
    expect(report.citedByActivePages).toBe(1);
  });

  it('omits the citation count when nothing cited a deleted row', () => {
    insertMemory('m1', 'fact', 100);
    insertMemory('m2', 'fact', 5);

    const report = hygiene.clean();

    expect(report.citedByActivePages).toBeUndefined();
  });
});
