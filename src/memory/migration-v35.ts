/**
 * Migration v35: `session_context_summaries` — the summary a cold session resumes from.
 *
 * Context compression produces a summary of everything the transcript dropped, but
 * that summary lived only in a module-level map (`context-transform.ts`), so it died
 * with the process. A session that went cold — process restart, MCP tool-set change
 * sweeping idle runtimes, the 30-minute idle TTL, LRU eviction — therefore resumed
 * from raw rows only: it had no idea the earlier part of the conversation had ever
 * been summarized, and its context silently shrank to the tail.
 *
 * The table is the missing half of that: one row per (session, agent) holding the
 * latest compression summary plus the instant it was written (`covered_through_ms`).
 * Anything persisted after that instant is by construction *not* covered by the
 * summary, so the reload can ask for exactly the uncovered tail instead of guessing
 * a row count.
 *
 * A new table rather than a column on `sessions`: the summary is per agent as well
 * as per session (the transform namespaces its compression caches by both, and an
 * agent switch mid-chat keeps two transcripts in one session), and an old install
 * upgrading in place has no session row worth rewriting.
 *
 * Replay-safe: `CREATE TABLE IF NOT EXISTS`.
 */

import type Database from 'better-sqlite3';
import { createLogger } from '../app/logger.js';

const logger = createLogger();

export interface MigrateV35Result {
  /** True when this call created the table (false on a re-run). */
  created: boolean;
}

export function migrateV35(db: Database.Database): MigrateV35Result {
  const exists =
    (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table' AND name = 'session_context_summaries'`,
        )
        .get() as { c: number }
    ).c > 0;
  if (exists) return { created: false };

  db.exec(`
    CREATE TABLE IF NOT EXISTS session_context_summaries (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL DEFAULT 'default',
      summary TEXT NOT NULL,
      covered_through_ms INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (cast(strftime('%s','now') as integer) * 1000),
      updated_at TEXT NOT NULL DEFAULT (cast(strftime('%s','now') as integer) * 1000),
      PRIMARY KEY (session_id, agent_id)
    )
  `);
  logger.info('[V35] session_context_summaries created (cold-session resume source)');
  return { created: true };
}
