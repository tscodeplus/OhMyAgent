/**
 * Migration v29: keep only the newest session summary per session.
 *
 * `summarize_interval` writes a new `scope='session'`, `kind='summary'` memory of
 * the session every N messages, and nothing retired the previous one. On the
 * device that left two `active` summaries for `cron:W85kvIrS` (2319 and 1385
 * chars, identical opening line) and `retrieveGrouped` admits both — so the
 * per-turn `<memory_context>` spent two of its five slots quoting the same cron
 * output twice, at 800 chars each.
 *
 * The write path now supersedes the previous summary as it writes the new one
 * (`MemoryWriter.write`), which only helps a session that gets summarised again.
 * This repairs the rows already stored: for every `(scope='session', scope_key)`
 * with more than one active summary, all but the newest are closed —
 * `status='superseded'` plus a `supersedes_id` chain — never deleted, so the
 * history of what the conversation said is still readable.
 *
 * Idempotent: after the first run each session has exactly one active summary, so
 * the second run finds nothing to close.
 *
 * Runs AFTER `applySchema` and replays on every open, like v20–v28.
 */

import type Database from 'better-sqlite3';

export interface MigrateV29Result {
  /** Sessions that had more than one active summary (0 on a clean database). */
  sessions: number;
  /** Summary rows this call closed (0 on a re-run). */
  superseded: number;
}

interface SummaryRow {
  id: string;
  scope_key: string | null;
  created_at: string;
  rowid: number;
}

export function migrateV29(db: Database.Database): MigrateV29Result {
  const result: MigrateV29Result = { sessions: 0, superseded: 0 };
  const hasTable = db
    .prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ?')
    .get('table', 'memories') as { name: string } | undefined;
  if (!hasTable) return result;

  const rows = db
    .prepare(
      `SELECT rowid, id, scope_key, created_at
         FROM memories
        WHERE scope = 'session' AND kind = 'summary' AND status = 'active'
        ORDER BY scope_key ASC, created_at ASC, rowid ASC`,
    )
    .all() as SummaryRow[];

  // Group in JS rather than SQL: `created_at` is a TEXT column that holds either
  // an epoch-ms digit string or a SQLite datetime, so an ORDER BY text sort can
  // interleave the two forms. `rowid` is the only strictly monotonic tiebreak.
  const bySession = new Map<string, SummaryRow[]>();
  for (const row of rows) {
    const key = row.scope_key ?? '';
    const bucket = bySession.get(key);
    if (bucket) bucket.push(row);
    else bySession.set(key, [row]);
  }

  const close = db.prepare(
    `UPDATE memories
        SET status = 'superseded',
            supersedes_id = NULL,
            invalidated_at = cast(strftime('%s','now') as integer) * 1000,
            updated_at = cast(strftime('%s','now') as integer) * 1000
      WHERE id = ? AND status = 'active'`,
  );
  // `supersedes_id` lives on the NEW row ("X supersedes Y"), the same direction
  // `MemoryRepository.supersede` writes it, so the chain is readable from the
  // survivor without an index on a column that is NULL for most rows.
  const point = db.prepare('UPDATE memories SET supersedes_id = ? WHERE id = ?');
  // `active` is the read filter on every retrieval lane, but the FTS index is
  // written per row, not per status — a superseded summary must not stay
  // searchable under its own text.
  const dropFts = db.prepare('DELETE FROM memories_fts_jieba WHERE memory_id = ?');

  for (const bucket of bySession.values()) {
    if (bucket.length < 2) continue;
    result.sessions++;
    // Everything except the newest (last by rowid) is closed, oldest first, so
    // the chain reads forward in the order the summaries were written.
    const newest = bucket[bucket.length - 1];
    // Oldest first, so the surviving row ends up pointing at its immediate
    // predecessor — the newest of the closed ones.
    let lastClosed: string | undefined;
    for (const prior of bucket.slice(0, -1)) {
      if (close.run(prior.id).changes > 0) {
        dropFts.run(prior.id);
        lastClosed = prior.id;
        result.superseded++;
      }
    }
    if (lastClosed) point.run(lastClosed, newest.id);
  }
  return result;
}
