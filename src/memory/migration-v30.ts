/**
 * Migration v30: undo v29 — incremental session summaries are windows, not
 * generations.
 *
 * v29 assumed a session's summaries superseded each other and closed every one
 * but the newest. The premise was wrong: `MemorySummarizer.summarizeSession`
 * only feeds the messages written **since the last episode** to the model, so
 * each summary describes a disjoint window of the conversation. Closing them
 * removed recall rather than duplicate recall — on the device it set 127 rows of
 * 135 to `superseded`, i.e. most of what the session-scope lane could offer.
 *
 * This migration sets them back to `active`, clears the `supersedes_id` pointer
 * v29 wrote, and re-indexes them (v29 deleted their `memories_fts_jieba` rows).
 * Scope is exactly what v29 could have touched — `scope='session'`,
 * `kind='summary'`, `status='superseded'` — because a session summary is never
 * closed by any other rule (the preference conflict resolver only runs for
 * `kind='preference'`).
 *
 * Idempotent: after one run there is no such row left, so a replay finds
 * nothing. A freshly installed database has none to begin with.
 */

import type Database from 'better-sqlite3';
import { syncJiebaFts } from './fts.js';

export interface MigrateV30Result {
  restored: number;
}

interface SummaryRow {
  id: string;
  scope: string;
  scope_key: string | null;
  kind: string;
  content: string;
  created_at: string;
}

export function migrateV30(db: Database.Database): MigrateV30Result {
  const hasTable = db
    .prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ?')
    .get('table', 'memories') as { name: string } | undefined;
  if (!hasTable) return { restored: 0 };

  const rows = db
    .prepare(
      `SELECT id, scope, scope_key, kind, content, created_at
         FROM memories
        WHERE scope = 'session' AND kind = 'summary' AND status = 'superseded'`,
    )
    .all() as SummaryRow[];
  if (rows.length === 0) return { restored: 0 };

  const restore = db.prepare(
    `UPDATE memories
        SET status = 'active',
            supersedes_id = NULL,
            invalidated_at = NULL,
            updated_at = cast(strftime('%s','now') as integer) * 1000
      WHERE id = ? AND status = 'superseded'`,
  );
  for (const row of rows) restore.run(row.id);

  // The jieba index is not trigger-maintained, so rows v29 dropped have to be
  // re-inserted from the row itself.
  const existing = db.prepare('SELECT 1 FROM memories_fts_jieba WHERE memory_id = ?');
  for (const row of rows) {
    if (existing.get(row.id) !== undefined) continue;
    syncJiebaFts(db, 'insert', {
      id: row.id,
      content: row.content,
      kind: row.kind,
      scope: row.scope,
      scope_key: row.scope_key ?? '',
      created_at: row.created_at,
    });
  }

  return { restored: rows.length };
}
