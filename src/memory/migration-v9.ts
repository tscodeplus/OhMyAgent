/**
 * Migration v9: session channel / external chat id / title columns.
 *
 * Sessions only carried `chat_id` and a JSON `metadata` blob, so the WebUI
 * could not group IM sessions without parsing metadata per row, and IM
 * transcripts (project_id IS NULL) had no first-class title. This adds:
 *   - channel:          'webui' | 'feishu' | 'telegram' | 'wechat' | 'qq' | …
 *   - external_chat_id: the transport handle, for rows where it differs from
 *                       the session id (WebUI ids are uuids)
 *   - title:            plain column so listing does not parse JSON per row
 *
 * Runs BEFORE applySchema (see openDatabase): `CREATE TABLE IF NOT EXISTS`
 * cannot add columns to an existing table, so idx_sessions_channel_updated
 * would throw on an upgraded database and abort startup — the same ordering
 * constraint that applies to migration v2/v3/v4.
 *
 * The backfill is idempotent: it only fills NULL columns, so re-running on
 * every startup is a no-op after the first pass.
 */

import type Database from 'better-sqlite3';
import { inferChannel } from './session-channel.js';

export interface V9MigrationResult {
  added: string[];
  skipped: string[];
  /**
   * Number of column values written by the backfill (a row that gains both a
   * title and a channel counts twice). 0 on a database that has already been
   * backfilled.
   */
  backfilled: number;
}

/** Columns this migration owns, in the order the schema declares them. */
const COLUMNS = ['channel', 'external_chat_id', 'title'] as const;

const INDEX_CHANNEL_UPDATED =
  'CREATE INDEX IF NOT EXISTS idx_sessions_channel_updated ON sessions(channel, updated_at DESC)';

export function migrateV9(db: Database.Database): V9MigrationResult {
  const added: string[] = [];
  const skipped: string[] = [];
  let backfilled = 0;

  const cols = db.pragma('table_info(sessions)') as Array<{ name: string }>;
  const colNames = new Set(cols.map((c) => c.name));

  // Fresh database: DDL_SESSIONS already declares every column and applySchema
  // (which runs right after) creates the index. Nothing to alter or backfill.
  if (colNames.size === 0) {
    return { added, skipped, backfilled };
  }

  for (const column of COLUMNS) {
    if (colNames.has(column)) {
      skipped.push(column);
      continue;
    }
    db.exec(`ALTER TABLE sessions ADD COLUMN ${column} TEXT`);
    added.push(column);
  }

  db.exec(INDEX_CHANNEL_UPDATED);

  const backfill = db.transaction(() => {
    let written = 0;
    written += backfillTitles(db);
    written += backfillChannels(db);
    written += backfillExternalChatIds(db);
    return written;
  });
  backfilled = backfill();

  return { added, skipped, backfilled };
}

/** title <- metadata JSON `.title` (unparseable / non-string values skipped). */
function backfillTitles(db: Database.Database): number {
  const rows = db
    .prepare('SELECT id, metadata FROM sessions WHERE title IS NULL AND metadata IS NOT NULL')
    .all() as Array<{ id: string; metadata: string }>;
  const update = db.prepare('UPDATE sessions SET title = ? WHERE id = ? AND title IS NULL');

  let written = 0;
  for (const row of rows) {
    let title: unknown;
    try {
      title = (JSON.parse(String(row.metadata)) as { title?: unknown } | null)?.title;
    } catch {
      continue; // malformed metadata — leave the column NULL
    }
    if (typeof title !== 'string' || title.length === 0) continue;
    written += update.run(title, row.id).changes;
  }
  return written;
}

/** channel <- inferChannel(id, chat_id). */
function backfillChannels(db: Database.Database): number {
  const rows = db.prepare('SELECT id, chat_id FROM sessions WHERE channel IS NULL').all() as Array<{
    id: string;
    chat_id: string | null;
  }>;
  const update = db.prepare('UPDATE sessions SET channel = ? WHERE id = ? AND channel IS NULL');

  let written = 0;
  for (const row of rows) {
    written += update.run(inferChannel(row.id, row.chat_id), row.id).changes;
  }
  return written;
}

/**
 * external_chat_id <- chat_id, but only for transports whose chat handle is a
 * real external conversation id. For WebUI the chat_id is the synthetic
 * `webui:<projectId>` marker and 'unknown' rows have nothing trustworthy to
 * expose.
 */
function backfillExternalChatIds(db: Database.Database): number {
  const result = db
    .prepare(
      `UPDATE sessions SET external_chat_id = chat_id
       WHERE external_chat_id IS NULL
         AND chat_id IS NOT NULL
         AND channel NOT IN ('webui', 'unknown')`,
    )
    .run();
  return result.changes;
}
