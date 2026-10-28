import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema } from '../../src/memory/schema.js';
import { migrateV14 } from '../../src/memory/migration-v14.js';
import { MemoryRepository } from '../../src/memory/repositories/memory-repository.js';
import { MemoryHygiene } from '../../src/memory/memory-hygiene.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `knowledge.log_retention_days` pruning, which rides on the existing hygiene
 * pass (`MemoryHygiene.clean()`) rather than a scheduler of its own — the plan
 * forbids a second one. `knowledge_log.created_at` is INTEGER epoch-ms, so the
 * horizon is tested with a fake clock instead of by backdating rows only.
 */
describe('MemoryHygiene — knowledge_log retention', () => {
  let db: Database.Database;
  let repo: MemoryRepository;

  function buildHygiene(knowledgeLogRetentionDays?: number): MemoryHygiene {
    return new MemoryHygiene(repo, db, {
      tempRetentionDays: 90,
      checkIntervalMs: 0,
      ...(knowledgeLogRetentionDays === undefined ? {} : { knowledgeLogRetentionDays }),
    });
  }

  function insertLog(id: string, createdAt: number): void {
    db.prepare(
      `INSERT INTO knowledge_log (id, page_id, action, actor, created_at)
       VALUES (?, NULL, 'create', 'system', ?)`,
    ).run(id, createdAt);
  }

  function logIds(): string[] {
    return (
      db.prepare('SELECT id FROM knowledge_log ORDER BY id').all() as Array<{ id: string }>
    ).map((row) => row.id);
  }

  /** A fact-kind memory old enough for the existing temp-kind retention. */
  function insertOldFact(id: string): void {
    insertFact(id, 100);
  }

  /**
   * A temp-kind memory `daysAgo` old. Fresh rows are needed alongside expired
   * ones: the pass refuses to delete more than 80% of the temp kinds at once.
   */
  function insertFact(id: string, daysAgo: number, database: Database.Database = db): void {
    const pastMs = String(Date.now() - daysAgo * DAY_MS);
    database
      .prepare(
        `INSERT INTO memories (id, scope, scope_key, kind, content, created_at, updated_at)
         VALUES (?, 'user', 'u1', 'fact', 'test', ?, ?)`,
      )
      .run(id, pastMs, pastMs);
  }

  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db);
    migrateV14(db);
    repo = new MemoryRepository(db);
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  it('prunes log rows older than the horizon and reports them in cleanedKinds', () => {
    const now = Date.now();
    insertLog('log-old-1', now - 120 * DAY_MS);
    insertLog('log-old-2', now - 91 * DAY_MS);
    insertLog('log-fresh', now - 10 * DAY_MS);

    const report = buildHygiene(90).clean();

    expect(logIds()).toEqual(['log-fresh']);
    expect(report.cleanedKinds['knowledge_log']).toBe(2);
    expect(report.cleanedCount).toBe(2);
    expect(report.error).toBeUndefined();
  });

  it('keeps rows exactly inside the horizon', () => {
    const now = Date.now();
    insertLog('log-inside', now - 89 * DAY_MS);
    insertLog('log-edge', now - 90 * DAY_MS + 60_000);

    const report = buildHygiene(90).clean();

    expect(logIds()).toEqual(['log-edge', 'log-inside']);
    expect(report.cleanedKinds['knowledge_log']).toBeUndefined();
  });

  it('0 means keep forever', () => {
    insertLog('log-ancient', Date.now() - 5000 * DAY_MS);

    const report = buildHygiene(0).clean();

    expect(logIds()).toEqual(['log-ancient']);
    expect(report.cleanedKinds['knowledge_log']).toBeUndefined();
    expect(report.cleanedCount).toBe(0);
  });

  it('defaults to 90 days when the knowledge block is not wired', () => {
    insertLog('log-ancient', Date.now() - 91 * DAY_MS);
    insertLog('log-recent', Date.now() - 5 * DAY_MS);

    buildHygiene().clean();

    expect(logIds()).toEqual(['log-recent']);
  });

  it('advances with the clock: a row that is young today is pruned later', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    insertLog('log-row', Date.now() - 89 * DAY_MS);

    // Day 0: inside the 90-day horizon.
    expect(buildHygiene(90).clean().cleanedKinds['knowledge_log']).toBeUndefined();
    expect(logIds()).toEqual(['log-row']);

    // Two days later the same row has crossed the horizon.
    vi.setSystemTime(new Date('2026-01-03T00:00:00.000Z'));
    const report = buildHygiene(90).clean();

    expect(logIds()).toEqual([]);
    expect(report.cleanedKinds['knowledge_log']).toBe(1);
  });

  it('counts memory and log pruning in the same report', () => {
    insertOldFact('m1');
    // Keep the expired share of the temp kinds under the 80% refusal threshold.
    for (let index = 0; index < 4; index++) insertFact(`fresh${index}`, 5);
    insertLog('log-old', Date.now() - 200 * DAY_MS);

    const report = buildHygiene(90).clean();

    expect(report.cleanedKinds).toEqual({ fact: 1, knowledge_log: 1 });
    expect(report.cleanedCount).toBe(2);
  });

  it('leaves pages and sources alone — only the append-only log is pruned', () => {
    db.prepare(
      `INSERT INTO knowledge_pages (id, page_type, slug, title, content, version, status, created_at, updated_at)
       VALUES ('p1', 'topic', 'power-query', 'Power Query', 'body', 1, 'active', ?, ?)`,
    ).run(Date.now() - 500 * DAY_MS, Date.now() - 500 * DAY_MS);
    db.prepare(
      `INSERT INTO knowledge_sources (page_id, source_kind, source_id, created_at)
       VALUES ('p1', 'memory', 'm1', ?)`,
    ).run(Date.now() - 500 * DAY_MS);
    insertLog('log-old', Date.now() - 500 * DAY_MS);

    buildHygiene(90).clean();

    expect(db.prepare('SELECT COUNT(*) AS cnt FROM knowledge_pages').get()).toEqual({ cnt: 1 });
    expect(db.prepare('SELECT COUNT(*) AS cnt FROM knowledge_sources').get()).toEqual({ cnt: 1 });
    expect(logIds()).toEqual([]);
  });

  it('does not fail the pass when the knowledge layer was never migrated in', () => {
    const bare = new Database(':memory:');
    applySchema(bare);
    const bareRepo = new MemoryRepository(bare);
    insertFact('m1', 100, bare);
    for (let index = 0; index < 4; index++) insertFact(`fresh${index}`, 5, bare);

    const report = new MemoryHygiene(bareRepo, bare, {
      tempRetentionDays: 90,
      checkIntervalMs: 0,
    }).clean();

    expect(report.error).toBeUndefined();
    expect(report.cleanedKinds).toEqual({ fact: 1 });
    expect(bareRepo.findById('m1')).toBeUndefined();
    bare.close();
  });

  it('a refused pass (80% safety threshold) touches neither memories nor the log', () => {
    // 5 temp memories, 5 of them expired → the pass refuses.
    for (let index = 0; index < 5; index++) insertOldFact(`m${index}`);
    insertLog('log-old', Date.now() - 400 * DAY_MS);

    const report = buildHygiene(90).clean();

    expect(report.error).toContain('Safety threshold exceeded');
    expect(report.cleanedCount).toBe(0);
    expect(logIds()).toEqual(['log-old']);
    expect(repo.findById('m0')).toBeDefined();
  });
});
