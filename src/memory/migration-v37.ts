/**
 * Migration v37: retire `archived(rejected)` and `archived(expired)` for notes.
 *
 * Two policies changed together, and each leaves rows that no longer have a meaning:
 *
 *   1. **A rejected draft is erased, not archived.** Rejecting used to set
 *      `status='archived', status_reason='rejected'` and keep the body, which meant the
 *      one row the reviewer had explicitly refused sat on disk and was one `恢复` click
 *      from being published without review (restore always targeted `active`). The
 *      `reject` event stays in `note_events`: it is what `reviewTally()` counts, so the
 *      approval rate keeps its denominator while the content — body, evidence, both
 *      relation sides, the FTS row — goes.
 *   2. **Drafts do not expire.** `notes.draft.ttl_days` is gone, so a draft leaves the
 *      queue only through a verdict. Rows that the old TTL already hid from the queue
 *      were never reviewed by anyone: they go back to `draft` rather than being erased
 *      with the rejections, because nobody decided anything about them. Their FTS row is
 *      dropped instead of rewritten — a draft is not in the library index, and
 *      approval re-indexes the row through `setStatus`.
 *
 * Replay-safe by construction: after the first run there is nothing left with either
 * reason, so a second boot finds empty sets and does nothing. No `kind`-style column
 * guard is needed because the selectors are status/reason matches, not schema probes.
 */

import type Database from 'better-sqlite3';
import { createLogger } from '../app/logger.js';

const logger = createLogger();

export interface MigrateV37Result {
  /** Rejected drafts whose content was erased (their `reject` events kept). */
  erasedRejected: number;
  /** Expired drafts returned to the review queue. */
  requeuedExpired: number;
}

export function migrateV37(db: Database.Database): MigrateV37Result {
  const count = (reason: string): number =>
    (
      db
        .prepare(
          `SELECT COUNT(*) AS cnt FROM notes WHERE status = 'archived' AND status_reason = ?`,
        )
        .get(reason) as { cnt: number }
    ).cnt;

  const rejected = count('rejected');
  const expired = count('expired');
  if (rejected === 0 && expired === 0) return { erasedRejected: 0, requeuedExpired: 0 };

  const now = Date.now();

  db.transaction(() => {
    if (rejected > 0) {
      // Sub-selects rather than a captured id list: the four deletes have to name the
      // same set, and the last one removes the rows the other three looked up.
      const set = `SELECT id FROM notes WHERE status = 'archived' AND status_reason = 'rejected'`;
      db.prepare(`DELETE FROM note_sources WHERE note_id IN (${set})`).run();
      db.prepare(
        `DELETE FROM note_relations WHERE note_id IN (${set}) OR related_id IN (${set})`,
      ).run();
      db.prepare(`DELETE FROM notes_fts_jieba WHERE note_id IN (${set})`).run();
      // `note_events` is deliberately NOT touched: the verdict is the measurement.
      db.prepare(
        `DELETE FROM notes WHERE status = 'archived' AND status_reason = 'rejected'`,
      ).run();
    }

    if (expired > 0) {
      const where = `status = 'archived' AND status_reason = 'expired'`;
      // The journal gets the verb that actually happened, before the row moves: an
      // `archive` with no matching `restore` would read as a note that disappeared.
      db.prepare(
        `INSERT INTO note_events (id, note_id, action, actor, detail, created_at)
           SELECT 'nev_' || lower(hex(randomblob(8))), id, 'restore', 'system', 'expired', ?
             FROM notes WHERE ${where}`,
      ).run(now);
      db.prepare(
        `DELETE FROM notes_fts_jieba WHERE note_id IN (SELECT id FROM notes WHERE ${where})`,
      ).run();
      db.prepare(
        `UPDATE notes SET status = 'draft', status_reason = NULL, updated_at = ? WHERE ${where}`,
      ).run(now);
    }
  })();

  logger.info(
    { erasedRejected: rejected, requeuedExpired: expired },
    '[V37] notes retention retired',
  );
  return { erasedRejected: rejected, requeuedExpired: expired };
}
