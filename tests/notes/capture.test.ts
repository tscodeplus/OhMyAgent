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
import {
  ASSISTANT_CONTENT,
  MESSAGE_ASSISTANT,
  MESSAGE_USER,
  PROJECT_ID,
  SESSION_ID,
  USER_CONTENT,
  createTestService,
  defaultDistilled,
  openSeededDatabase,
} from './fixtures.js';

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

  it('reports the counts the review UI shows', () => {
    const { service } = createTestService(db);
    service.createManual({ title: 'a', body: 'b', kind: 'command' });
    service.createManual({ title: 'c', body: 'd', kind: 'pitfall' });
    const stats = service.stats();
    expect(stats.byStatus.active).toBe(2);
    // The kind histogram was removed with its last reader: `/api/notes` stopped
    // offering a kind filter, so nobody draws it, and a metric nobody reads is a
    // promise the code cannot keep.
    expect('byKind' in stats).toBe(false);
  });

  // ── dedupe (§5.5) ────────────────────────────────────────────────────
  //
  // The one bug this closes is not "a stray duplicate": the unique index only
  // covers `active`, so two drafts could hold one title and the *approval* of the
  // second threw `UNIQUE constraint failed`, leaving a draft nobody could resolve.

  it('refuses a second draft with a title this scope already holds', async () => {
    const { service } = createTestService(db);
    const first = await service.capture({ sessionId: SESSION_ID, mode: 'turn' });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await service.capture({ sessionId: SESSION_ID, mode: 'turn' });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe('duplicate');
    expect(second.duplicates?.[0]).toMatchObject({
      existingId: first.notes[0].id,
      status: 'draft',
    });
    // One row, not two: nothing new was created for the reviewer to puzzle over.
    expect(service.list({ status: 'draft' }).total).toBe(1);
  });

  it('names the active note that already owns a title', async () => {
    const { service } = createTestService(db);
    // The fixture session is a project session, so this is the scope the capture
    // resolves to; a different scope would be a different library.
    const created = service.createManual({
      title: 'vitest 单文件迭代',
      body: 'b',
      scope: 'project',
      scopeKey: PROJECT_ID,
    });
    if (!created.ok) throw new Error('create failed');

    const result = await service.capture({ sessionId: SESSION_ID, mode: 'turn' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('duplicate');
    expect(result.duplicates?.[0]).toMatchObject({
      existingId: created.note.id,
      status: 'active',
    });
  });

  it('refuses a repeated verbatim drop of the same text', async () => {
    const { service } = createTestService(db);
    const text = '排查端口占用：lsof -i :9191 找到 PID，再 kill。';
    const first = await service.capture({
      sessionId: SESSION_ID,
      mode: 'text',
      treatment: 'verbatim',
      text,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await service.capture({
      sessionId: SESSION_ID,
      mode: 'text',
      treatment: 'verbatim',
      text,
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe('duplicate');
    expect(second.duplicates?.[0].existingId).toBe(first.notes[0].id);
  });

  it('keeps the notes that are new when only some candidates duplicate', async () => {
    const { service, repository } = createTestService(db, {
      distillNotes: [
        { ...defaultDistilled(), title: 'already here' },
        { ...defaultDistilled(), title: 'brand new' },
      ],
    });
    repository.create({
      kind: 'command',
      title: 'already here',
      summary: '',
      body: 'b',
      status: 'draft',
      origin: 'agent',
      scope: 'project',
      scopeKey: PROJECT_ID,
    });

    const result = await service.capture({ sessionId: SESSION_ID, mode: 'turn' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.notes.map((note) => note.title)).toEqual(['brand new']);
    expect(result.duplicates.map((item) => item.title)).toEqual(['already here']);
  });

  it('does not let duplicates spend a slot under the capture cap', async () => {
    // The old order sliced the model response to `maxNotesPerCapture` *before* the
    // local gates, so two duplicates in front silently cost the fourth note its row.
    // Gates are cheap; the cap decides only what gets stored.
    const { service, repository } = createTestService(db, {
      config: { maxNotesPerCapture: 3 },
      distillNotes: [
        { ...defaultDistilled(), title: 'already here' },
        { ...defaultDistilled(), title: 'new one' },
        { ...defaultDistilled(), title: 'new two' },
        { ...defaultDistilled(), title: 'new three' },
      ],
    });
    repository.create({
      kind: 'command',
      title: 'already here',
      summary: '',
      body: 'b',
      status: 'draft',
      origin: 'agent',
      scope: 'project',
      scopeKey: PROJECT_ID,
    });

    const result = await service.capture({ sessionId: SESSION_ID, mode: 'turn' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.notes.map((note) => note.title)).toEqual(['new one', 'new two', 'new three']);
    expect(result.duplicates.map((item) => item.title)).toEqual(['already here']);
  });

  it('stores no more than the cap when every candidate is new', async () => {
    const { service } = createTestService(db, {
      config: { maxNotesPerCapture: 2 },
      distillNotes: [
        { ...defaultDistilled(), title: 'a' },
        { ...defaultDistilled(), title: 'b' },
        { ...defaultDistilled(), title: 'c' },
      ],
    });

    const result = await service.capture({ sessionId: SESSION_ID, mode: 'turn' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The excess is dropped, not merged or retitled: a lower cap is an operator
    // decision, and the capture log records that it cost a note.
    expect(result.notes.map((note) => note.title)).toEqual(['a', 'b']);
  });

  it('passes the configured body cap and output budget to the distiller', async () => {
    const { service, distillationCalls } = createTestService(db, {
      config: { maxNotesPerCapture: 2, bodyMaxChars: 900, maxOutputTokens: 5000 },
    });
    await service.capture({ sessionId: SESSION_ID, mode: 'turn' });

    // Both come from config, and the body cap is read per call (hot), so the prompt
    // and the validator cannot disagree about how long a note may be.
    expect(distillationCalls[0]).toMatchObject({ bodyMaxChars: 900, maxOutputTokens: 5000 });
  });

  it('approves only one of two same-titled drafts instead of throwing', () => {
    // The state a pre-dedupe library is in: two drafts, one title. Approving the
    // second must answer with the conflict, because the alternative was a 500 that
    // left the draft unapprovable forever.
    const { service, repository } = createTestService(db);
    const base = {
      kind: 'command' as const,
      summary: '',
      body: 'b',
      status: 'draft' as const,
      origin: 'agent' as const,
      scope: 'user' as const,
      scopeKey: '',
    };
    const first = repository.create({ ...base, title: 'same title' });
    const second = repository.create({ ...base, title: 'same title' });
    if (!first.ok || !second.ok) throw new Error('fixture create failed');

    expect(service.review(first.note.id, { decision: 'approve' }).ok).toBe(true);
    const conflicted = service.review(second.note.id, { decision: 'approve' });
    expect(conflicted.ok).toBe(false);
    expect(conflicted.code).toBe('title_conflict');
    expect(conflicted.existingId).toBe(first.note.id);
    // Still a draft: refused, not lost.
    expect(service.get(second.note.id)?.status).toBe('draft');
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
   * `text` mode with `treatment: 'verbatim'` is the drop: the words are the note's
   * body, and the model never sees them. It still lands `draft` — the user supplied
   * the material, nobody has said it is a note.
   */
  describe('verbatim capture', () => {
    it('stores the dropped text verbatim as a user draft, without a model call', async () => {
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
      expect(note.status).toBe('draft');
      expect(note.origin).toBe('user');
      expect(note.kind).toBe('other');
      // Provenance is the conversation, not a message: the sentence may be a
      // tidy-up of what was said, so citing a message would claim a quote.
      expect(note.sources).toEqual([expect.objectContaining({ kind: 'session', id: SESSION_ID })]);
      expect(service.list({ status: 'draft' }).total).toBe(1);
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
      expect(service.list({ status: 'draft' }).total).toBe(0);
    });
  });

  /**
   * The other half of the same axis: dropped text the user asked the agent to tidy.
   * Same material, different treatment — the model reads the text instead of the
   * transcript, and provenance still resolves to the session, because `selection`
   * is a synthetic row that no `messages` lookup can open.
   */
  describe('dropped text, distilled', () => {
    it('distils the dropped text and sources it from the session', async () => {
      const { service, distillationCalls } = createTestService(db, {
        distillNotes: [{ ...defaultDistilled(), title: '端口占用排查' }],
      });
      const text = 'lsof -i :9191 然后 kill -9';
      const result = await service.capture({
        sessionId: SESSION_ID,
        mode: 'text',
        treatment: 'distill',
        text,
      });

      if (!result.ok) throw new Error('capture failed: ' + result.message);
      expect(distillationCalls).toHaveLength(1);
      expect(distillationCalls[0].windowText).toContain(text);
      const note = result.notes[0];
      expect(note.status).toBe('draft');
      expect(note.origin).toBe('agent');
      expect(note.sources).toEqual([expect.objectContaining({ kind: 'session', id: SESSION_ID })]);
    });

    it('offers only the dropped text as citable evidence', async () => {
      // No stored message is in this window, so the only id the distiller may cite
      // is the synthetic `selection` row. That is what keeps a dropped selection
      // from claiming a quote nobody can open.
      const { service, distillationCalls } = createTestService(db, {
        distillNotes: [defaultDistilled()],
      });
      await service.capture({
        sessionId: SESSION_ID,
        mode: 'text',
        treatment: 'distill',
        text: 'lsof -i :9191',
      });
      expect(distillationCalls[0].windowIds).toEqual(['selection']);
    });
  });

  /**
   * An instruction is the user saying what to keep. It outranks the defaults that
   * exist to second-guess a free-running model: the window opens wider than one
   * turn, and the recap gate stops dropping notes.
   */
  describe('window scope', () => {
    /** Appends `count` exchanges after the fixture's, so there is history to lose. */
    function appendTurns(count: number, chars = 40): void {
      const insert = db.prepare(
        `INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)`,
      );
      const after = 1_780_000_002_000;
      for (let index = 0; index < count; index += 1) {
        insert.run(
          `msg-scope-u${index}`,
          SESSION_ID,
          'user',
          `追问 ${index} `.padEnd(chars, '问'),
          String(after + index * 2),
        );
        insert.run(
          `msg-scope-a${index}`,
          SESSION_ID,
          'assistant',
          `回答 ${index} `.padEnd(chars, '答'),
          String(after + 1 + index * 2),
        );
      }
    }

    it('reads the whole conversation for `session`, not a suffix', async () => {
      appendTurns(8);
      const { service, distillationCalls } = createTestService(db);

      const result = await service.capture({ sessionId: SESSION_ID, mode: 'session' });
      if (!result.ok) throw new Error(result.message);

      // 9 exchanges total: the fixture's plus eight. A five-turn `recent` window
      // would have offered 10 of the 18 messages and the first exchange would be
      // missing — which is exactly what "based on this conversation" used to mean.
      expect(distillationCalls[0].windowIds).toContain(MESSAGE_USER);
      expect(distillationCalls[0].windowIds.length).toBe(18);
      expect(result.readMessages).toBe(18);
      expect(result.droppedMessages).toBe(0);
    });

    it('escalates an instructed turn capture to the whole conversation', async () => {
      appendTurns(8);
      const { service, distillationCalls } = createTestService(db);

      await service.capture({
        sessionId: SESSION_ID,
        mode: 'turn',
        instruction: '把刚才分享的命令存下来',
      });

      expect(distillationCalls[0].windowIds).toContain(MESSAGE_ASSISTANT);
      expect(distillationCalls[0].windowIds.length).toBe(18);
    });

    it('narrows back when the instruction says how much to read', async () => {
      appendTurns(8);
      const { service, distillationCalls } = createTestService(db);

      await service.capture({
        sessionId: SESSION_ID,
        mode: 'session',
        instruction: '只整理最近 2 轮',
      });

      // Two exchanges = four messages, all from the newest end.
      expect(distillationCalls[0].windowIds.length).toBe(4);
      expect(distillationCalls[0].windowIds).not.toContain(MESSAGE_USER);
    });

    it('applies a character cap from the instruction and reports the loss', async () => {
      appendTurns(8, 400);
      const { service, distillationCalls } = createTestService(db);

      const result = await service.capture({
        sessionId: SESSION_ID,
        mode: 'session',
        instruction: '不超过 1000 字的摘要',
      });
      if (!result.ok) throw new Error(result.message);

      const windowChars = distillationCalls[0].windowText.length;
      expect(windowChars).toBeLessThanOrEqual(1000);
      expect(result.droppedMessages).toBeGreaterThan(0);
      expect(result.readMessages + result.droppedMessages).toBe(18);
    });

    it('hands the distiller a scope checker built from the window it just read', async () => {
      // A wording the regex does not match ("前面那两段就别记了"): the window stays
      // wide, and enforcement moves to the model's reported scope plus this checker.
      appendTurns(8);
      const { service, distillationCalls } = createTestService(db, {
        distillScope: { turns: 2 },
      });

      const result = await service.capture({
        sessionId: SESSION_ID,
        mode: 'session',
        instruction: '前面那两段就别记了，只留后面的',
      });
      if (!result.ok) throw new Error(result.message);

      const checker = distillationCalls[0].scopeIds;
      expect(checker).toBeDefined();
      // Two turns of the 9 = the last four messages; the fixture's first exchange is out.
      const allowed = checker?.({ turns: 2 });
      expect(allowed?.size).toBe(4);
      expect(allowed?.has(MESSAGE_USER)).toBe(false);

      // The reported scope is surfaced, so the reply can say why the note is narrow.
      expect(result.appliedScope).toEqual({ turns: 2 });
    });

    it('records the truncation on the capture run, not only on the reply', async () => {
      appendTurns(8, 400);
      const { service } = createTestService(db);

      // A character cap is the only thing that trims a window now, and it comes from
      // the brief — so this is the path that can still produce a truncation.
      const result = await service.capture({
        sessionId: SESSION_ID,
        mode: 'session',
        instruction: '只看最近 1200 字',
      });
      if (!result.ok) throw new Error(result.message);

      const row = db
        .prepare('SELECT dropped_messages AS dropped, mode FROM capture_runs WHERE id = ?')
        .get(result.captureId) as { dropped: number; mode: string };
      expect(row.mode).toBe('session');
      expect(row.dropped).toBe(result.droppedMessages);
      expect(row.dropped).toBeGreaterThan(0);
    });
  });

  describe('instruction', () => {
    it('widens a turn capture so an earlier turn is in the window', async () => {
      // Three more exchanges after the fixture's: a `turn` window would keep only
      // the last one, so the command the instruction asks for must come from a
      // wider read.
      const insert = db.prepare(
        `INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)`,
      );
      // Timestamps must be *after* the fixture's: these columns are epoch-ms digit
      // strings and the window is resolved by `created_at`, so `2_000` would sort
      // before the fixture and the "last turn" would still be the fixture's.
      const after = 1_780_000_002_000;
      for (let index = 0; index < 3; index += 1) {
        insert.run(
          `msg-late-u${index}`,
          SESSION_ID,
          'user',
          `后面的追问 ${index}`,
          String(after + index * 2),
        );
        insert.run(
          `msg-late-a${index}`,
          SESSION_ID,
          'assistant',
          `后面的回答 ${index}`,
          String(after + 1 + index * 2),
        );
      }

      const { service, distillationCalls } = createTestService(db, {
        distillNotes: [defaultDistilled()],
      });
      const instruction = '把刚才分享的查看端口占用的命令存下来';
      const result = await service.capture({ sessionId: SESSION_ID, mode: 'turn', instruction });
      if (!result.ok) throw new Error('capture failed: ' + result.message);
      expect(distillationCalls[0].instruction).toBe(instruction);
      expect(distillationCalls[0].windowIds).toContain(MESSAGE_ASSISTANT);

      // Without the instruction the same session reads one exchange and the
      // earlier message is not offered to the model at all.
      distillationCalls.length = 0;
      await service.capture({ sessionId: SESSION_ID, mode: 'turn' });
      expect(distillationCalls[0].windowIds).not.toContain(MESSAGE_ASSISTANT);
    });

    /**
     * The recap gate is a 4-gram overlap against the window, so the fixture for it
     * has to be genuinely copied text — the fixture's own exchange, not a sentence
     * that merely sounds like a summary.
     */
    const windowEcho = `${USER_CONTENT}\n${ASSISTANT_CONTENT}`;

    it('keeps a note that restates the conversation when the user asked for a summary', async () => {
      const { service } = createTestService(db, {
        distillNotes: [{ ...defaultDistilled(), title: '今天的聊天', body: windowEcho, tags: [] }],
      });
      const result = await service.capture({
        sessionId: SESSION_ID,
        mode: 'turn',
        instruction: '把今天的聊天整理成笔记',
      });
      expect(result.ok).toBe(true);
    });

    it('still drops the same recap when nobody asked for one', async () => {
      const { service } = createTestService(db, {
        distillNotes: [{ ...defaultDistilled(), title: '今天的聊天', body: windowEcho, tags: [] }],
      });
      const result = await service.capture({ sessionId: SESSION_ID, mode: 'turn' });
      expect(result.ok).toBe(false);
    });
  });
});
