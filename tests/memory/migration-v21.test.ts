/**
 * Migration v21: the page graph meets the entity graph, and a page link gets a
 * predicate.
 *
 * What this file pins, and why each one is a real failure rather than a
 * formality:
 *
 * 1. The columns are added on an upgraded database, and adding them twice is a
 *    no-op — every migration replays on every open, and `ALTER TABLE ADD COLUMN`
 *    throws on the second pass.
 * 2. The backfills only touch NULL rows, so a page with no matching entity node
 *    is retried on the next open (an entity can be created after the page was
 *    written) while a linked page is left alone.
 * 3. The predicate comes from the target's `page_type`, not from the body — the
 *    same body text yields `ABOUT` or `MENTIONS` depending on what the target
 *    is, which is the whole point of deriving it instead of asking the model.
 * 4. A page whose title folds to no entity stays NULL: page-first is a
 *    legitimate order, and inventing a node from a page would put a subject in
 *    the graph that no producer attested.
 */

import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrateV14 } from '../../src/memory/migration-v14.js';
import { migrateV21 } from '../../src/memory/migration-v21.js';
import { PAGE_LINK_RELATIONS } from '../../src/memory/knowledge/types.js';
import { canonicalizeEntityName } from '../../src/memory/repositories/entity-repository.js';

const open: Database.Database[] = [];

afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

function fresh(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrateV14(db);
  open.push(db);
  return db;
}

function columns(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((row) => row.name),
  );
}

function insertPage(
  db: Database.Database,
  page: { id: string; slug: string; title: string; pageType?: string; status?: string },
): void {
  db.prepare(
    `INSERT INTO knowledge_pages
       (id, page_type, slug, title, content, aliases, tags, confidence, version, status,
        created_at, updated_at, updated_by)
     VALUES (?, ?, ?, ?, '', NULL, NULL, NULL, 1, ?, 1, 1, 'agent')`,
  ).run(page.id, page.pageType ?? 'topic', page.slug, page.title, page.status ?? 'active');
}

function insertLink(db: Database.Database, from: string, to: string): void {
  db.prepare(
    `INSERT INTO knowledge_links (from_page_id, to_page_id, label, created_at)
     VALUES (?, ?, NULL, 1)`,
  ).run(from, to);
}

function insertEntity(db: Database.Database, id: string, name: string, type = 'tool'): void {
  db.prepare(
    `INSERT INTO entities (id, name, canonical_name, entity_type, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, 1)`,
  ).run(id, name, canonicalizeEntityName(name), type);
}

function needEntitiesTable(db: Database.Database): void {
  // v14 does not create `entities` (v10 does); the backfill reads it, so the
  // fixture has to provide the same shape rather than a fake.
  db.exec(
    `CREATE TABLE IF NOT EXISTS entities (
       id TEXT PRIMARY KEY,
       name TEXT NOT NULL,
       canonical_name TEXT NOT NULL,
       entity_type TEXT NOT NULL,
       description TEXT,
       created_at INTEGER,
       updated_at INTEGER,
       UNIQUE(canonical_name, entity_type)
     )`,
  );
}

describe('migration v21', () => {
  it('adds both columns, and the second run adds nothing', () => {
    const db = fresh();
    expect(columns(db, 'knowledge_pages').has('entity_id')).toBe(false);

    const first = migrateV21(db);
    expect(first.added).toEqual(['knowledge_pages.entity_id', 'knowledge_links.relation_type']);
    expect(columns(db, 'knowledge_pages').has('entity_id')).toBe(true);
    expect(columns(db, 'knowledge_links').has('relation_type')).toBe(true);

    const second = migrateV21(db);
    expect(second.added).toEqual([]);
  });

  it('survives an open where v14 has not created the tables yet', () => {
    const db = new Database(':memory:');
    open.push(db);
    // No v14: the very first open of a brand-new database, where the knowledge
    // layer does not exist. Reaching this with an ALTER would throw.
    expect(() => migrateV21(db)).not.toThrow();
  });

  it('types existing links from the target page type', () => {
    const db = fresh();
    insertPage(db, { id: 'p-topic', slug: 'power-query', title: 'Power Query', pageType: 'topic' });
    insertPage(db, { id: 'p-proj', slug: 'oma', title: 'OhMyAgent', pageType: 'project' });
    insertPage(db, { id: 'p-entity', slug: 'pq-lib', title: 'PQ Lib', pageType: 'entity' });
    insertPage(db, { id: 'linker', slug: 'etl', title: 'ETL', pageType: 'topic' });
    insertLink(db, 'linker', 'p-topic');
    insertLink(db, 'linker', 'p-proj');
    insertLink(db, 'linker', 'p-entity');

    migrateV21(db);

    const rows = db
      .prepare(`SELECT to_page_id, relation_type FROM knowledge_links ORDER BY relation_type`)
      .all() as Array<{ to_page_id: string; relation_type: string }>;
    expect(rows).toEqual([
      { to_page_id: 'p-topic', relation_type: 'ABOUT' },
      { to_page_id: 'p-entity', relation_type: 'MENTIONS' },
      { to_page_id: 'p-proj', relation_type: 'PART_OF' },
    ]);
    // The closed set is the source of the mapping, not the SQL.
    expect(Object.values(PAGE_LINK_RELATIONS)).toEqual([
      'MENTIONS',
      'PART_OF',
      'ABOUT',
      'DECIDED_BY',
      'QUOTES',
    ]);
  });

  it('leaves an already-typed link alone on a re-run', () => {
    const db = fresh();
    insertPage(db, { id: 't', slug: 't', title: 'T' });
    insertPage(db, { id: 'l', slug: 'l', title: 'L' });
    insertLink(db, 'l', 't');
    migrateV21(db);
    db.prepare(`UPDATE knowledge_links SET relation_type = 'CUSTOM'`).run();

    const again = migrateV21(db);
    expect(again.linksTyped).toBe(0);
    const row = db.prepare('SELECT relation_type FROM knowledge_links').get() as {
      relation_type: string;
    };
    expect(row.relation_type).toBe('CUSTOM');
  });

  it('links a page to the entity its title folds to, and not to a near miss', () => {
    const db = fresh();
    needEntitiesTable(db);
    insertEntity(db, 'e-pq', 'Power Query');
    insertPage(db, { id: 'p1', slug: 'power-query', title: 'power  query' }); // folds together
    insertPage(db, { id: 'p2', slug: 'power-querys', title: 'Power Querys' }); // a different name

    const result = migrateV21(db);
    expect(result.pagesLinked).toBe(1);

    const rows = db
      .prepare('SELECT id, entity_id FROM knowledge_pages ORDER BY id')
      .all() as Array<{ id: string; entity_id: string | null }>;
    expect(rows).toEqual([
      { id: 'p1', entity_id: 'e-pq' },
      { id: 'p2', entity_id: null },
    ]);
  });

  it('retries an unlinked page on the next open, and does no work once linked', () => {
    const db = fresh();
    needEntitiesTable(db);
    insertPage(db, { id: 'p1', slug: 'power-query', title: 'Power Query' });

    expect(migrateV21(db).pagesLinked).toBe(0);

    // The entity arrives later — the page was written first, which is allowed.
    insertEntity(db, 'e-pq', 'Power Query');
    expect(migrateV21(db).pagesLinked).toBe(1);

    // Nothing left to do: the count guard is what keeps a replay cheap.
    expect(migrateV21(db).pagesLinked).toBe(0);
    const row = db.prepare('SELECT entity_id FROM knowledge_pages').get() as {
      entity_id: string;
    };
    expect(row.entity_id).toBe('e-pq');
  });
});
