/**
 * Migration v20: the page title is searchable, and the page graph can be walked
 * backwards.
 *
 * Two gaps from the 2026-10-29 knowledge review, in one migration because both
 * are v14 schema decisions and neither can be fixed by a column add:
 *
 * 1. **I6 — `knowledge_fts_jieba.title` was `UNINDEXED`** (v14), so BM25 only
 *    ever measured the body: a page titled `Power Query` whose body does not
 *    repeat the words was reachable only through the exact-name leg of
 *    `knowledge_search`. FTS5 has no `ALTER` for a column's `UNINDEXED` flag, and
 *    adding a second title column would leave the v14 one behind (and shift
 *    every `bm25()` weight), so the table is dropped and recreated with `title`
 *    indexed.
 * 2. **I5 — `knowledge_links` had no index on `to_page_id`**, so reading a
 *    page's backlinks was a full table scan while the forward direction was
 *    indexed. `knowledge_links(from_page_id)` needs nothing: the
 *    `PRIMARY KEY (from_page_id, to_page_id)` already creates
 *    `sqlite_autoindex_knowledge_links_1`, which SQLite uses for
 *    `WHERE from_page_id = ?` (checked with `EXPLAIN QUERY PLAN`).
 *
 * ## The recreate is a one-shot, and the DDL is its own marker
 *
 * Migrations replay on every open, so "drop and repopulate" must not run on
 * every open: that would rebuild the index at every boot (the slow-boot cost
 * `pnpm knowledge:reindex` exists to keep off the startup path) and would be a
 * second writer racing the live one. The check is the table's own DDL text:
 * v14's version says `title UNINDEXED`, the recreated one does not, so the work
 * happens exactly once per database — on the first open after the upgrade, and
 * on a fresh database where v14 has just created the old shape.
 *
 * The drop, the create and the repopulate run in one transaction, so a process
 * killed halfway leaves either the old table or the new fully-populated one —
 * never a created-but-empty index. The repopulate writes every page, whatever
 * its `status`: the index is a mirror of `knowledge_pages` (the writers index
 * pending and archived pages too, and `status = 'active'` is applied by the
 * reader's JOIN), while `checkConsistency` compares row counts, so an
 * active-only index would report drift forever and leave a page unsearchable
 * after approval (`setStatus` does not touch the index).
 *
 * ## One row per page, and why `page_id` stays
 *
 * An FTS5 `rowid` is an INTEGER and `knowledge_pages.id` is a UUID string, so
 * "rowid = page_id" is not expressible: `page_id` remains the `UNINDEXED` key
 * column exactly as v14 has it. One row per page comes from the single-shot
 * repopulate above plus the writer's delete-by-`page_id`-then-insert
 * (`knowledge/indexer.ts`), and `checkConsistency().duplicatePageIds` is the
 * detector when something else writes the table.
 *
 * `content` and `title` are stored jieba-segmented (the same `tokenizeForIndex`
 * the writer uses), because the default `unicode61` tokenizer cannot split CJK
 * and a title that tokenizes differently from the query can never match.
 */

import type Database from 'better-sqlite3';
import { tokenizeForIndex } from './fts-tokenizer.js';

export interface MigrateV20Result {
  /** True when `knowledge_fts_jieba` was recreated with an indexed `title`. */
  rebuiltFts: boolean;
  /** Index rows written by the repopulate (0 unless the table was recreated). */
  indexedPages: number;
  /** `knowledge_links` indexes this call created (empty on a re-run). */
  createdIndexes: string[];
}

const FTS_TABLE = 'knowledge_fts_jieba';

/**
 * v14's index with `title` indexed — same columns, same order.
 *
 * The order is load-bearing twice: `bm25()` takes one weight per column by
 * position, and every writer names these columns explicitly. No `tokenize=`
 * override, for the same reason as v14: the default `unicode61` splits the
 * space-joined jieba tokens.
 */
const DDL_KNOWLEDGE_FTS_JIEBA = `
CREATE VIRTUAL TABLE knowledge_fts_jieba USING fts5(
  content,                        -- jieba-segmented body (indexed)
  content_original UNINDEXED,     -- raw markdown (for snippets)
  page_id UNINDEXED,
  title,                          -- jieba-segmented title (indexed since v20)
  page_type UNINDEXED
)`;

/** The reverse lookup a backlink needs; the forward direction is the primary key. */
const INDEX_LINKS_TO = 'idx_knowledge_links_to';
const DDL_LINKS_TO = `CREATE INDEX IF NOT EXISTS ${INDEX_LINKS_TO} ON knowledge_links(to_page_id)`;

interface PageRow {
  id: string;
  page_type: string;
  title: string;
  content: string;
}

function tableSql(db: Database.Database, name: string): string | undefined {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { sql: string | null } | undefined;
  return row?.sql ?? undefined;
}

/**
 * Whether the index still has v14's shape.
 *
 * A missing table counts as "needs (re)creating"; the regex is the migration's
 * version marker, so it must keep matching v14's `title UNINDEXED` and never
 * match the DDL above.
 */
function titleIsUnindexed(sql: string | undefined): boolean {
  return sql === undefined || /\btitle\s+UNINDEXED\b/i.test(sql);
}

/** Rewrite every page's index row. Caller owns the transaction. */
function repopulate(db: Database.Database): number {
  const pages = db
    .prepare('SELECT id, page_type, title, content FROM knowledge_pages')
    .all() as PageRow[];
  const insert = db.prepare(
    `INSERT INTO ${FTS_TABLE} (content, content_original, page_id, title, page_type)
     VALUES (?, ?, ?, ?, ?)`,
  );
  for (const page of pages) {
    insert.run(
      tokenizeForIndex(page.content),
      page.content,
      page.id,
      tokenizeForIndex(page.title),
      page.page_type,
    );
  }
  return pages.length;
}

/**
 * Apply the v20 schema. Safe to call on every startup: the recreate happens only
 * while the index still has v14's `UNINDEXED` title, and the index creation is
 * `IF NOT EXISTS`.
 */
export function migrateV20(db: Database.Database): MigrateV20Result {
  const result: MigrateV20Result = { rebuiltFts: false, indexedPages: 0, createdIndexes: [] };

  // v14 creates both tables before this runs, so the guards only matter for a
  // caller that hands in a database older than v14 (tests, scripts).
  if (tableSql(db, 'knowledge_pages') !== undefined) {
    if (titleIsUnindexed(tableSql(db, FTS_TABLE))) {
      const rebuild = db.transaction((): number => {
        db.exec(`DROP TABLE IF EXISTS ${FTS_TABLE}`);
        db.exec(DDL_KNOWLEDGE_FTS_JIEBA);
        return repopulate(db);
      });
      result.indexedPages = rebuild();
      result.rebuiltFts = true;
    }
  }

  if (tableSql(db, 'knowledge_links') !== undefined) {
    const existed =
      db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get(INDEX_LINKS_TO) !== undefined;
    db.exec(DDL_LINKS_TO);
    if (!existed) {
      result.createdIndexes.push(INDEX_LINKS_TO);
    }
  }

  return result;
}
