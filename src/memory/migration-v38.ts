/**
 * Migration v38: `sessions.is_placeholder` — the row a delete leaves behind is
 * bookkeeping, not a conversation.
 *
 * Deleting an IM transcript cannot remove the chat's slot: `ConversationSessions.forget`
 * immediately opens the slot's next generation, because (a) `messages.session_id`
 * references `sessions(id)`, so a transcript has to exist before a message can be
 * written, and (b) the next incoming message must not resolve back to the older
 * transcript the operator just deleted. The visible consequence was three empty
 * rows reading 新会话 / 0 条消息 in 收件箱 and 归档 after deleting everything —
 * rows the operator never created and cannot use.
 *
 * The flag marks those rows so the two lists (`listInbox`, `listArchived` and the
 * counts next to them) skip them. It is not a tombstone: the first turn written to
 * the transcript clears it (AgentService.ensureSession), so the placeholder turns
 * into an ordinary conversation the moment it has something to say.
 *
 * Backfill: rows written before this release carry the default 0. An untitled IM
 * session without messages is indistinguishable from a delete placeholder — a
 * `/new` transcript looks exactly the same — so flagging them is the one-time
 * cleanup, and it is safe because a flagged row that later receives a message is
 * still listed (the queries hide a placeholder only while it is empty).
 *
 * Runs BEFORE applySchema, same ordering constraint as v4/v9/v11/v12: schema.ts
 * declares the column and `CREATE TABLE IF NOT EXISTS` cannot add it to an
 * existing table. Idempotent: the column add is skipped when it already exists,
 * and the backfill is a predicate over rows, not a count.
 */

import type Database from 'better-sqlite3';

export interface V38MigrationResult {
  /** Columns this run added (`[]` when the schema already had them). */
  added: string[];
  /** Existing rows flagged as placeholders. */
  flagged: number;
}

const COLUMN = 'is_placeholder';

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { present: number } | undefined;
  return row !== undefined;
}

export function migrateV38(db: Database.Database): V38MigrationResult {
  const added: string[] = [];
  const cols = db.pragma('table_info(sessions)') as Array<{ name: string }>;
  const colNames = new Set(cols.map((c) => c.name));

  // Fresh database: DDL_SESSIONS already declares the column and applySchema
  // creates the table right after, so there is nothing to alter or backfill here.
  if (colNames.size === 0) return { added, flagged: 0 };

  if (colNames.has(COLUMN)) {
    // Replay after the column exists: the backfill below still runs, because a
    // row can only become a placeholder if it was written by an older release.
  } else {
    db.exec(`ALTER TABLE sessions ADD COLUMN ${COLUMN} INTEGER NOT NULL DEFAULT 0`);
    added.push(COLUMN);
  }

  if (!tableExists(db, 'messages')) return { added, flagged: 0 };

  const flagged = db
    .prepare(
      `UPDATE sessions
          SET ${COLUMN} = 1
        WHERE project_id IS NULL
          AND title IS NULL
          AND ${COLUMN} = 0
          AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.session_id = sessions.id)`,
    )
    .run().changes;

  return { added, flagged };
}
