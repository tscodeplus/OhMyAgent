/**
 * Migration v31 — the notes tables (MyDocs/NOTES_LAYER_PLAN.md §4).
 *
 * A new table set, not an extension of `knowledge_pages`: the producer, the
 * admission rule and the unit of content all differ (§1), and widening
 * `knowledge_pages` would have meant every knowledge reader learning about
 * drafts. So `notes` is a separate layer and `knowledge` stays as it is.
 *
 * Registered **after** `applySchema()` — `schema.ts` owns no DDL for these
 * tables, so the "column-adding migration must run before applySchema" trap
 * (see `db.ts`) never applies here. Every statement is `IF NOT EXISTS`, so a
 * replay on an already-migrated database does nothing.
 *
 * Timestamps are INTEGER epoch-ms, unlike the older `memories` TEXT columns:
 * v15 established that convention and there is no reason to inherit the
 * `parseEpochMs` readability trap in a table created today.
 *
 * `notes_fts_jieba` is a **standalone** FTS5 table whose indexed columns hold
 * jieba-segmented text — the same shape `memories_fts_jieba` and
 * `knowledge_fts_jieba` use, because the bundled SQLite has no `jieba`
 * tokenizer module (a `tokenize='jieba'` table would simply fail to open).
 * Standalone means no uniqueness constraint, so every write is
 * delete-by-`note_id`-then-insert (see `indexer.ts`).
 */

import type Database from 'better-sqlite3';

export interface MigrateV31Result {
  created: boolean;
}

const NOTES_DDL = `
CREATE TABLE IF NOT EXISTS notes (
  id                TEXT PRIMARY KEY,
  kind              TEXT NOT NULL,
  title             TEXT NOT NULL,
  normalized_title  TEXT NOT NULL,
  summary           TEXT NOT NULL,
  body              TEXT NOT NULL,
  fields            TEXT,
  tags              TEXT,
  status            TEXT NOT NULL,
  status_reason     TEXT,
  origin            TEXT NOT NULL,
  scope             TEXT NOT NULL,
  scope_key         TEXT NOT NULL DEFAULT '',
  session_id        TEXT,
  channel           TEXT,
  pinned            INTEGER NOT NULL DEFAULT 0,
  confidence        REAL,
  version           INTEGER NOT NULL DEFAULT 1,
  capture_id        TEXT,
  superseded_by     TEXT,
  view_count        INTEGER NOT NULL DEFAULT 0,
  last_viewed_at    INTEGER,
  reviewed_by       TEXT,
  reviewed_at       INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
)`;

/**
 * "One subject, one active note per scope" — enforced by a partial index so
 * drafts and archived rows do not participate: retitling an archived note must
 * not collide with the active one that replaced it.
 */
const NOTES_INDEXES = [
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_notes_title_scope
     ON notes(normalized_title, scope, scope_key) WHERE status = 'active'`,
  `CREATE INDEX IF NOT EXISTS idx_notes_status_updated ON notes(status, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_notes_scope ON notes(scope, scope_key, status)`,
  `CREATE INDEX IF NOT EXISTS idx_notes_kind ON notes(kind)`,
];

/**
 * Evidence for a note. Soft references on purpose (§4.2-10): deleting a session
 * must not delete the notes distilled from it, so there is no foreign key to
 * `messages`/`sessions` — only to the note itself, where cascade is correct.
 */
const SOURCES_DDL = `
CREATE TABLE IF NOT EXISTS note_sources (
  note_id   TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  kind      TEXT NOT NULL,
  source_id TEXT NOT NULL,
  excerpt   TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (note_id, kind, source_id)
)`;

/** One row per capture attempt: the window, the model, the outcome. */
const CAPTURE_RUNS_DDL = `
CREATE TABLE IF NOT EXISTS capture_runs (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL,
  scope       TEXT NOT NULL,
  mode        TEXT NOT NULL,
  message_ids TEXT NOT NULL,
  token_est   INTEGER NOT NULL,
  model_ref   TEXT,
  status      TEXT NOT NULL,
  error       TEXT,
  note_count  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
)`;

/** Append-only: grows with writes, not with notes, and is pruned by hygiene. */
const EVENTS_DDL = `
CREATE TABLE IF NOT EXISTS note_events (
  id         TEXT PRIMARY KEY,
  note_id    TEXT NOT NULL,
  action     TEXT NOT NULL,
  actor      TEXT NOT NULL,
  detail     TEXT,
  created_at INTEGER NOT NULL
)`;

/**
 * Weak relations between notes. Empty in M1 — `related` computation is M4 —
 * but the table exists so the contract does not change shape later.
 */
const RELATIONS_DDL = `
CREATE TABLE IF NOT EXISTS note_relations (
  note_id    TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  related_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  score      REAL NOT NULL,
  origin     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (note_id, related_id)
)`;

/**
 * Standalone FTS5. Indexed columns hold jieba-segmented text; `tags` holds
 * **user tags ∪ facet tokens** (origin / channel / project name), which is what
 * makes "search 飞书" find the notes that came from Feishu without storing a
 * facet in the `tags` column (§4.6).
 */
const FTS_DDL = `
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts_jieba USING fts5(
  title,
  summary,
  body,
  tags,
  note_id UNINDEXED,
  status UNINDEXED,
  scope UNINDEXED,
  scope_key UNINDEXED
)`;

export function migrateV31(db: Database.Database): MigrateV31Result {
  const existing = db
    .prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ?')
    .get('table', 'notes') as { name: string } | undefined;

  db.exec(NOTES_DDL);
  for (const statement of NOTES_INDEXES) db.exec(statement);
  db.exec(SOURCES_DDL);
  db.exec(CAPTURE_RUNS_DDL);
  db.exec(EVENTS_DDL);
  db.exec(RELATIONS_DDL);
  db.exec(FTS_DDL);

  return { created: !existing };
}
