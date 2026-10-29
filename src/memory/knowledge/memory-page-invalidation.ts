/**
 * Write-side invalidation of the knowledge pages that cite a memory (plan §8 S1,
 * revision A3).
 *
 * A page that cites a memory is a **copy** of that memory's text, and
 * `knowledge_sources` carries no foreign key to `memories` (migration-v14), so
 * nothing used to tell a page that its source had been corrected. The page kept
 * `status = 'active'` and therefore kept winning every read: `unified-search`
 * drops the memory a page cites, and the per-turn injection lane
 * (`context-transform` → `retrieveGrouped`) never consults `unified-search` at
 * all. That is why the invalidation lives here, on the write side, instead of
 * only in a read-side comparison — a page flipped out of `active` disappears
 * from search, injection, link resolution and export in the same write.
 *
 * The mechanism is `status`, not a new column: `active` is the hard read filter
 * of every reader (`KNOWLEDGE_PAGE_STATUSES`), so `pending` takes the page out
 * of every lane at once and routes it back through the existing human-approval
 * queue — the same state a shadow-mode curation write produces. A human (or a
 * re-curation against the corrected memory) re-derives the page; a machine that
 * guessed a replacement body would be inventing the very thing the citation
 * gate exists to prevent. The `knowledge_log` row records the cause, so
 * "why did this page leave the index" is answerable from the data.
 *
 * Cost and failure shape: one indexed `SELECT` over
 * `idx_knowledge_sources_lookup(source_kind, source_id)` when there is nothing
 * to invalidate — the common case on every memory write — and no write at all.
 * Null answers are not cached, so a write on a database that has no knowledge
 * layer costs one `sqlite_master` probe instead of an exception. Any failure is
 * swallowed (returned as 0) after an observation event and a log line: the
 * memory write is what the caller asked for, and a stale page is not a reason to
 * lose it.
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import { errorForObservation, memoryObservability } from '../observability.js';

export type MemoryPageInvalidationCause = 'write' | 'update';

/** Connections already known to carry the knowledge tables (see the note above). */
const readyDatabases = new WeakSet<Database.Database>();

const KNOWLEDGE_TABLES = ['knowledge_pages', 'knowledge_sources', 'knowledge_log'] as const;

function knowledgeTablesReady(db: Database.Database): boolean {
  if (readyDatabases.has(db)) return true;
  const placeholders = KNOWLEDGE_TABLES.map(() => '?').join(', ');
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})`,
    )
    .get(...KNOWLEDGE_TABLES) as { n: number };
  const ready = row.n === KNOWLEDGE_TABLES.length;
  // Only the positive answer is cached: `openDatabase()` runs migration-v14
  // before anything can write, so absence means "not the production schema"
  // (a bare test database), and a later migration on the same connection must
  // still be able to turn the check on.
  if (ready) readyDatabases.add(db);
  return ready;
}

/**
 * Re-queue every active page that cites `memoryId`, and return how many were
 * re-queued.
 *
 * `cause` only reaches the log reason: both causes mean the same thing to a
 * reader, but "which write invalidated this page" is the first question asked
 * when a page unexpectedly leaves the approval queue.
 */
export async function invalidatePagesCitingMemory(
  db: Database.Database | undefined,
  memoryId: string,
  cause: MemoryPageInvalidationCause,
  logger?: Logger,
): Promise<number> {
  if (!db || !db.open) return 0;

  try {
    if (!knowledgeTablesReady(db)) return 0;

    const cited = db
      .prepare(
        `SELECT p.id AS id, p.version AS version
           FROM knowledge_sources s
           JOIN knowledge_pages p ON p.id = s.page_id
          WHERE s.source_kind = 'memory' AND s.source_id = ? AND p.status = 'active'`,
      )
      .all(memoryId) as Array<{ id: string; version: number }>;
    // The common case: a memory no page cites costs the SELECT above and stops.
    if (cited.length === 0) return 0;

    const now = Date.now();
    const reason = `memory ${memoryId} ${cause === 'write' ? 'created' : 'updated'}: cited page re-queued for review`;

    // Page row and log row land together, as they do in `KnowledgeRepository`:
    // a page out of the index with no trace of why is a support ticket.
    const apply = db.transaction((): number => {
      const flip = db.prepare(
        `UPDATE knowledge_pages
            SET status = 'pending', version = ?, updated_at = ?, updated_by = 'system'
          WHERE id = ? AND status = 'active'`,
      );
      const log = db.prepare(
        `INSERT INTO knowledge_log (id, page_id, action, actor, version, reason, created_at)
         VALUES (?, ?, 'pending', 'system', ?, ?, ?)`,
      );
      let flipped = 0;
      for (const page of cited) {
        const version = page.version + 1;
        const changed = flip.run(version, now, page.id).changes;
        // A page another writer already moved out of `active` is not touched
        // again — that is what keeps a repeated memory write idempotent instead
        // of stacking log rows.
        if (changed === 0) continue;
        log.run(randomUUID(), page.id, version, reason, now);
        flipped++;
      }
      return flipped;
    });

    return apply();
  } catch (err) {
    memoryObservability.record('memory.write.degraded', {
      stage: 'knowledge_page_invalidation',
      memoryId,
      cause,
      error: errorForObservation(err),
    });
    logger?.error(
      { err, memoryId, cause },
      'Knowledge page invalidation failed — memory write unaffected',
    );
    return 0;
  }
}
