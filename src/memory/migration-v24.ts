/**
 * Migration v24: the page title's comparison key becomes a stored column.
 *
 * The name leg of `knowledge_search` matched
 * `lower(trim(title)) LIKE 'x%' ESCAPE '\\'` — a prefix over an expression no
 * index can serve, so every per-turn `.inject` lookup
 * (`titlesForInjection` → `findByTitleOrAlias`) scanned the whole
 * `knowledge_pages` table. `normalized_title` stores `normalizeMergeName(title)`
 * (NFKC, lower-cased, everything that is not a letter or digit stripped — the
 * same fold `merge.ts` compares page names by, full-width `POWER QUERY`
 * spellings included), so the prefix is a plain indexed `LIKE 'x%'`. Aliases
 * keep their own exact-match path.
 *
 * Runs AFTER `applySchema` like v20/v21/v22, because `knowledge_pages` is
 * migration-v14's table — `schema.ts` does not declare it, so there is no column
 * here for `applySchema` to trip over on an upgraded database, and the table
 * does not even exist until v14 has run. Every statement is guarded and the
 * backfill is count-guarded, because this migration replays on every open: a
 * migrated database pays one COUNT (0) per open and nothing else.
 */

import type Database from 'better-sqlite3';
import { normalizeMergeName } from './knowledge/merge.js';

export interface MigrateV24Result {
  /** Column this call added (empty on a re-run). */
  added: string[];
  /** Index this call created (empty on a re-run). */
  created: string[];
  /** Rows whose `normalized_title` this call computed (0 on a re-run). */
  backfilled: number;
}

const TITLE_INDEX = 'idx_knowledge_pages_normalized_title';

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

export function migrateV24(db: Database.Database): MigrateV24Result {
  const result: MigrateV24Result = { added: [], created: [], backfilled: 0 };

  // `knowledge_pages` only exists once v14 has run; a database where the
  // knowledge layer was never created has nothing to normalize.
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_pages'")
    .get() as { name: string } | undefined;
  if (!table) return result;

  if (!hasColumn(db, 'knowledge_pages', 'normalized_title')) {
    db.exec('ALTER TABLE knowledge_pages ADD COLUMN normalized_title TEXT');
    result.added.push('normalized_title');
  }

  // Backfill what the column-add left NULL — a real v14-era table, or a row
  // restored around the migration. Count-guarded so a replay on every open is
  // a read-only probe, and every statement keeps the same NULL predicate, so
  // the fill is safe to interrupt.
  const pending = (
    db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM knowledge_pages
          WHERE normalized_title IS NULL AND title IS NOT NULL AND title <> ''`,
      )
      .get() as { cnt: number }
  ).cnt;
  if (pending > 0) {
    const rows = db
      .prepare(
        `SELECT id, title FROM knowledge_pages
          WHERE normalized_title IS NULL AND title IS NOT NULL AND title <> ''`,
      )
      .all() as Array<{ id: string; title: string }>;
    const update = db.prepare('UPDATE knowledge_pages SET normalized_title = ? WHERE id = ?');
    db.transaction(() => {
      for (const row of rows) update.run(normalizeMergeName(row.title), row.id);
    })();
    result.backfilled = rows.length;
  }

  db.exec(
    `CREATE INDEX IF NOT EXISTS ${TITLE_INDEX}
       ON knowledge_pages (normalized_title)`,
  );
  result.created.push(TITLE_INDEX);

  return result;
}
