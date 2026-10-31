/**
 * Capture pipeline + service: the two guarantees the whole layer rests on.
 *
 *   1. Distilled content is **always** a draft. No code path in this module can
 *      produce an `active` note from a model response.
 *   2. A human-written note is active on arrival, and editing a draft does not
 *      approve it.
 *
 * The model is replaced at the `distill` seam, so these run without a provider and
 * without a network call.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestService, defaultDistilled, openSeededDatabase, SESSION_ID } from './fixtures.js';

describe('notes capture', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openSeededDatabase();
  });

  afterEach(() => {
    db.close();
  });

  it('lands a distilled note as a draft with its citations', async () => {
    const { service } = createTestService(db);
    const result = await service.capture({ sessionId: SESSION_ID, mode: 'turn' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const draft = result.notes[0];
    expect(draft.status).toBe('draft');
    expect(draft.origin).toBe('agent');
    expect(draft.sources.length).toBeGreaterThan(0);
    expect(draft.captureId).toBe(result.captureId);
    // A project session defaults to the project scope, not the personal one.
    expect(draft.scope).toBe('project');
    expect(draft.projectName).toBe('OhMyAgent');
  });

  it('is invisible in the active list until approved, then visible', async () => {
    const { service } = createTestService(db);
    const result = await service.capture({ sessionId: SESSION_ID, mode: 'turn' });
    if (!result.ok) throw new Error('capture failed');

    expect(service.list({ status: 'active' }).total).toBe(0);
    expect(service.list({ status: 'draft' }).total).toBe(1);

    const approved = service.review(result.notes[0].id, { decision: 'approve' });
    expect(approved.ok).toBe(true);
    expect(approved.note?.status).toBe('active');
    expect(service.list({ status: 'active' }).total).toBe(1);
  });

  it('refuses to capture from an unknown session', async () => {
    const { service } = createTestService(db);
    const result = await service.capture({ sessionId: 'nope', mode: 'turn' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('no_session');
  });

  it('drops a draft that restates the window and reports no notes', async () => {
    // A body that shares nearly every 4-gram with the window, with no tags: the
    // canonical "model summarised the conversation" failure.
    // The restatement is built from the stored window, which is what a recap is:
    // the model handing the conversation back instead of distilling it.
    const stored = db
      .prepare('SELECT content FROM messages WHERE session_id = ? ORDER BY created_at')
      .all(SESSION_ID) as Array<{ content: string }>;
    const windowRestatement = stored.map((row) => row.content).join('\n');
    const { service } = createTestService(db, {
      distillNotes: [
        {
          ...defaultDistilled(),
          body: windowRestatement,
          tags: [],
        },
      ],
    });
    const result = await service.capture({ sessionId: SESSION_ID, mode: 'turn' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('no_notes');
  });

  it('records the capture run with its window and outcome', async () => {
    const { service } = createTestService(db);
    const result = await service.capture({ sessionId: SESSION_ID, mode: 'turn' });
    if (!result.ok) throw new Error('capture failed');

    const run = db
      .prepare('SELECT message_ids, status, note_count, mode FROM capture_runs WHERE id = ?')
      .get(result.captureId) as {
      message_ids: string;
      status: string;
      note_count: number;
      mode: string;
    };
    expect(run.status).toBe('ok');
    expect(run.note_count).toBe(1);
    expect(run.mode).toBe('turn');
    expect(JSON.parse(run.message_ids)).toEqual([
      'msg-notes-user-1',
      defaultDistilled().evidence[0],
    ]);
  });

  it('honours an explicit session scope over the inferred one', async () => {
    const { service } = createTestService(db);
    const result = await service.capture({
      sessionId: SESSION_ID,
      mode: 'turn',
      scope: 'session',
    });
    if (!result.ok) throw new Error('capture failed');
    expect(result.notes[0].scope).toBe('session');
    expect(result.notes[0].scopeKey).toBe(SESSION_ID);
  });
});

describe('notes service', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openSeededDatabase();
  });

  afterEach(() => {
    db.close();
  });

  it('makes a manual note active immediately', () => {
    const { service } = createTestService(db);
    const result = service.createManual({
      title: 'Termux 的 phantom process killer',
      body: '长任务会被系统的 phantom process killer 杀掉。',
      tags: ['termux'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.note.status).toBe('active');
    expect(result.note.origin).toBe('user');
  });

  it('refuses a manual note whose subject already exists', () => {
    const { service } = createTestService(db);
    service.createManual({ title: 'pnpm 换源', body: 'a' });
    const second = service.createManual({ title: 'PNPM 换源！', body: 'b' });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe('title_conflict');
  });

  it('editing a draft does not approve it', async () => {
    const { service } = createTestService(db);
    const captured = await service.capture({ sessionId: SESSION_ID, mode: 'turn' });
    if (!captured.ok) throw new Error('capture failed');
    const draft = captured.notes[0];

    const edited = service.update(draft.id, {
      body: '改过的正文',
      expectedVersion: draft.version,
    });
    expect(edited.ok).toBe(true);
    expect(edited.note?.status).toBe('draft');
    expect(edited.note?.body).toBe('改过的正文');
  });

  it('rejects with a reason and keeps the row', async () => {
    const { service } = createTestService(db);
    const captured = await service.capture({ sessionId: SESSION_ID, mode: 'turn' });
    if (!captured.ok) throw new Error('capture failed');

    const rejected = service.review(captured.notes[0].id, {
      decision: 'reject',
      reason: 'duplicate',
    });
    expect(rejected.note?.status).toBe('archived');
    // Two facts, two places: the row was *rejected*, and the reviewer's code is
    // in the log so the tally stays actionable.
    expect(rejected.note?.statusReason).toBe('rejected');
    const logged = db
      .prepare("SELECT detail FROM note_events WHERE note_id = ? AND action = 'reject'")
      .get(captured.notes[0].id) as { detail: string } | undefined;
    expect(logged?.detail).toBe('duplicate');
    expect(service.get(captured.notes[0].id)?.body).toBe(captured.notes[0].body);
  });

  it('archives and restores without losing the body', () => {
    const { service } = createTestService(db);
    const created = service.createManual({ title: 't', body: 'body' });
    if (!created.ok) throw new Error('create failed');

    service.archive(created.note.id);
    expect(service.get(created.note.id)?.status).toBe('archived');

    const restored = service.restore(created.note.id);
    expect(restored.note?.status).toBe('active');
    expect(restored.note?.body).toBe('body');
  });

  it('counts views without making GET a write', () => {
    const { service } = createTestService(db);
    const created = service.createManual({ title: 't', body: 'body' });
    if (!created.ok) throw new Error('create failed');

    service.get(created.note.id);
    expect(service.get(created.note.id)?.viewCount).toBe(0);
    service.recordView(created.note.id);
    expect(service.get(created.note.id)?.viewCount).toBe(1);
  });

  it('reports status and kind counts', () => {
    const { service } = createTestService(db);
    service.createManual({ title: 'a', body: 'b', kind: 'command' });
    service.createManual({ title: 'c', body: 'd', kind: 'pitfall' });
    const stats = service.stats();
    expect(stats.byStatus.active).toBe(2);
    expect(stats.byKind.command).toBe(1);
    expect(stats.byKind.pitfall).toBe(1);
  });

  it('expires stale drafts through the repository, as hygiene will', () => {
    const { repository } = createTestService(db);
    repository.create({
      kind: 'other',
      title: 'old draft',
      summary: '',
      body: 'b',
      status: 'draft',
      origin: 'agent',
      scope: 'user',
      scopeKey: '',
      now: Date.now() - 40 * 24 * 3600_000,
    });
    expect(repository.expireDrafts(14)).toHaveLength(1);
    expect(repository.list({ status: 'draft' }).total).toBe(0);
  });

  /**
   * `text` mode is the one capture that never reaches the model (§4.2-2): the
   * sentence is the note. If it were distilled, the review gate would be applied to
   * the user's own words — and the sentence would come back paraphrased.
   */
  describe('text mode', () => {
    it('stores the sentence verbatim and active, without a model call', async () => {
      const { service } = createTestService(db, {
        // Any template, even a recap, would prove the distiller ran.
        distillNotes: [{ ...defaultDistilled(), title: 'DISTILLED' }],
      });
      const text = 'pnpm test 全量跑之前先单独跑改动的那个文件。' + '\n\n第二行不进标题。';
      const result = await service.capture({ sessionId: SESSION_ID, mode: 'text', text });

      if (!result.ok) throw new Error('capture failed: ' + result.message);
      const note = result.notes[0];
      expect(note.title).toBe('pnpm test 全量跑之前先单独跑改动的那个文件。');
      expect(note.body).toBe(text);
      expect(note.status).toBe('active');
      expect(note.origin).toBe('user');
      expect(note.kind).toBe('other');
      // Provenance is the conversation, not a message: the sentence may be a
      // tidy-up of what was said, so citing a message would claim a quote.
      expect(note.sources).toEqual([expect.objectContaining({ kind: 'session', id: SESSION_ID })]);
      expect(service.list({ status: 'draft' }).total).toBe(0);
    });

    it('honours an explicit kind', async () => {
      const { service } = createTestService(db);
      const result = await service.capture({
        sessionId: SESSION_ID,
        mode: 'text',
        text: 'npx vitest run tests/notes',
        kind: 'command',
      });
      if (!result.ok) throw new Error('capture failed');
      expect(result.notes[0].kind).toBe('command');
    });

    it('refuses empty text as an empty capture, not a note', async () => {
      const { service } = createTestService(db);
      const result = await service.capture({ sessionId: SESSION_ID, mode: 'text', text: '   ' });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe('empty_window');
      expect(service.list({ status: 'active' }).total).toBe(0);
    });

    it('prefills from the last user message, ignoring assistant turns', async () => {
      const { service } = createTestService(db);
      const prefill = service.prefill(SESSION_ID);
      expect(prefill).toContain('vitest 全量跑太慢');
    });

    it('has no prefill for an unknown session', () => {
      const { service } = createTestService(db);
      expect(service.prefill('nope')).toBeNull();
    });
  });
});
