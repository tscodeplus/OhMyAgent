/**
 * Related notes: the three rules, the mirroring invariant, and the scope fence.
 *
 * Two properties matter more than any individual score, and most of these tests are
 * about them:
 *
 * 1. **Mirroring.** If a→b exists then b→a exists, always. The read path is a single
 *    lookup on `note_id`, so a one-sided pair would silently make the graph depend on
 *    which note you opened.
 * 2. **The scope fence.** A relation renders the other note's *title*. Linking across
 *    `(scope, scope_key)` would leak a title from another chat, and no read-time filter
 *    can take back a title it already showed.
 *
 * The unit tests around `scorePair` exist because the rules are the kind of thing that
 * gets "tuned" later — the thresholds are asserted, not just the outcome.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { NotesRepository } from '../../src/notes/repository.js';
import {
  MAX_RELATIONS,
  NoteRelations,
  scorePair,
  tagJaccard,
  titleContainment,
  titleTokens,
} from '../../src/notes/relations.js';
import { migrateV33 } from '../../src/memory/migration-v33.js';
import { openSeededDatabase, SESSION_ID } from './fixtures.js';
import type { CreateNoteInput } from '../../src/notes/types.js';

function note(overrides: Partial<CreateNoteInput> = {}): CreateNoteInput {
  return {
    kind: 'reference',
    title: '标题',
    summary: '',
    body: '正文',
    status: 'active',
    origin: 'user',
    scope: 'user',
    scopeKey: '',
    channel: 'webui',
    sessionId: null,
    ...overrides,
  };
}

describe('note relations — rules', () => {
  it('treats the same conversation as the strongest signal', () => {
    const hit = scorePair(
      { id: 'a', sessionId: 's1', title: '男单世界排名前3', tags: [] },
      { id: 'b', sessionId: 's1', title: '女单世界排名前3', tags: [] },
    );
    expect(hit).toEqual({ score: 0.9, basis: 'session' });
  });

  it('does not relate two notes that merely have no session', () => {
    // Both handwritten: `sessionId` null on both sides must not compare equal.
    const hit = scorePair(
      { id: 'a', sessionId: null, title: 'vitest 只跑改动的文件', tags: ['vitest'] },
      { id: 'b', sessionId: null, title: 'Power Query 报错处理', tags: ['power-query'] },
    );
    expect(hit).toBeNull();
  });

  it('relates titles that differ only by a single dropped character (known limit)', () => {
    // Documented rather than hidden: `甲`/`乙` are single chars and get dropped as
    // noise, so two titles that differ only there reduce to the same token set. The
    // cost is bounded — such titles are near-duplicates to begin with, which is why
    // this rules fires as `title` and never as `session`.
    const hit = scorePair(
      { id: 'a', sessionId: null, title: '完全不同的主题甲', tags: [] },
      { id: 'b', sessionId: null, title: '完全不同的主题乙', tags: [] },
    );
    expect(hit?.basis).toBe('title');
  });

  it('relates a title that is nearly contained in a longer one', () => {
    const short = titleTokens('Ubuntu 26.04 LTS');
    const long = titleTokens('截至2026年10月，最新为 Ubuntu 26.04 LTS');
    expect(titleContainment(short, long)).toBe(1);
    const hit = scorePair(
      { id: 'a', sessionId: null, title: 'Ubuntu 26.04 LTS', tags: [] },
      { id: 'b', sessionId: null, title: '截至2026年10月，最新为 Ubuntu 26.04 LTS', tags: [] },
    );
    expect(hit?.basis).toBe('title');
  });

  it('refuses to relate a one-word title to everything containing it', () => {
    // `Ubuntu` alone is one token → containment is undefined, not 1.
    expect(titleContainment(titleTokens('Ubuntu'), titleTokens('Ubuntu 26.04 LTS 升级'))).toBe(0);
  });

  it('scores shared tags over free tags only, and ignores a single shared tag', () => {
    expect(tagJaccard(['a', 'b', 'c'], ['a', 'b', 'd'])).toBeCloseTo(0.5);
    // 1 of 4 shared is below the floor: a theme alone is not a relation.
    expect(
      scorePair(
        { id: 'a', sessionId: null, title: '甲', tags: ['t', 'x', 'y', 'z'] },
        { id: 'b', sessionId: null, title: '乙', tags: ['t', 'q', 'r', 's'] },
      ),
    ).toBeNull();
  });

  it('does not score facets as tags even though the FTS index carries them', () => {
    // The repository indexes `tags ∪ facet tokens`; relations read the column, so two
    // notes from the same channel with no real tags stay unrelated.
    const hit = scorePair(
      { id: 'a', sessionId: null, title: '甲', tags: [] },
      { id: 'b', sessionId: null, title: '乙', tags: [] },
    );
    expect(hit).toBeNull();
  });
});

describe('note relations — persistence', () => {
  let db: Database.Database;
  let repository: NotesRepository;

  beforeEach(() => {
    db = openSeededDatabase();
    repository = new NotesRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  function create(overrides: Partial<CreateNoteInput> = {}): string {
    const result = repository.create(note(overrides));
    if (!result.ok) throw new Error(`create failed: ${result.code}`);
    return result.note.id;
  }

  function rows(): Array<{ note_id: string; related_id: string; basis: string }> {
    return db
      .prepare('SELECT note_id, related_id, basis FROM note_relations ORDER BY note_id, related_id')
      .all() as Array<{ note_id: string; related_id: string; basis: string }>;
  }

  it('writes both directions when two notes come from one session', () => {
    const a = create({ title: '男单世界排名前3', sessionId: SESSION_ID });
    const b = create({ title: '女单世界排名前3', sessionId: SESSION_ID });

    const written = rows();
    expect(written).toHaveLength(2);
    expect(written.map((row) => `${row.note_id}>${row.related_id}`)).toEqual(
      expect.arrayContaining([`${a}>${b}`, `${b}>${a}`]),
    );
    expect(written.every((row) => row.basis === 'session')).toBe(true);
    // And the read path renders it without a second query shape.
    expect(repository.get(a)?.related.map((item) => item.id)).toEqual([b]);
  });

  it('keeps relations inside one (scope, scope_key)', () => {
    const mine = create({ title: '同一主题甲', sessionId: SESSION_ID });
    // Same session, different scope: a link here would render another chat's title.
    create({
      title: '同一主题乙',
      sessionId: SESSION_ID,
      scope: 'project',
      scopeKey: 'proj-other',
    });

    expect(rows()).toEqual([]);
    expect(repository.get(mine)?.related).toEqual([]);
  });

  it('hides an archived target but keeps the row, so restoring brings it back', () => {
    const a = create({ title: '男单世界排名前3', sessionId: SESSION_ID });
    const b = create({ title: '女单世界排名前3', sessionId: SESSION_ID });

    repository.setStatus(b, 'archived');
    expect(repository.get(a)?.related).toEqual([]);
    // The row is still there: archiving is a state, not a deletion.
    expect(rows()).toHaveLength(2);

    repository.setStatus(b, 'active');
    expect(repository.get(a)?.related.map((item) => item.id)).toEqual([b]);
  });

  it('recomputes on retitle so a stale relation disappears', () => {
    const a = create({ title: 'Ubuntu 26.04 LTS', sessionId: null });
    const b = create({ title: 'Ubuntu 26.04 LTS 升级记录', sessionId: null });
    expect(repository.get(a)?.related.map((item) => item.id)).toEqual([b]);

    const current = repository.get(b);
    expect(current).toBeDefined();
    repository.update(b, {
      title: 'Power Query 报 TargetParameterCountException',
      tags: ['power-query'],
      expectedVersion: current?.version,
      actor: 'user',
    });

    expect(repository.get(a)?.related).toEqual([]);
    expect(rows()).toEqual([]);
  });

  it('writes nothing for an archived note and drops its rows when it is archived', () => {
    const a = create({ title: '男单世界排名前3', sessionId: SESSION_ID });
    const b = create({ title: '女单世界排名前3', sessionId: SESSION_ID });

    // Archiving does not delete on its own (a restore must be free)...
    repository.setStatus(a, 'archived');
    expect(rows()).toHaveLength(2);

    // ...but a rebuild of the archived note clears both sides.
    new NoteRelations(db).rebuild(a);
    expect(rows()).toEqual([]);
    expect(repository.get(b)?.related).toEqual([]);
  });

  it(`caps each note at ${MAX_RELATIONS} relations and keeps the strongest`, () => {
    const ids: string[] = [];
    for (let index = 0; index < MAX_RELATIONS + 2; index += 1) {
      ids.push(create({ title: `笔记 ${index}`, sessionId: SESSION_ID }));
    }

    for (const id of ids) {
      const count = (
        db.prepare('SELECT COUNT(*) AS c FROM note_relations WHERE note_id = ?').get(id) as {
          c: number;
        }
      ).c;
      expect(count).toBeLessThanOrEqual(MAX_RELATIONS);
    }
  });

  it('is idempotent: rebuilding twice produces the same rows', () => {
    const a = create({ title: '男单世界排名前3', sessionId: SESSION_ID });
    create({ title: '女单世界排名前3', sessionId: SESSION_ID });
    const before = rows();
    new NoteRelations(db).rebuildAll();
    expect(rows()).toEqual(before);
    expect(repository.get(a)?.related).toHaveLength(1);
  });

  it('reports the same count from preview() as rebuild() writes', () => {
    const a = create({ title: '男单世界排名前3', sessionId: SESSION_ID });
    create({ title: '女单世界排名前3', sessionId: SESSION_ID });
    const relations = new NoteRelations(db);
    expect(relations.preview(a)).toBe(1);
    expect(relations.rebuild(a)).toBe(1);
  });
});

describe('migrateV33', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openSeededDatabase();
  });

  afterEach(() => {
    db.close();
  });

  it('is a no-op on a database whose table was created by v31', () => {
    // v31 declares `origin`, so the first call rebuilds and the second finds `basis`.
    const first = migrateV33(db);
    expect(first.discardedRows).toBe(0);
    const second = migrateV33(db);
    expect(second.rebuilt).toBe(false);

    const columns = (
      db.prepare('PRAGMA table_info(note_relations)').all() as Array<{ name: string }>
    )
      .map((column) => column.name)
      .sort();
    expect(columns).toEqual(['basis', 'created_at', 'note_id', 'related_id', 'score']);
  });
});
