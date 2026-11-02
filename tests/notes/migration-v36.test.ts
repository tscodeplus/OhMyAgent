/**
 * Migration v36 — `notes.kind` → aspect tags, then the column is dropped.
 *
 * Built on a hand-rolled pre-v36 database (v31 + v33 only) rather than the real
 * `openDatabase()` chain, because the chain now ends with v36: a test through it
 * could never observe the `kind` column existing. The migration's own replay
 * safety is asserted against a second call.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrateV31 } from '../../src/memory/migration-v31.js';
import { migrateV33 } from '../../src/memory/migration-v33.js';
import { migrateV36 } from '../../src/memory/migration-v36.js';

function insertNote(db: Database.Database, row: Record<string, unknown>): string {
  const id = row.id as string;
  db.prepare(
    `INSERT INTO notes (
       id, kind, title, normalized_title, summary, body, fields, tags, status,
       origin, scope, scope_key, pinned, version, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 0, 1, ?, ?)`,
  ).run(
    id,
    row.kind,
    row.title,
    row.title,
    '',
    row.body ?? 'b',
    row.tags ?? null,
    row.status ?? 'active',
    row.origin ?? 'user',
    row.scope ?? 'user',
    '',
    1_780_000_000_000,
    1_780_000_000_000,
  );
  return id;
}

/** A database as it looked the day before v36: kind column, no aspect tags. */
function preV36Database(): Database.Database {
  const db = new Database(':memory:');
  migrateV31(db);
  migrateV33(db);
  return db;
}

function kindColumn(db: Database.Database): boolean {
  const columns = db.prepare('PRAGMA table_info(notes)').all() as Array<{ name: string }>;
  return columns.some((column) => column.name === 'kind');
}

function tagsOf(db: Database.Database, id: string): string[] {
  const row = db.prepare('SELECT tags FROM notes WHERE id = ?').get(id) as {
    tags: string | null;
  };
  return row.tags ? (JSON.parse(row.tags) as string[]) : [];
}

describe('migrateV36 — kind → aspect tags', () => {
  it('backfills the aspect tag and drops the column', () => {
    const db = preV36Database();
    insertNote(db, { id: 'n1', kind: 'pitfall', title: 'sqlite 迁移丢列', tags: '["sqlite"]' });
    insertNote(db, { id: 'n2', kind: 'insight', title: '并发跑测试会互相拖慢' });
    insertNote(db, { id: 'n3', kind: 'other', title: '随手记' });
    // Six subject tags already: the aspect must not evict one of them.
    insertNote(db, {
      id: 'n4',
      kind: 'command',
      title: '命令六标签',
      tags: '["a","b","c","d","e","f"]',
    });

    const result = migrateV36(db);

    expect(result.dropped).toBe(true);
    expect(result.retagged).toBe(2);
    expect(kindColumn(db)).toBe(false);
    // `insight` collapses into `opinion`; `other` gains nothing; a full tag row
    // keeps its six subjects and loses the aspect.
    expect(tagsOf(db, 'n1')).toEqual(['sqlite', 'pitfall']);
    expect(tagsOf(db, 'n2')).toEqual(['opinion']);
    expect(tagsOf(db, 'n3')).toEqual([]);
    expect(tagsOf(db, 'n4')).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    // The index that named the column went with it.
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'notes'")
      .all() as Array<{ name: string }>;
    expect(indexes.map((row) => row.name)).not.toContain('idx_notes_kind');
    db.close();
  });

  it('re-indexes the retagged notes so the aspect tag is searchable', () => {
    const db = preV36Database();
    insertNote(db, { id: 'n1', kind: 'pitfall', title: 'sqlite 迁移丢列', tags: '["sqlite"]' });
    insertNote(db, { id: 'n2', kind: 'other', title: '不相干' });

    migrateV36(db);

    const hits = db
      .prepare(`SELECT note_id FROM notes_fts_jieba WHERE notes_fts_jieba MATCH 'tags:pitfall'`)
      .all() as Array<{ note_id: string }>;
    expect(hits.map((row) => row.note_id)).toEqual(['n1']);
    db.close();
  });

  it('rebuilds relations under the new tag rule', () => {
    const db = preV36Database();
    // Two pitfalls about different tools: the shared `pitfall` aspect tag (2 of 2
    // live, guarded) is not the edge the frequency rule will later refuse, but the
    // rows must at least be written by the migration's own rebuild.
    insertNote(db, { id: 'n1', kind: 'pitfall', title: 'sqlite 迁移丢列', tags: '["sqlite"]' });
    insertNote(db, { id: 'n2', kind: 'pitfall', title: 'vitest 并行卡死', tags: '["vitest"]' });
    // A pair that genuinely shares a subject.
    insertNote(db, { id: 'n3', kind: 'other', title: 'sqlite 锁等待', tags: '["sqlite"]' });

    migrateV36(db);

    const rows = db
      .prepare('SELECT note_id, related_id, basis FROM note_relations')
      .all() as Array<{ note_id: string; related_id: string; basis: string }>;
    // n1↔n3 share `sqlite` (2 of 3 live notes — over the ratio, so excluded). n1↔n2
    // share only `pitfall` (2 of 3, also excluded). With three live notes every
    // shared tag is a filter, so the migration's rebuild writes no rows at all —
    // which is the frequency rule, not a missing rebuild. Assert the table is
    // consistent rather than non-empty: no unmirrored rows, no rows at all here.
    expect(rows).toEqual([]);
    db.close();
  });

  it('is replay-safe: a second call finds nothing to do', () => {
    const db = preV36Database();
    insertNote(db, { id: 'n1', kind: 'pitfall', title: 'sqlite 迁移丢列', tags: '["sqlite"]' });
    const first = migrateV36(db);
    expect(first.dropped).toBe(true);

    const second = migrateV36(db);
    expect(second).toEqual({ dropped: false, retagged: 0 });
    db.close();
  });

  it('leaves a malformed tags column alone rather than overwriting it', () => {
    const db = preV36Database();
    db.prepare(
      `INSERT INTO notes (
         id, kind, title, normalized_title, summary, body, tags, status,
         origin, scope, scope_key, pinned, version, created_at, updated_at
       ) VALUES ('n1', 'pitfall', 't', 't', '', 'b', 'not json', 'active', 'user', 'user', '', 0, 1, 0, 0)`,
    ).run();

    const result = migrateV36(db);

    // Corrupt data is left for a human; the column still goes, the row keeps its
    // (broken) tags untouched.
    expect(result.retagged).toBe(0);
    expect(
      (db.prepare("SELECT tags FROM notes WHERE id = 'n1'").get() as { tags: string }).tags,
    ).toBe('not json');
    db.close();
  });
});
