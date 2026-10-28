import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema } from '../../src/memory/schema.js';
import { MemoryRepository } from '../../src/memory/repositories/memory-repository.js';
import { MemoryHygiene } from '../../src/memory/memory-hygiene.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const INJECTION = 'memory.injection';
const FTS_FAILED = 'memory.fts.failed';

/**
 * `memory.injection` retention, which rides on the existing hygiene pass for
 * the same reason `knowledge_log` does: that table is append-only and grows
 * with prompt builds, and the plan forbids a second scheduler.
 *
 * `created_at` is a TEXT column whose DEFAULT writes epoch-ms as a digit
 * string, so rows are inserted in that production format and the horizon is
 * tested with a fake clock as well.
 */
describe('MemoryHygiene — memory.injection retention', () => {
  let db: Database.Database;
  let repo: MemoryRepository;
  let hygiene: MemoryHygiene;

  function insertEvent(event: string, createdAt: number): void {
    db.prepare('INSERT INTO memory_observation_events (event, created_at) VALUES (?, ?)').run(
      event,
      String(createdAt),
    );
  }

  function injectionRows(): number {
    const row = db
      .prepare('SELECT COUNT(*) AS cnt FROM memory_observation_events WHERE event = ?')
      .get(INJECTION) as { cnt: number };
    return row.cnt;
  }

  function hasEvent(event: string): boolean {
    return db.prepare('SELECT 1 FROM memory_observation_events WHERE event = ?').get(event) != null;
  }

  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db);
    repo = new MemoryRepository(db);
    hygiene = new MemoryHygiene(repo, db, { tempRetentionDays: 90, checkIntervalMs: 0 });
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  it('prunes injection rows older than 30 days and reports them', () => {
    const now = Date.now();
    insertEvent(INJECTION, now - 40 * DAY_MS);
    insertEvent(INJECTION, now - 31 * DAY_MS);
    insertEvent(INJECTION, now - 10 * DAY_MS);

    const report = hygiene.clean();

    expect(injectionRows()).toBe(1);
    expect(report.cleanedKinds[INJECTION]).toBe(2);
    expect(report.cleanedCount).toBe(2);
    expect(report.error).toBeUndefined();
  });

  it('never prunes failure events, however old', () => {
    const now = Date.now();
    insertEvent(INJECTION, now - 400 * DAY_MS);
    insertEvent(FTS_FAILED, now - 400 * DAY_MS);

    const report = hygiene.clean();

    expect(injectionRows()).toBe(0);
    expect(hasEvent(FTS_FAILED)).toBe(true);
    expect(report.cleanedKinds[INJECTION]).toBe(1);
    expect(report.cleanedKinds[FTS_FAILED]).toBeUndefined();
  });

  it('advances with the clock: a row that is young today is pruned later', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    insertEvent(INJECTION, Date.now() - 29 * DAY_MS);

    // Day 0: inside the 30-day horizon.
    expect(hygiene.clean().cleanedKinds[INJECTION]).toBeUndefined();
    expect(injectionRows()).toBe(1);

    // Two days later the same row has crossed the horizon.
    vi.setSystemTime(new Date('2026-01-03T00:00:00.000Z'));
    const report = hygiene.clean();

    expect(injectionRows()).toBe(0);
    expect(report.cleanedKinds[INJECTION]).toBe(1);
  });

  it('counts memory and injection pruning in the same report', () => {
    const pastMs = String(Date.now() - 100 * DAY_MS);
    db.prepare(
      `INSERT INTO memories (id, scope, scope_key, kind, content, created_at, updated_at)
       VALUES ('m1', 'user', 'u1', 'fact', 'test', ?, ?)`,
    ).run(pastMs, pastMs);
    // Keep the expired share of the temp kinds under the 80% refusal threshold.
    for (let index = 0; index < 4; index++) {
      const freshMs = String(Date.now() - 5 * DAY_MS);
      db.prepare(
        `INSERT INTO memories (id, scope, scope_key, kind, content, created_at, updated_at)
         VALUES (?, 'user', 'u1', 'fact', 'test', ?, ?)`,
      ).run(`fresh${index}`, freshMs, freshMs);
    }
    insertEvent(INJECTION, Date.now() - 60 * DAY_MS);

    const report = hygiene.clean();

    expect(report.cleanedKinds).toEqual({ fact: 1, [INJECTION]: 1 });
    expect(report.cleanedCount).toBe(2);
  });

  it('does not fail the pass when the observation table does not exist', () => {
    const bare = new Database(':memory:');
    applySchema(bare);
    bare.prepare('DROP TABLE memory_observation_events').run();
    const bareRepo = new MemoryRepository(bare);
    const pastMs = String(Date.now() - 100 * DAY_MS);
    bare
      .prepare(
        `INSERT INTO memories (id, scope, scope_key, kind, content, created_at, updated_at)
         VALUES ('m1', 'user', 'u1', 'fact', 'test', ?, ?)`,
      )
      .run(pastMs, pastMs);
    // Keep the expired share of the temp kinds under the 80% refusal threshold.
    for (let index = 0; index < 4; index++) {
      const freshMs = String(Date.now() - 5 * DAY_MS);
      bare
        .prepare(
          `INSERT INTO memories (id, scope, scope_key, kind, content, created_at, updated_at)
           VALUES (?, 'user', 'u1', 'fact', 'test', ?, ?)`,
        )
        .run(`fresh${index}`, freshMs, freshMs);
    }
    const bareHygiene = new MemoryHygiene(bareRepo, bare, {
      tempRetentionDays: 90,
      checkIntervalMs: 0,
    });

    const report = bareHygiene.clean();

    // The rest of the pass still ran — only the retention step is skipped.
    expect(report.error).toBeUndefined();
    expect(report.cleanedKinds).toEqual({ fact: 1 });
    expect(bareRepo.findById('m1')).toBeUndefined();
    bare.close();
  });
});
