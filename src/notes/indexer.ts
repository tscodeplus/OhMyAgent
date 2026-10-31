/**
 * `notes_fts_jieba` maintenance and search.
 *
 * Two rules, both consequences of the table being a *standalone* FTS5 index
 * (not external-content — see `migration-v31.ts`):
 *
 * 1. **A write is DELETE by `note_id`, then INSERT.** FTS5 has no uniqueness
 *    constraint, so an INSERT-only update leaves the previous body searchable —
 *    the same discipline `memory/fts.ts` and `memory/knowledge/indexer.ts` apply.
 * 2. **Status and scope are indexed as UNINDEXED columns.** Reads filter in SQL
 *    rather than after the fact, so a draft never consumes a result slot and a
 *    note outside the caller's scope is never briefly visible.
 *
 * Indexed columns hold jieba-segmented text: the bundled SQLite has no `jieba`
 * tokenizer module, so segmentation happens here via `fts-tokenizer.ts` and the
 * default `unicode61` tokenizer treats each segment as a word. There is
 * deliberately no second jieba path.
 */

import type Database from 'better-sqlite3';
import { buildFtsQuery, tokenizeForIndex } from '../memory/fts-tokenizer.js';
import type { NoteStatus } from './types.js';

export interface NoteIndexable {
  id: string;
  status: NoteStatus;
  scope: string;
  scopeKey: string;
  title: string;
  summary: string;
  body: string;
  /** `user tags ∪ facet tokens` — see `facets.ts`. */
  indexTags: string[];
}

/** Replace one note's index row. Always called inside the note write's transaction. */
export function indexNote(db: Database.Database, note: NoteIndexable): void {
  db.prepare('DELETE FROM notes_fts_jieba WHERE note_id = ?').run(note.id);
  db.prepare(
    `INSERT INTO notes_fts_jieba (title, summary, body, tags, note_id, status, scope, scope_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    tokenizeForIndex(note.title),
    tokenizeForIndex(note.summary),
    tokenizeForIndex(note.body),
    tokenizeForIndex(note.indexTags.join(' ')),
    note.id,
    note.status,
    note.scope,
    note.scopeKey,
  );
}

/**
 * Column weights for `bm25()`.
 *
 * Order matches the table's indexed column order (title, summary, body, tags).
 * A hit in the title is worth far more than a hit in the body — the title is the
 * subject, and a library is searched by subject first.
 */
const BM25_WEIGHTS = '3.0, 2.0, 1.0, 1.5';

export interface NoteSearchOptions {
  query: string;
  status: NoteStatus;
  /** Extra SQL predicate on `notes_fts_jieba` (scope filter), pre-built. */
  scopeSql?: { sql: string; params: string[] } | null;
  limit?: number;
}

/**
 * Ids of matching notes, best first.
 *
 * Returns ids only: the caller has to join back to `notes` anyway (for the
 * authoritative body, tags and timestamps), and returning index rows here would
 * make it tempting to render stale indexed text.
 */
export function searchNoteIds(db: Database.Database, options: NoteSearchOptions): string[] {
  const match = buildFtsQuery(options.query);
  if (!match) return [];

  // The scope predicate is written against the FTS table (hence `alias`).
  const scope = options.scopeSql;
  const where = [`notes_fts_jieba MATCH ?`, 'status = ?'];
  const params: unknown[] = [match, options.status];
  if (scope) {
    where.push(scope.sql.replace(/\bn\./g, ''));
    params.push(...scope.params);
  }
  params.push(Math.max(1, Math.min(options.limit ?? 50, 200)));

  const rows = db
    .prepare(
      `SELECT note_id FROM notes_fts_jieba
        WHERE ${where.join(' AND ')}
        ORDER BY bm25(notes_fts_jieba, ${BM25_WEIGHTS})
        LIMIT ?`,
    )
    .all(...params) as Array<{ note_id: string }>;
  return rows.map((row) => row.note_id);
}

/** Index/pages drift, checked by `pnpm notes:reindex --check` (M4). */
export interface NoteIndexConsistency {
  missing: string[];
  orphaned: string[];
}

export function checkNoteIndex(db: Database.Database): NoteIndexConsistency {
  const missing = (
    db
      .prepare(
        `SELECT n.id FROM notes n
          WHERE NOT EXISTS (SELECT 1 FROM notes_fts_jieba f WHERE f.note_id = n.id)`,
      )
      .all() as Array<{ id: string }>
  ).map((row) => row.id);
  const orphaned = (
    db
      .prepare(
        `SELECT DISTINCT f.note_id AS id FROM notes_fts_jieba f
          WHERE NOT EXISTS (SELECT 1 FROM notes n WHERE n.id = f.note_id)`,
      )
      .all() as Array<{ id: string }>
  ).map((row) => row.id);
  return { missing, orphaned };
}
