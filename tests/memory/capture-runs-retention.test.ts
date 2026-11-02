/**
 * `capture_runs` retention, riding on the existing hygiene pass.
 *
 * A run row and its `note_events` are the two halves of one capture attempt, so
 * they share `notes.log_retention_days` — a second knob would only ever be the one
 * nobody edits, and the half that drifted would be the half that still exists.
 *
 * The `status = 'running'` exclusion is the load-bearing one: a capture that is
 * still streaming started before the cutoff by definition, so an age-only delete
 * would remove the row of a capture that is about to finish.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/memory/db.js';
import { MemoryRepository } from '../../src/memory/repositories/memory-repository.js';
import { MemoryHygiene } from '../../src/memory/memory-hygiene.js';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('MemoryHygiene — capture_runs retention', () => {
  let db: Database.Database;
  let repo: MemoryRepository;

  function insertRun(id: string, status: string, createdAt: number): void {
    db.prepare(
      `INSERT INTO capture_runs (id, session_id, scope, mode, message_ids, token_est, status, created_at)
       VALUES (?, 'session-1', 'user', 'turn', '[]', 120, ?, ?)`,
    ).run(id, status, createdAt);
  }

  function insertNoteEvent(id: string, createdAt: number): void {
    db.prepare(
      `INSERT INTO note_events (id, note_id, action, actor, detail, created_at)
       VALUES (?, 'nt_1', 'view', 'user', null, ?)`,
    ).run(id, createdAt);
  }

  function runIds(): string[] {
    return (
      db.prepare('SELECT id FROM capture_runs ORDER BY id').all() as Array<{ id: string }>
    ).map((row) => row.id);
  }

  function eventIds(): string[] {
    return (
      db.prepare('SELECT id FROM note_events ORDER BY id').all() as Array<{ id: string }>
    ).map((row) => row.id);
  }

  function hygieneWith(config: { notesLogRetentionDays?: number } = {}): MemoryHygiene {
    return new MemoryHygiene(repo, db, {
      tempRetentionDays: 90,
      checkIntervalMs: 0,
      ...config,
    });
  }

  beforeEach(() => {
    // The real migration chain: these tables come from v31, and `applySchema`
    // alone would not create them.
    db = openDatabase(':memory:');
    repo = new MemoryRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('prunes finished runs past the horizon and keeps the recent ones', () => {
    const now = Date.now();
    insertRun('ran-old-ok', 'ok', now - 100 * DAY_MS);
    insertRun('ran-old-failed', 'failed', now - 91 * DAY_MS);
    insertRun('ran-recent', 'ok', now - 10 * DAY_MS);

    const report = hygieneWith().clean();

    expect(runIds()).toEqual(['ran-recent']);
    expect(report.cleanedKinds['capture_runs']).toBe(2);
    expect(report.error).toBeUndefined();
  });

  it('never prunes a run that is still running, however old it looks', () => {
    const now = Date.now();
    insertRun('ran-running', 'running', now - 100 * DAY_MS);
    insertRun('ran-finished', 'ok', now - 100 * DAY_MS);

    const report = hygieneWith().clean();

    expect(runIds()).toEqual(['ran-running']);
    expect(report.cleanedKinds['capture_runs']).toBe(1);
  });

  it('takes its threshold from the same knob as note_events', () => {
    const now = Date.now();
    insertRun('ran-eight-days', 'ok', now - 8 * DAY_MS);
    insertRun('ran-six-days', 'ok', now - 6 * DAY_MS);
    insertNoteEvent('nev-eight-days', now - 8 * DAY_MS);
    insertNoteEvent('nev-six-days', now - 6 * DAY_MS);

    const report = hygieneWith({ notesLogRetentionDays: 7 }).clean();

    expect(runIds()).toEqual(['ran-six-days']);
    expect(eventIds()).toEqual(['nev-six-days']);
    expect(report.cleanedKinds['capture_runs']).toBe(1);
    expect(report.cleanedKinds['note_events']).toBe(1);
  });

  it('keeps everything when the horizon is 0 (forever)', () => {
    insertRun('ran-ancient', 'ok', Date.now() - 4000 * DAY_MS);

    const report = hygieneWith({ notesLogRetentionDays: 0 }).clean();

    expect(runIds()).toEqual(['ran-ancient']);
    expect(report.cleanedKinds['capture_runs']).toBeUndefined();
  });

  it('does not fail the pass when the table is absent', () => {
    db.prepare('DROP TABLE capture_runs').run();
    const pastMs = String(Date.now() - 100 * DAY_MS);
    db.prepare(
      `INSERT INTO memories (id, scope, scope_key, kind, content, created_at, updated_at)
       VALUES ('m1', 'user', 'u1', 'fact', 'test', ?, ?)`,
    ).run(pastMs, pastMs);
    // Keep the expired share of the temp kinds under the 80% refusal threshold.
    for (let index = 0; index < 4; index++) {
      const freshMs = String(Date.now() - 5 * DAY_MS);
      db.prepare(
        `INSERT INTO memories (id, scope, scope_key, kind, content, created_at, updated_at)
         VALUES (?, 'user', 'u1', 'fact', 'test', ?, ?)`,
      ).run(`fresh${index}`, freshMs, freshMs);
    }

    const report = hygieneWith().clean();

    // The rest of the pass still ran — only the retention step is skipped.
    expect(report.error).toBeUndefined();
    expect(report.cleanedKinds).toEqual({ fact: 1 });
    expect(repo.findById('m1')).toBeUndefined();
  });
});
