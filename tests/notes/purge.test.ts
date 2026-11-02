/**
 * The one physical delete in the notes layer.
 *
 * Every other test in this directory asserts that something survives: archiving
 * keeps the body, a rebuild keeps an archived note's relation rows, a rejection
 * keeps the journal entry. This file asserts the single exception, and it is worth
 * testing for the same reason it exists — a partial erase is indistinguishable from
 * a complete one from the UI, so "the row is gone" is not enough evidence. The body,
 * the citations, both directions of the relation, the journal and the FTS row all
 * have to be gone, or the note is still readable/searchable and the promise is a
 * lie that nobody notices.
 *
 * The refusals matter as much: `active` and `draft` must not be reachable (archive
 * first, deliberately), and a wrong title must delete nothing at all.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { Logger } from 'pino';
import { NotesRepository } from '../../src/notes/repository.js';
import { CapturePipeline } from '../../src/notes/capture.js';
import { createNotesService } from '../../src/notes/service.js';
import type { NotesService } from '../../src/notes/service-contract.js';
import {
  MESSAGE_ASSISTANT,
  RUNTIME_CONFIG,
  SESSION_ID,
  createTestService,
  openSeededDatabase,
} from './fixtures.js';

/** Row counts for everything a purge touches, so "nothing was deleted" is one call. */
function tally(db: Database.Database): Record<string, number> {
  const count = (table: string): number =>
    (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
  return {
    notes: count('notes'),
    sources: count('note_sources'),
    relations: count('note_relations'),
    events: count('note_events'),
    index: count('notes_fts_jieba'),
  };
}

/** Events of one note only — the journal is shared, so a total proves nothing. */
function eventsOf(db: Database.Database, noteId: string): number {
  return (
    db.prepare('SELECT COUNT(*) AS c FROM note_events WHERE note_id = ?').get(noteId) as {
      c: number;
    }
  ).c;
}

describe('notes purge', () => {
  let db: Database.Database;
  let service: NotesService;
  let repository: NotesRepository;

  beforeEach(() => {
    db = openSeededDatabase();
    const created = createTestService(db);
    service = created.service;
    repository = created.repository;
  });

  afterEach(() => {
    db.close();
  });

  /**
   * Two notes from one conversation, so the relation rows exist in both directions:
   * the mirror row points *at* the purged note from a neighbour that stays, which is
   * the case a one-sided delete leaves behind.
   */
  function twoRelatedNotes(): { doomed: string; survivor: string } {
    const first = repository.create({
      title: 'Termux 换源',
      summary: '',
      body: 'sk-secret-should-not-survive',
      status: 'active',
      origin: 'user',
      scope: 'user',
      scopeKey: '',
      sessionId: SESSION_ID,
      sources: [{ kind: 'message', id: MESSAGE_ASSISTANT, excerpt: '换源命令' }],
    });
    const second = repository.create({
      title: 'Termux 后台被杀',
      summary: '',
      body: '另一个主题',
      status: 'active',
      origin: 'user',
      scope: 'user',
      scopeKey: '',
      sessionId: SESSION_ID,
    });
    if (!first.ok || !second.ok) throw new Error('fixture notes were not created');
    return { doomed: first.note.id, survivor: second.note.id };
  }

  it('erases the note, its evidence, both relation sides, its journal and its index row', () => {
    const { doomed, survivor } = twoRelatedNotes();
    expect(tally(db).relations).toBe(2);

    // `expired` on purpose: any archived reason is purgeable, including the draft an
    // agent let expire because it caught a password.
    repository.setStatus(doomed, 'archived', { reason: 'expired', actor: 'system' });

    expect(service.purge(doomed, { title: 'Termux 换源' })).toEqual({ ok: true });

    expect(service.get(doomed)).toBeUndefined();
    expect(eventsOf(db, doomed)).toBe(0);
    expect(tally(db)).toEqual({
      notes: 1,
      sources: 0,
      // Both sides: the neighbour's row that pointed at the erased note is gone too.
      relations: 0,
      events: eventsOf(db, survivor),
      // The index is a standalone table, so this row only disappears because the
      // purge names it.
      index: 1,
    });
    expect(
      db.prepare('SELECT note_id FROM notes_fts_jieba').all() as Array<{ note_id: string }>,
    ).toEqual([{ note_id: survivor }]);
    expect(service.get(survivor)?.related).toEqual([]);
  });

  it('refuses an active note and deletes nothing', () => {
    const { doomed } = twoRelatedNotes();
    const before = tally(db);

    expect(service.purge(doomed, { title: 'Termux 换源' })).toEqual({
      ok: false,
      code: 'not_archived',
    });
    expect(service.get(doomed)).toBeDefined();
    expect(tally(db)).toEqual(before);
  });

  it('refuses a draft and deletes nothing', () => {
    const draft = repository.create({
      title: 'Termux 换源',
      summary: '',
      body: 'agent 捕获的草稿',
      status: 'draft',
      origin: 'agent',
      scope: 'user',
      scopeKey: '',
    });
    if (!draft.ok) throw new Error('draft was not created');
    const before = tally(db);

    expect(service.purge(draft.note.id, { title: 'Termux 换源' })).toEqual({
      ok: false,
      code: 'not_archived',
    });
    expect(tally(db)).toEqual(before);
  });

  it('refuses a title that does not match, even for an archived note', () => {
    const { doomed } = twoRelatedNotes();
    repository.setStatus(doomed, 'archived', { reason: 'user', actor: 'user' });
    const before = tally(db);

    expect(service.purge(doomed, { title: 'Termux 后台被杀' })).toEqual({
      ok: false,
      code: 'title_mismatch',
    });
    expect(service.get(doomed)?.status).toBe('archived');
    expect(tally(db)).toEqual(before);
  });

  it('compares titles through the library key, so spelling does not have to match', () => {
    const { doomed } = twoRelatedNotes();
    repository.setStatus(doomed, 'archived', { reason: 'user', actor: 'user' });

    // Stored `Termux 换源`, typed `termux换源`: one subject by the same rule the
    // unique index uses. The friction is the retyping, not punctuation memory.
    expect(service.purge(doomed, { title: 'termux换源' })).toEqual({ ok: true });
    expect(service.get(doomed)).toBeUndefined();
  });

  it('answers not_found for an id that never existed', () => {
    expect(service.purge('nt_missing', { title: 'anything' })).toEqual({
      ok: false,
      code: 'not_found',
    });
  });

  it('frees the title for a new note, as if the erased one had never existed', () => {
    const { doomed } = twoRelatedNotes();
    repository.setStatus(doomed, 'archived', { reason: 'user', actor: 'user' });
    service.purge(doomed, { title: 'Termux 换源' });

    const recreated = service.createManual({ title: 'Termux 换源', body: '重新写一遍' });
    expect(recreated.ok).toBe(true);
    if (!recreated.ok) return;
    expect(recreated.note.status).toBe('active');
    expect(
      db
        .prepare('SELECT COUNT(*) AS c FROM notes_fts_jieba WHERE note_id = ?')
        .get(recreated.note.id),
    ).toEqual({ c: 1 });
  });

  it('shrinks the review denominator instead of keeping the verdict', () => {
    const kept = repository.create({
      title: '保留的笔记',
      summary: '',
      body: '',
      status: 'draft',
      origin: 'agent',
      scope: 'user',
      scopeKey: '',
    });
    const doomed = repository.create({
      title: '被抹除的笔记',
      summary: '',
      body: '',
      status: 'draft',
      origin: 'agent',
      scope: 'user',
      scopeKey: '',
    });
    if (!kept.ok || !doomed.ok) throw new Error('drafts were not created');

    service.review(kept.note.id, { decision: 'approve' });
    service.review(doomed.note.id, { decision: 'reject', reason: 'other' });
    expect(service.stats().approvalRate).toBe(0.5);

    // The note goes, and its verdict goes with it: an approval rate over notes that
    // no longer exist would be a ratio of two different things.
    expect(service.purge(doomed.note.id, { title: '被抹除的笔记' })).toEqual({ ok: true });
    expect(service.stats().approvalRate).toBe(1);
  });

  it('leaves exactly one trace: the logger line', () => {
    const { doomed } = twoRelatedNotes();
    repository.setStatus(doomed, 'archived', { reason: 'user', actor: 'user' });

    const lines: Array<{ fields: Record<string, unknown>; message?: string }> = [];
    const logger = {
      debug: () => {},
      warn: () => {},
      error: () => {},
      info: (fields: Record<string, unknown>, message?: string) => {
        lines.push({ fields, message });
      },
    } as unknown as Logger;
    const loggedRepository = new NotesRepository(db, logger);
    const loggedService = createNotesService({
      repository: loggedRepository,
      capture: new CapturePipeline({
        repository: loggedRepository,
        db,
        getConfig: () => RUNTIME_CONFIG,
        auxConfig: {},
        logger,
      }),
      getConfig: () => RUNTIME_CONFIG,
      logger,
    });

    expect(loggedService.purge(doomed, { title: 'Termux 换源', actor: 'user' })).toEqual({
      ok: true,
    });
    // No `note_events` row is left on purpose (a purge must read as if the note never
    // existed), so this line is the only record that it ever happened.
    expect(lines).toEqual([{ fields: { noteId: doomed, actor: 'user' }, message: 'notes.purge' }]);
  });
});
