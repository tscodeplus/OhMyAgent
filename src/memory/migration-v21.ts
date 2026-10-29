/**
 * Migration v21: the page graph and the entity graph meet, and a page link gets
 * a predicate.
 *
 * Two gaps, one migration, because both are "the page layer can now be read the
 * way the entity layer already is":
 *
 *   1. `knowledge_pages.entity_id` — a page and the entity it is about are the
 *      same subject stored twice. `entities` is keyed by canonical name and
 *      `knowledge_pages` by `(page_type, slug)`, and nothing joined them, so
 *      "what is written about Power Query" and "what is known about Power Query"
 *      were two separate answers. The column is nullable on purpose: an entity
 *      node exists when a memory asserted something, and a page may name a
 *      subject no memory has attested yet — page-first is a legitimate order,
 *      and inventing an entity from a page would put a node in the graph that
 *      no producer vouched for.
 *
 *   2. `knowledge_links.relation_type` — a wikilink recorded that two pages are
 *      connected, never how. The predicate is derivable without new syntax: the
 *      target's `page_type` is what the author already typed, so `[[topic/x]]`
 *      is `ABOUT`, `[[project/x]]` is `PART_OF`, `[[decision/x]]` is
 *      `DECIDED_BY`, `[[entity/x]]` is `MENTIONS` and `[[snippet/x]]` is
 *      `QUOTES`. Deriving it from the closed set keeps the vocabulary in code
 *      (AGENTS.md: only thresholds are knobs) and keeps the body unchanged — the
 *      link stays a plain `[[wikilink]]` that Obsidian resolves.
 *
 * Both backfills are idempotent and bounded: they only touch NULL rows, and the
 * whole function returns early after one COUNT when there is nothing to do, so a
 * database that has already been migrated pays a single read-only query per
 * open (the same pattern v17 uses).
 *
 * Runs AFTER applySchema like v10/v14/v20 — `knowledge_pages` and
 * `knowledge_links` are created by v14, which itself runs after applySchema, so
 * there is no column here for `schema.ts` to reference. Every statement is
 * `IF NOT EXISTS` / `PRAGMA table_info`-guarded because each migration replays on
 * every open.
 */

import type Database from 'better-sqlite3';
import { canonicalizeEntityName } from './repositories/entity-repository.js';
import { PAGE_LINK_RELATIONS } from './knowledge/types.js';

export interface MigrateV21Result {
  /** Columns this call added (empty on a re-run, and on a fresh database). */
  added: string[];
  /** Indexes this call created (empty on a re-run). */
  created: string[];
  /** Pages whose `entity_id` was filled from a matching entity node. */
  pagesLinked: number;
  /** Link rows that gained a relation derived from the target's `page_type`. */
  linksTyped: number;
}

/**
 * The page-type vocabulary lives in `knowledge/types.ts` (one definition, so the
 * migration and the write path cannot disagree about what a link into a topic
 * means).
 */

const BACKFILL_BATCH = 200;

export function migrateV21(db: Database.Database): MigrateV21Result {
  const result: MigrateV21Result = { added: [], created: [], pagesLinked: 0, linksTyped: 0 };

  const pageColumns = tableColumns(db, 'knowledge_pages');
  // Fresh database: v14 has not created the tables yet on the very first open
  // (it runs before us but its DDL is what we are inspecting). Nothing to add —
  // v14's DDL does not carry these columns, so the next open reaches this line
  // with the tables present.
  if (pageColumns.size === 0) return result;

  if (!pageColumns.has('entity_id')) {
    db.exec('ALTER TABLE knowledge_pages ADD COLUMN entity_id TEXT');
    result.added.push('knowledge_pages.entity_id');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_knowledge_pages_entity ON knowledge_pages(entity_id)');
  result.created.push('idx_knowledge_pages_entity');

  const linkColumns = tableColumns(db, 'knowledge_links');
  if (linkColumns.size > 0 && !linkColumns.has('relation_type')) {
    db.exec('ALTER TABLE knowledge_links ADD COLUMN relation_type TEXT');
    result.added.push('knowledge_links.relation_type');
  }

  result.linksTyped = backfillLinkRelations(db);
  result.pagesLinked = backfillPageEntities(db);
  return result;
}

function hasTable(db: Database.Database, table: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as { name: string } | undefined;
  return row !== undefined;
}

function tableColumns(db: Database.Database, table: string): Set<string> {
  const rows = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

/**
 * Type the links that predate the column, from the target page's `page_type`.
 *
 * One UPDATE with a correlated subquery: the mapping lives in
 * {@link PAGE_LINK_RELATIONS}, so the SQL is generated from it rather than
 * restating the cases. Guarded by a COUNT so a migrated database does no work.
 */
function backfillLinkRelations(db: Database.Database): number {
  const pending = db
    .prepare(
      `SELECT COUNT(*) AS n FROM knowledge_links l
       JOIN knowledge_pages p ON p.id = l.to_page_id
       WHERE l.relation_type IS NULL`,
    )
    .get() as { n: number };
  if (pending.n === 0) return 0;

  const cases = Object.entries(PAGE_LINK_RELATIONS)
    .map(([type, relation]) => `WHEN '${type}' THEN '${relation}'`)
    .join(' ');
  const update = db.prepare(
    `UPDATE knowledge_links
        SET relation_type = (
              SELECT CASE p.page_type ${cases} END
              FROM knowledge_pages p
              WHERE p.id = knowledge_links.to_page_id
            )
      WHERE relation_type IS NULL
        AND EXISTS (
              SELECT 1 FROM knowledge_pages p
              WHERE p.id = knowledge_links.to_page_id
                AND p.page_type IN (${Object.keys(PAGE_LINK_RELATIONS)
                  .map((type) => `'${type}'`)
                  .join(', ')})
            )`,
  );
  const info = update.run();
  return info.changes;
}

/**
 * Point each page at the entity node whose canonical name its title folds to.
 *
 * Titles are the only name a page carries that a producer also writes; an alias
 * table exists for entities and not for pages, so a page whose title differs from
 * every attested name stays unlinked rather than guessed at. Batched and
 * NULL-only, so an unlinked page is retried on a later open — an entity can be
 * created after the page was written.
 */
function backfillPageEntities(db: Database.Database): number {
  // A knowledge-only database (v14 without v10) has no `entities` table. That is
  // not an error: nothing is linked, and the next open retries once the graph
  // layer exists. The migration must not assume a table it reads.
  if (!hasTable(db, 'entities')) return 0;

  const pending = db
    .prepare(`SELECT COUNT(*) AS n FROM knowledge_pages WHERE entity_id IS NULL`)
    .get() as { n: number };
  if (pending.n === 0) return 0;

  const rows = db
    .prepare(
      `SELECT id, title FROM knowledge_pages
        WHERE entity_id IS NULL
        ORDER BY updated_at ASC, id ASC
        LIMIT ?`,
    )
    .all(BACKFILL_BATCH) as Array<{ id: string; title: string }>;

  const lookup = db.prepare(
    `SELECT id FROM entities WHERE canonical_name = ?
      ORDER BY updated_at DESC, id ASC LIMIT 1`,
  );
  const setEntity = db.prepare('UPDATE knowledge_pages SET entity_id = ? WHERE id = ?');

  let linked = 0;
  const run = db.transaction(() => {
    for (const row of rows) {
      const canonical = canonicalizeEntityName(row.title);
      if (!canonical) continue;
      const entity = lookup.get(canonical) as { id: string } | undefined;
      if (!entity) continue;
      setEntity.run(entity.id, row.id);
      linked++;
    }
  });
  run();
  return linked;
}
