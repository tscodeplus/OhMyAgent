/**
 * Migration v22: a page belongs to a conversation.
 *
 * `knowledge_pages` is one table behind Feishu, Telegram, WeChat, QQ, cron and
 * the WebUI, and it had no notion of "which conversation does this belong to".
 * Two consequences, both visible to a user: a page curated from one group chat
 * answered questions in every other chat, and `findByTitleOrAlias` let a
 * curation in chat B *update* chat A's page on the same subject — two
 * conversations silently merged into one conclusion.
 *
 * The column is `NOT NULL DEFAULT 'global'`, which is both the upgrade story and
 * the safety story: every existing page becomes globally visible (today's
 * behaviour, no ranking change, nothing disappears on upgrade) and only writes
 * that arrive with a channel context start narrowing.
 *
 * The unique index has to change shape — `(page_type, slug)` cannot hold two
 * chats' `decision/deploy-process`, and one of them would otherwise clobber the
 * other. Widening a unique constraint never fails on existing data (the old rows
 * were already unique), but it must be *detected*, not re-created blindly: the
 * index name is unchanged, so `CREATE INDEX IF NOT EXISTS` would silently keep
 * the narrow definition. The rebuild is therefore driven by `PRAGMA
 * index_info` and only runs when the index does not already include `scope`.
 *
 * Runs AFTER `applySchema` like v10/v14/v20/v21: `knowledge_pages` is created by
 * v14, which itself runs after `applySchema`, so there is no column here for
 * `schema.ts` to reference. Every statement is `PRAGMA`/`IF NOT EXISTS`-guarded
 * because each migration replays on every open, and this one must be a no-op
 * (two cheap reads) on a database that already has the column.
 */

import type Database from 'better-sqlite3';

export interface MigrateV22Result {
  /** Columns this call added (empty on a re-run). */
  added: string[];
  /** Indexes this call created or rebuilt (empty on a re-run). */
  created: string[];
}

const SCOPE_INDEX = 'idx_knowledge_pages_slug';
const SCOPE_TIME_INDEX = 'idx_knowledge_pages_scope';

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

function indexColumns(db: Database.Database, index: string): string[] {
  const rows = db.prepare(`PRAGMA index_info(${index})`).all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

export function migrateV22(db: Database.Database): MigrateV22Result {
  const result: MigrateV22Result = { added: [], created: [] };

  // `knowledge_pages` only exists once v14 has run; on a database where the
  // knowledge layer was never created there is nothing to scope.
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_pages'")
    .get() as { name: string } | undefined;
  if (!table) return result;

  if (!hasColumn(db, 'knowledge_pages', 'scope')) {
    // NOT NULL with a constant default: SQLite backfills existing rows with it,
    // so no UPDATE pass is needed and the column cannot be read as NULL.
    db.exec(`ALTER TABLE knowledge_pages ADD COLUMN scope TEXT NOT NULL DEFAULT 'global'`);
    result.added.push('scope');
  }

  if (
    indexColumns(db, SCOPE_INDEX).length > 0 &&
    !indexColumns(db, SCOPE_INDEX).includes('scope')
  ) {
    // The narrow definition is still in place: drop before creating, because the
    // name is reused and `IF NOT EXISTS` would otherwise no-op.
    db.exec(`DROP INDEX IF EXISTS ${SCOPE_INDEX}`);
  }
  if (indexColumns(db, SCOPE_INDEX).length === 0) {
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS ${SCOPE_INDEX}
         ON knowledge_pages (page_type, scope, slug)`,
    );
    result.created.push(SCOPE_INDEX);
  }
  if (indexColumns(db, SCOPE_TIME_INDEX).length === 0) {
    db.exec(
      `CREATE INDEX IF NOT EXISTS ${SCOPE_TIME_INDEX}
         ON knowledge_pages (scope, status, updated_at)`,
    );
    result.created.push(SCOPE_TIME_INDEX);
  }

  return result;
}
