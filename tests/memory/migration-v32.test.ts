/**
 * Migration v32: the retired knowledge-page and entity-graph tables are dropped.
 *
 * The property under test is the selector: these tables go, and nothing the
 * surviving layers read does. A migration that dropped `memories` or the message
 * FTS index would still "pass" a test that only checked the graph tables were
 * gone, so both halves are asserted — what was dropped, and what was kept with
 * its rows intact.
 *
 * It is also replayed on every open, so a second run has to be a no-op.
 */

import { describe, it, expect } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/memory/db';
import { migrateV32 } from '../../src/memory/migration-v32';

function createLegacyTables(db: Database.Database): void {
  // The shapes v10/v14/v18/v23/v27 used to declare. Only the names matter to
  // the migration, so the columns are whatever was cheapest to write.
  const ddl = [
    `CREATE TABLE entities (id TEXT PRIMARY KEY, canonical_name TEXT, entity_type TEXT)`,
    `CREATE TABLE entity_aliases (entity_id TEXT, alias TEXT)`,
    `CREATE TABLE entity_edges (id TEXT PRIMARY KEY, relation_type TEXT)`,
    `CREATE TABLE entity_extraction_log (memory_id TEXT PRIMARY KEY, outcome TEXT)`,
    `CREATE TABLE entity_link_refusals (memory_id TEXT PRIMARY KEY)`,
    `CREATE TABLE entity_graph_metrics (entity_id TEXT PRIMARY KEY, degree INTEGER)`,
    `CREATE TABLE entity_components (entity_id TEXT PRIMARY KEY, component_id TEXT)`,
    `CREATE TABLE memory_links (id TEXT PRIMARY KEY, source_memory_id TEXT, target_entity TEXT)`,
    `CREATE TABLE knowledge_pages (id TEXT PRIMARY KEY, slug TEXT)`,
    `CREATE TABLE knowledge_sources (page_id TEXT, source_id TEXT)`,
    `CREATE TABLE knowledge_links (from_page_id TEXT, to_page_id TEXT)`,
    `CREATE TABLE knowledge_log (id TEXT PRIMARY KEY, action TEXT)`,
  ];
  for (const statement of ddl) db.exec(statement);
  db.exec(`INSERT INTO knowledge_pages (id, slug) VALUES ('p1', 'ubuntu')`);
  db.exec(`INSERT INTO memory_links (id, source_memory_id, target_entity) VALUES ('l1','m1','X')`);
}

const LEGACY = [
  'entities',
  'entity_aliases',
  'entity_edges',
  'entity_extraction_log',
  'entity_link_refusals',
  'entity_graph_metrics',
  'entity_components',
  'memory_links',
  'knowledge_pages',
  'knowledge_sources',
  'knowledge_links',
  'knowledge_log',
];

const KEPT = ['memories', 'messages', 'sessions', 'notes', 'note_sources', 'memory_sources'];

function tableNames(db: Database.Database): Set<string> {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
    .all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

describe('migration v32', () => {
  it('drops every retired table and keeps the ones still read', () => {
    const db = openDatabase(':memory:');
    try {
      createLegacyTables(db);

      const result = migrateV32(db);

      expect(result.dropped.sort()).toEqual([...LEGACY].sort());
      const names = tableNames(db);
      for (const table of LEGACY) expect(names.has(table)).toBe(false);
      for (const table of KEPT) expect(names.has(table)).toBe(true);
    } finally {
      db.close();
    }
  });

  it('keeps the rows of the tables it keeps', () => {
    const db = openDatabase(':memory:');
    try {
      createLegacyTables(db);
      db.prepare(
        `INSERT INTO memories (id, scope, scope_key, kind, content) VALUES ('m1','user','u1','fact','hello')`,
      ).run();
      db.prepare(
        `INSERT INTO notes
           (id, kind, title, normalized_title, summary, body, status, origin, scope, scope_key,
            created_at, updated_at)
         VALUES ('n1','other','A note','a note','summary','body','active','user','user','u1',
                1, 1)`,
      ).run();

      migrateV32(db);

      expect((db.prepare('SELECT COUNT(*) n FROM memories').get() as { n: number }).n).toBe(1);
      expect((db.prepare('SELECT COUNT(*) n FROM notes').get() as { n: number }).n).toBe(1);
    } finally {
      db.close();
    }
  });

  it('is idempotent: a second run drops nothing', () => {
    const db = openDatabase(':memory:');
    try {
      createLegacyTables(db);
      expect(migrateV32(db).dropped.length).toBe(LEGACY.length);
      expect(migrateV32(db).dropped).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('is a no-op on a database that never had the layers', () => {
    const db = openDatabase(':memory:');
    try {
      expect(migrateV32(db).dropped).toEqual([]);
    } finally {
      db.close();
    }
  });
});
