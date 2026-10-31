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
