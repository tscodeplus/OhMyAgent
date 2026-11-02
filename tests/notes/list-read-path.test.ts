/**
 * The note list's read path: ranking, paging and what one page costs.
 *
 * Three properties, each of which was quietly wrong in a way the existing tests
 * could not see: a search whose result order was re-sorted by `updated_at` (so the
 * best match lost to the newest one), a `total` counted over a capped id list (so
 * it stopped at 200 and later rows were unreachable), and hydration that prepared a
 * statement per row. The cost assertion counts `prepare` calls rather than
 * milliseconds — the review measured 356 for one 50-note page, and a time budget on
 * an in-memory database is a coin flip on CI.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { NotesRepository } from '../../src/notes/repository.js';
import { indexNote } from '../../src/notes/indexer.js';
import {
  createTestService,
  MESSAGE_ASSISTANT,
  openSeededDatabase,
  SESSION_ID,
} from './fixtures.js';
import type { CreateNoteInput } from '../../src/notes/types.js';

function note(overrides: Partial<CreateNoteInput> = {}): CreateNoteInput {
  return {
    title: 'vitest 只跑改过的文件',
    summary: '',
    body: 'npx vitest run tests/notes',
    status: 'active',
    origin: 'user',
    scope: 'user',
    scopeKey: '',
    sessionId: SESSION_ID,
    ...overrides,
  };
}

/**
 * `count` indexed notes written straight to the table.
 *
 * Not `repository.create()`: every create rebuilds its scope's relations, so 205 of
 * them would spend the test scoring ~21k title pairs to prove a `COUNT`.
 */
function seedIndexedNotes(db: Database.Database, count: number): void {
  const insert = db.prepare(
    `INSERT INTO notes (
       id, title, normalized_title, summary, body, status, origin, scope, scope_key,
       created_at, updated_at
     ) VALUES (?, ?, ?, '', 'vitest seeded body', 'active', 'user', 'user', '', ?, ?)`,
  );
  for (let i = 0; i < count; i += 1) {
    const id = `nt_seed_${i}`;
    const title = `seeded note ${i}`;
    insert.run(id, title, title, i, i);
    indexNote(db, {
      id,
      status: 'active',
      scope: 'user',
      scopeKey: '',
      title,
      summary: '',
      body: 'vitest seeded body',
      indexTags: [],
    });
  }
}

/**
 * Shadow `db.prepare` to count calls.
 *
 * The repository caches its statements, so this sees exactly what it had to prepare:
 * the distinct query shapes. It is the number the review measured (356 for one page
 * of 50) and it does not vary with the machine it runs on.
 */
function countPrepares(db: Database.Database): { readonly count: number; restore: () => void } {
  // One cast to a plain shape, so the wrapper does not have to re-state
  // better-sqlite3's generic `prepare<BindParameters, Result>` signature.
  const holder = db as unknown as { prepare: (source: string) => unknown };
  const original = holder.prepare.bind(db);
  let count = 0;
  holder.prepare = (source: string) => {
    count += 1;
    return original(source);
  };
  return {
    get count() {
      return count;
    },
    restore: () => {
      holder.prepare = original;
    },
  };
}

describe('notes list read path', () => {
  let db: Database.Database;
  let repository: NotesRepository;

  beforeEach(() => {
    db = openSeededDatabase();
    repository = new NotesRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  /**
   * The regression the review asked for: the title hit is older *and* unpinned, and
   * must still come first. Ordering by `pinned, updated_at` returned it second for
   * no reason other than its age.
   */
  it('ranks a title hit above a newer note that only mentions the word', () => {
    const onTopic = repository.create(note({ title: 'vitest 单文件迭代', now: 1_000 }));
    const newerMention = repository.create(
      note({ title: '测试框架的选择', body: 'vitest 只是其中之一', now: 9_000_000 }),
    );
    if (!onTopic.ok || !newerMention.ok) throw new Error('create failed');
    // Pinned as well: relevance outranks both of the browse-order signals.
    repository.setPinned(newerMention.note.id, true);

    const hits = repository.list({ status: 'active', q: 'vitest' });

    expect(hits.notes.map((candidate) => candidate.id)).toEqual([
      onTopic.note.id,
      newerMention.note.id,
    ]);
    // And the ranking reaches only the *order*: every match is still returned.
    expect(hits.total).toBe(2);
  });

  it('counts and pages the whole match set, not the first 200', () => {
    seedIndexedNotes(db, 205);

    const firstPage = repository.list({ status: 'active', q: 'vitest', limit: 200 });
    expect(firstPage.total).toBe(205);
    expect(firstPage.notes).toHaveLength(200);

    // The rows past the old 200-id cap were not reachable at all.
    const secondPage = repository.list({ status: 'active', q: 'vitest', limit: 200, offset: 200 });
    expect(secondPage.notes).toHaveLength(5);
    expect(new Set([...firstPage.notes, ...secondPage.notes].map((row) => row.id)).size).toBe(205);
  });

  it('pages a search by rank, so offset walks the relevance order', () => {
    const best = repository.create(note({ title: 'vitest 只跑一个文件', now: 1_000 }));
    const middle = repository.create(
      note({ title: '测试怎么跑', body: 'vitest 可以', now: 2_000 }),
    );
    const worst = repository.create(
      note({ title: '别的主题', body: '一句 vitest 带过，其余无关', now: 3_000 }),
    );
    if (!best.ok || !middle.ok || !worst.ok) throw new Error('create failed');

    const ranked = repository.list({ status: 'active', q: 'vitest' });
    const order = ranked.notes.map((candidate) => candidate.id);
    expect(order[0]).toBe(best.note.id);

    const second = repository.list({ status: 'active', q: 'vitest', limit: 1, offset: 1 });
    expect(second.notes.map((candidate) => candidate.id)).toEqual([order[1]]);
    expect(second.total).toBe(3);
  });

  it('still treats an untokenisable query as a search that matches nothing', () => {
    repository.create(note());
    const hits = repository.list({ status: 'active', q: '!!!' });
    expect(hits.notes).toHaveLength(0);
    expect(hits.total).toBe(0);
  });

  it('hydrates a full page with a bounded number of prepared statements', () => {
    for (let i = 0; i < 50; i += 1) {
      const created = repository.create(
        note({
          title: `分页笔记 ${i}`,
          tags: ['vitest'],
          sources: [{ kind: 'message', id: MESSAGE_ASSISTANT }],
        }),
      );
      if (!created.ok) throw new Error('create failed');
    }

    const probe = countPrepares(db);
    try {
      const page = repository.list({ status: 'active', limit: 50 });
      expect(page.notes).toHaveLength(50);
      // Sources, relations, project names and session titles are one query each,
      // plus the page, its count, the status counts and the three facets.
      expect(probe.count).toBeLessThan(20);

      const firstPageCost = probe.count;
      repository.list({ status: 'active', limit: 50 });
      // Second identical page: nothing left to prepare, i.e. the statements are
      // cached on the repository rather than rebuilt per call.
      expect(probe.count).toBe(firstPageCost);
    } finally {
      probe.restore();
    }
  });

  it('answers stats without opening a list page', () => {
    const seed = new NotesRepository(db);
    seed.create(note({ title: 'active one' }));
    seed.create(note({ title: 'draft one', status: 'draft', origin: 'agent' }));
    const archived = seed.create(note({ title: 'archived one' }));
    if (!archived.ok) throw new Error('create failed');
    seed.setStatus(archived.note.id, 'archived', { reason: 'user' });

    // A fresh repository, so the read statements are still unprepared: the count
    // below is what `stats()` needs, nothing inherited from seeding.
    const { service } = createTestService(db);
    const probe = countPrepares(db);
    try {
      const stats = service.stats();
      expect(stats.byStatus).toEqual({ active: 1, draft: 1, archived: 1 });
      // `counts` + `countDraftsOlderThan`. Hydrating a note for the counts would
      // add the page, its count, the facets and the companions.
      expect(probe.count).toBeLessThanOrEqual(3);
    } finally {
      probe.restore();
    }
  });
});
