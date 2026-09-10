import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrateV7 } from '../../src/memory/migration-v7';
import { applySchema } from '../../src/memory/schema';

/** Legacy table shape (pre-schema DDL) with a datetime('now') DEFAULT. */
const LEGACY_DDL = `
CREATE TABLE memory_observation_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event TEXT NOT NULL,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;

describe('migration-v7: memory_observation_events created_at normalization', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  function insertRow(event: string, createdAt?: string): void {
    if (createdAt) {
      db.prepare('INSERT INTO memory_observation_events (event, created_at) VALUES (?, ?)').run(
        event,
        createdAt,
      );
    } else {
      // Let the table DEFAULT write — the format inconsistency's origin.
      db.prepare('INSERT INTO memory_observation_events (event) VALUES (?)').run(event);
    }
  }

  it('rebuilds a legacy datetime-default table to epoch-ms and converts values', () => {
    db.exec(
      "CREATE TABLE memory_observation_events (id INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT NOT NULL, details TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));",
    );
    insertRow('memory.embedding.failed'); // DEFAULT → 'YYYY-MM-DD HH:MM:SS' UTC string
    insertRow('memory.write.degraded', '2026-09-10 08:00:00'); // legacy UTC string
    insertRow('memory.fts.failed', '1782125938000'); // already epoch-ms

    migrateV7(db);

    // New DEFAULT writes epoch-ms digit strings
    insertRow('memory.merge.failed');
    const rows = db
      .prepare('SELECT event, created_at FROM memory_observation_events ORDER BY id')
      .all() as Array<{ event: string; created_at: string }>;
    for (const row of rows) {
      expect(row.created_at).toMatch(/^\d{10,}$/);
    }
    // The fresh insert via the rebuilt DEFAULT must be "now" (within 60s)
    const last = Number(rows[rows.length - 1].created_at);
    expect(Date.now() - last).toBeLessThan(60_000);
    // Values preserved (count + event pairing intact)
    expect(rows).toHaveLength(4);
    // Index restored
    const idx = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name = 'idx_memory_observation_events_event'",
      )
      .get();
    expect(idx).toBeDefined();
  });

  it('is a no-op on the canonical epoch-ms table', () => {
    applySchema(db);
    const before = db
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'memory_observation_events'")
      .get();
    migrateV7(db);
    const after = db
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'memory_observation_events'")
      .get();
    expect(after).toEqual(before);
  });

  it('does nothing when the table does not exist (fresh DB before schema)', () => {
    expect(() => migrateV7(db)).not.toThrow();
  });
});
