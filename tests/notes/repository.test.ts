/**
 * Notes repository: rows, sources, FTS index, versioning and the scope read rule.
 *
 * The load-bearing assertions are the refusals — a create that overwrites an
 * active note, an update without `expectedVersion`, a staged write that leaves the
 * index behind — because those are the failures that stay invisible until a search
 * returns a note the user thought they had replaced.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { NotesRepository } from '../../src/notes/repository.js';
import { migrateV31 } from '../../src/memory/migration-v31.js';
import { MESSAGE_ASSISTANT, openSeededDatabase, PROJECT_ID, SESSION_ID } from './fixtures.js';
import type { CreateNoteInput } from '../../src/notes/types.js';

function baseInput(overrides: Partial<CreateNoteInput> = {}): CreateNoteInput {
  return {
    kind: 'command',
    title: 'vitest 单文件迭代',
    summary: '改哪个文件就跑哪个',
    body: 'npx vitest run tests/agent',
    status: 'active',
    origin: 'user',
    scope: 'user',
    scopeKey: '',
    channel: 'webui',
    sessionId: SESSION_ID,
    ...overrides,
  };
}

describe('NotesRepository', () => {
  let db: Database.Database;
  let repository: NotesRepository;

  beforeEach(() => {
    db = openSeededDatabase();
    repository = new NotesRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('creates a note with its index row in one transaction', () => {
    const result = repository.create(baseInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.note.title).toBe('vitest 单文件迭代');
    const indexed = db
      .prepare('SELECT note_id FROM notes_fts_jieba WHERE note_id = ?')
      .all(result.note.id) as Array<{ note_id: string }>;
    expect(indexed).toHaveLength(1);
  });

  it('refuses a second active note with the same subject in the same scope', () => {
    const first = repository.create(baseInput());
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = repository.create(baseInput({ body: 'different body' }));
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe('title_conflict');
    expect(second.existingId).toBe(first.note.id);
  });

  it('normalises the title key so punctuation and case do not fork a subject', () => {
    const first = repository.create(baseInput({ title: 'Vitest 单文件迭代' }));
    expect(first.ok).toBe(true);
    const second = repository.create(baseInput({ title: 'vitest-单文件迭代！' }));
    expect(second.ok).toBe(false);
  });

  it('allows the same subject in another scope and as a draft', () => {
    repository.create(baseInput());
    const otherScope = repository.create(baseInput({ scope: 'project', scopeKey: PROJECT_ID }));
    expect(otherScope.ok).toBe(true);

    const draft = repository.create(baseInput({ status: 'draft', origin: 'agent' }));
    expect(draft.ok).toBe(true);
  });

  it('requires the version a content edit read', () => {
    const created = repository.create(baseInput());
    if (!created.ok) throw new Error('create failed');

    const missing = repository.update(created.note.id, { body: 'new body' });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.code).toBe('version_required');

    const stale = repository.update(created.note.id, { body: 'new body', expectedVersion: 99 });
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.code).toBe('version_mismatch');
    // The refused editor gets the current text back so it can re-merge.
    expect(stale.code === 'version_mismatch' && stale.currentBody).toBe(
      'npx vitest run tests/agent',
    );
  });

  it('bumps the version and rewrites the index row instead of appending one', () => {
    const created = repository.create(baseInput());
    if (!created.ok) throw new Error('create failed');

    const updated = repository.update(created.note.id, {
      title: 'vitest 单文件迭代（修订）',
      body: 'npx vitest run tests/notes',
      expectedVersion: created.note.version,
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.note.version).toBe(created.note.version + 1);

    const rows = db
      .prepare('SELECT body FROM notes_fts_jieba WHERE note_id = ?')
      .all(created.note.id) as Array<{ body: string }>;
    // FTS5 has no uniqueness constraint: delete-then-insert is what keeps one row.
    expect(rows).toHaveLength(1);
    // The index stores jieba-segmented text, so the assertion is on the token.
    expect(rows[0].body).toContain('notes');
  });

  it('re-indexes on status change so an approved draft becomes searchable', () => {
    const draft = repository.create(baseInput({ status: 'draft', origin: 'agent' }));
    if (!draft.ok) throw new Error('create failed');

    const active = repository.list({ status: 'active', q: 'vitest' });
    expect(active.notes).toHaveLength(0);

    repository.setStatus(draft.note.id, 'active', { actor: 'user' });
    const afterApprove = repository.list({ status: 'active', q: 'vitest' });
    expect(afterApprove.notes.map((note) => note.id)).toContain(draft.note.id);
  });

  it('keeps the row and the reason when archiving', () => {
    const created = repository.create(baseInput());
    if (!created.ok) throw new Error('create failed');

    const archived = repository.setStatus(created.note.id, 'archived', { reason: 'rejected' });
    expect(archived?.ok).toBe(true);
    if (!archived?.ok) throw new Error('archive failed');
    expect(archived.note.status).toBe('archived');
    expect(archived.note.statusReason).toBe('rejected');
    // Still readable by id: rejecting a note is not deleting it.
    expect(repository.get(created.note.id)?.body).toContain('vitest');
  });

  it('stores citations and resolves whether they still exist', () => {
    const created = repository.create(
      baseInput({
        status: 'draft',
        origin: 'agent',
        sources: [
          { kind: 'message', id: 'msg-notes-assistant-1', excerpt: 'npx vitest run tests/agent' },
          { kind: 'message', id: 'msg-gone', excerpt: 'deleted message' },
          { kind: 'session', id: SESSION_ID },
        ],
      }),
    );
    if (!created.ok) throw new Error('create failed');

    const note = repository.get(created.note.id);
    expect(note?.sources).toHaveLength(3);
    const available = note?.sources.filter((source) => source.available) ?? [];
    const gone = note?.sources.filter((source) => !source.available) ?? [];
    // The missing message is greyed, not dropped: dropping it would rewrite history.
    expect(available).toHaveLength(2);
    expect(gone.map((source) => source.id)).toEqual(['msg-gone']);
  });

  it('applies the scope read rule, not a strict equality', () => {
    repository.create(baseInput({ scope: 'user', scopeKey: '' }));
    repository.create(baseInput({ title: '项目笔记', scope: 'project', scopeKey: PROJECT_ID }));
    repository.create(
      baseInput({ title: '群里笔记', scope: 'channel', scopeKey: 'feishu:oc_notes_group' }),
    );

    // A project conversation sees the personal notes plus its own project's.
    const inProject = repository.list({
      status: 'active',
      context: { projectId: PROJECT_ID },
    });
    expect(inProject.notes.map((note) => note.title).sort()).toEqual([
      'vitest 单文件迭代',
      '项目笔记',
    ]);

    // A group chat that is not in that project sees only the personal layer.
    const inGroup = repository.list({
      status: 'active',
      context: { channelKey: 'feishu:oc_notes_group' },
    });
    expect(inGroup.notes.map((note) => note.title).sort()).toEqual([
      'vitest 单文件迭代',
      '群里笔记',
    ]);

    // No context (console) = the whole library.
    expect(repository.list({ status: 'active' }).notes).toHaveLength(3);
  });

  it('indexes facet tokens without putting them in the tags column', () => {
    const created = repository.create(
      baseInput({ title: '飞书卡片', channel: 'feishu', tags: ['callback'] }),
    );
    if (!created.ok) throw new Error('create failed');

    // The column keeps only user tags (facet truth lives in its own column).
    expect(created.note.tags).toEqual(['callback']);
    // The index carries 飞书, so a Chinese search finds a `feishu` note.
    const found = repository.list({ status: 'active', q: '飞书' });
    expect(found.notes.map((note) => note.id)).toEqual([created.note.id]);
  });

  it('counts tags for the filter row', () => {
    repository.create(baseInput({ title: 'a', tags: ['vitest', 'testing'] }));
    repository.create(baseInput({ title: 'b', tags: ['vitest'] }));
    const { tags } = repository.list({ status: 'active' });
    expect(tags[0]).toEqual({ tag: 'vitest', count: 2 });
  });

  /**
   * The filter row is a set of checkboxes: OR inside a facet, AND across facets.
   * Both halves are asserted here because getting the second one wrong (OR across
   * everything) returns notes that match neither filter, which looks like a bug in
   * the list rather than in the query.
   */
  it('filters on a set per facet: OR inside, AND across', () => {
    repository.create(
      baseInput({ title: 'a', tags: ['vitest'], origin: 'user', channel: 'webui' }),
    );
    repository.create(
      baseInput({
        title: 'b',
        tags: ['testing'],
        origin: 'agent',
        channel: 'feishu',
        scope: 'project',
        scopeKey: PROJECT_ID,
      }),
    );
    repository.create(
      baseInput({ title: 'c', tags: ['vitest'], origin: 'agent', channel: 'telegram' }),
    );

    const titles = (query: Parameters<typeof repository.list>[0]) =>
      repository
        .list(query)
        .notes.map((note) => note.title)
        .sort();

    // Either tag.
    expect(titles({ status: 'active', tags: ['vitest', 'testing'] })).toEqual(['a', 'b', 'c']);
    // Either origin.
    expect(titles({ status: 'active', origins: ['user', 'agent'] })).toEqual(['a', 'b', 'c']);
    // Either channel, but only for that author: the AND between facets still holds.
    expect(titles({ status: 'active', channels: ['feishu', 'telegram'] })).toEqual(['b', 'c']);
    expect(
      titles({ status: 'active', origins: ['agent'], channels: ['feishu', 'telegram'] }),
    ).toEqual(['b', 'c']);
    // A tag that does not exist excludes everything.
    expect(titles({ status: 'active', tags: ['nope'] })).toEqual([]);
    // An empty set is "not filtered", not "match nothing".
    expect(titles({ status: 'active', tags: [] })).toEqual(['a', 'b', 'c']);
  });

  it('describes the library in its facets even when a filter is applied', () => {
    repository.create(baseInput({ title: 'a', channel: 'webui' }));
    repository.create(
      baseInput({
        title: 'b',
        channel: 'feishu',
        scope: 'project',
        scopeKey: PROJECT_ID,
      }),
    );

    const narrowed = repository.list({ status: 'active', channels: ['webui'] });
    expect(narrowed.notes.map((note) => note.title)).toEqual(['a']);
    // The control that would widen the view must still offer the value it hid.
    // Ties on count break by name, so this order is stable across runs.
    expect(narrowed.channels).toEqual([
      { channel: 'feishu', count: 1 },
      { channel: 'webui', count: 1 },
    ]);
    expect(narrowed.projects).toEqual([{ id: PROJECT_ID, name: 'OhMyAgent', count: 1 }]);
  });

  it('expires stale drafts by archiving them', () => {
    const old = Date.now() - 30 * 24 * 3600_000;
    repository.create(baseInput({ status: 'draft', origin: 'agent', now: old }));

    const expired = repository.expireDrafts(14);
    expect(expired).toHaveLength(1);
    const note = repository.list({ status: 'archived' }).notes[0];
    expect(note.statusReason).toBe('expired');
  });

  it('is idempotent when the migration replays', () => {
    const created = repository.create(baseInput());
    expect(created.ok).toBe(true);
    // The real openDatabase() already ran v31; a second run must change nothing.
    expect(() => migrateV31(db)).not.toThrow();
    expect(repository.list({ status: 'active' }).total).toBe(1);
  });

  it('resolves a message source to its conversation, and drops it when gone', () => {
    // The repository is enough here: this test is about what `decorate` resolves.
    const repository = new NotesRepository(db);
    const created = repository.create({
      kind: 'pitfall',
      title: 'source session',
      summary: '',
      body: 'b',
      status: 'active',
      origin: 'agent',
      scope: 'project',
      scopeKey: 'proj-1',
      sessionId: SESSION_ID,
      sources: [
        { kind: 'message', id: MESSAGE_ASSISTANT },
        { kind: 'message', id: 'msg-deleted' },
      ],
    });
    if (!created.ok) throw new Error('create failed');

    // The drawer needs the conversation, not just the message id.
    const note = repository.get(created.note.id);
    const live = note?.sources.find((item) => item.id === MESSAGE_ASSISTANT);
    expect(live?.sessionId).toBe(SESSION_ID);
    expect(live?.available).toBe(true);

    // A citation whose row is gone has no session to offer either.
    const gone = note?.sources.find((item) => item.id === 'msg-deleted');
    expect(gone?.available).toBe(false);
    expect(gone?.sessionId ?? null).toBeNull();
  });
});
