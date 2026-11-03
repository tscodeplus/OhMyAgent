/**
 * Migration v37: the two archived notes reasons that are no longer states.
 *
 * The property under test is the split between the two sele, because they are
 * deliberately *not* the same decision:
 *
 *   - `rejected` — the user said no. The content goes (body, evidence, both relation
 *     sides, the FTS row) and the `reject` event stays, because the approval rate is a
 *     measurement of the reviewer's verdicts rather than of how many rows exist.
 *   - `expired` — nobody said anything; the old TTL hid the draft. It goes back to the
 *     queue, because erasing it would be a deletion no human asked for.
 *
 * A third case pins the selector: a note the user archived themselves (`user`) is not
 * touched. And the migration runs on every boot, so a second run has to change nothing.
 */

import { describe, it, expect } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/memory/db';
import { migrateV37 } from '../../src/memory/migration-v37';

function insertNote(
  db: Database.Database,
  id: string,
  status: 'draft' | 'active' | 'archived',
  statusReason: string | null,
): void {
  db.prepare(
    `INSERT INTO notes
       (id, title, normalized_title, summary, body, tags, status, status_reason,
        origin, scope, scope_key, created_at, updated_at)
     VALUES (?, ?, ?, '', ?, '[]', ?, ?, 'agent', 'user', '', ?, ?)`,
  ).run(id, `title ${id}`, `title ${id}`, `body ${id}`, status, statusReason, 1, 1);
  // The FTS row carries `status`, so a reader filtering on it would otherwise see a
  // stale value after the row moves.
  db.prepare(
    `INSERT INTO notes_fts_jieba (title, summary, body, tags, note_id, status, scope, scope_key)
     VALUES (?, '', ?, '[]', ?, ?, 'user', '')`,
  ).run(`title ${id}`, `body ${id}`, id, status);
}

describe('migration v37', () => {
  it('erases rejected drafts, requeues expired ones, and leaves user archives alone', () => {
    const db = openDatabase(':memory:');
    insertNote(db, 'rejected', 'archived', 'rejected');
    insertNote(db, 'expired', 'archived', 'expired');
    insertNote(db, 'mine', 'archived', 'user');

    // A rejected draft's derived rows: one evidence row, one relation, its verdict.
    db.prepare(
      `INSERT INTO note_sources (note_id, kind, source_id, created_at)
       VALUES ('rejected', 'message', 'm1', 1)`,
    ).run();
    db.prepare(
      `INSERT INTO note_relations (note_id, related_id, score, basis, created_at)
       VALUES ('rejected', 'mine', 0.5, 'tag', 1)`,
    ).run();
    db.prepare(
      `INSERT INTO note_events (id, note_id, action, actor, detail, created_at)
       VALUES ('e1', 'rejected', 'reject', 'user', 'duplicate', 1)`,
    ).run();

    const result = migrateV37(db);
    expect(result).toEqual({ erasedRejected: 1, requeuedExpired: 1 });

    // The rejected draft is gone, derived rows with it, the verdict kept.
    expect(db.prepare(`SELECT COUNT(*) AS n FROM notes WHERE id = 'rejected'`).get()).toEqual({
      n: 0,
    });
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM note_sources WHERE note_id = 'rejected'`).get(),
    ).toEqual({ n: 0 });
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM note_relations WHERE note_id = 'rejected'`).get(),
    ).toEqual({ n: 0 });
    expect(db.prepare(`SELECT detail FROM note_events WHERE note_id = 'rejected'`).get()).toEqual({
      detail: 'duplicate',
    });

    // The expired draft is back in the queue, with the journal saying how it got there.
    const expired = db
      .prepare(`SELECT status, status_reason FROM notes WHERE id = 'expired'`)
      .get() as { status: string; status_reason: string | null };
    expect(expired).toEqual({ status: 'draft', status_reason: null });
    expect(
      db.prepare(`SELECT action, actor FROM note_events WHERE note_id = 'expired'`).all(),
    ).toEqual([{ action: 'restore', actor: 'system' }]);
    // No FTS row for a draft: the index is the library's, and approval re-indexes.
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM notes_fts_jieba WHERE note_id = 'expired'`).get(),
    ).toEqual({ n: 0 });

    // The user's own archive is untouched, index row included.
    expect(db.prepare(`SELECT status, status_reason FROM notes WHERE id = 'mine'`).get()).toEqual({
      status: 'archived',
      status_reason: 'user',
    });
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM notes_fts_jieba WHERE note_id = 'mine'`).get(),
    ).toEqual({ n: 1 });

    db.close();
  });

  it('is a no-op when replayed', () => {
    const db = openDatabase(':memory:');
    insertNote(db, 'mine', 'archived', 'user');

    expect(migrateV37(db)).toEqual({ erasedRejected: 0, requeuedExpired: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM notes`).get()).toEqual({ n: 1 });

    db.close();
  });
});
