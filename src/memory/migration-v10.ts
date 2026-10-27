/**
 * Migration v10: knowledge-graph data layer.
 *
 * Adds three tables — `entities`, `entity_aliases`, `entity_edges` — plus the
 * jieba-segmented FTS5 index for `messages` (`messages_fts_jieba`).
 *
 * Timestamps of the NEW tables are INTEGER epoch-milliseconds, not the TEXT
 * digit-string columns the older tables carry. `entities`/`entity_edges` are
 * new, so there is no legacy writer to stay compatible with, and INTEGER keeps
 * the temporal predicates (`valid_to IS NULL OR valid_to > :asOf`) as plain
 * integer comparisons — no `parseEpochMs` round-trip, no 'YYYY-MM-DD' rows left
 * behind by older DEFAULTs. Rows are written by `EntityRepository` with
 * `Date.now()`.
 *
 * Temporal model: a statement is never deleted when it stops being true — the
 * edge's `valid_to` is set (see `EntityRepository.retractEdge`). The row keeps
 * `valid_from`/`valid_to`, so "what was true in June" stays answerable: filter
 * `valid_from <= asOf AND (valid_to IS NULL OR valid_to > asOf)`. Deleting
 * would erase the retraction itself and make the history unanswerable.
 *
 * Idempotent: every statement is `CREATE ... IF NOT EXISTS`, so this runs on
 * every startup and reports what it actually created.
 */

import type Database from 'better-sqlite3';
import { createLogger } from '../app/logger.js';
import { isJiebaAvailable, tokenizeForIndex } from './fts-tokenizer.js';

const logger = createLogger();

export interface MigrateV10Result {
  /** Names of the tables/indexes this call created (empty on a re-run). */
  created: string[];
}

const DDL_ENTITIES = `
CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  description TEXT,
  created_at INTEGER,
  updated_at INTEGER,
  UNIQUE(canonical_name, entity_type)
)`;

const DDL_ENTITY_ALIASES = `
CREATE TABLE IF NOT EXISTS entity_aliases (
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  source TEXT,
  created_at INTEGER,
  PRIMARY KEY(entity_id, alias)
)`;

const DDL_ENTITY_EDGES = `
CREATE TABLE IF NOT EXISTS entity_edges (
  id TEXT PRIMARY KEY,
  source_entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  target_entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  source_memory_id TEXT,
  source_message_id TEXT,
  valid_from INTEGER,
  valid_to INTEGER,
  created_at INTEGER
)`;

// Mirrors DDL_MEMORIES_FTS_JIEBA in schema.ts exactly: a standalone FTS5 table
// (no external content, no `tokenize=` override — the default unicode61 splits
// the space-joined jieba tokens) with UNINDEXED metadata columns for result
// assembly without a JOIN.
const DDL_MESSAGES_FTS_JIEBA = `
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts_jieba USING fts5(
  content,                        -- jieba-segmented text (for indexing)
  content_original UNINDEXED,     -- raw original text (for display)
  message_id UNINDEXED,           -- FK to messages.id
  session_id UNINDEXED,           -- messages.session_id
  role UNINDEXED,                 -- 'user' | 'assistant' | 'tool'
  created_at UNINDEXED            -- epoch ms timestamp
)`;

interface SchemaObject {
  kind: 'table' | 'index';
  name: string;
  ddl: string;
}

const V10_OBJECTS: SchemaObject[] = [
  { kind: 'table', name: 'entities', ddl: DDL_ENTITIES },
  { kind: 'table', name: 'entity_aliases', ddl: DDL_ENTITY_ALIASES },
  {
    kind: 'index',
    name: 'idx_entity_aliases_alias',
    ddl: 'CREATE INDEX IF NOT EXISTS idx_entity_aliases_alias ON entity_aliases(alias)',
  },
  { kind: 'table', name: 'entity_edges', ddl: DDL_ENTITY_EDGES },
  {
    kind: 'index',
    name: 'idx_entity_edges_source_relation',
    ddl: 'CREATE INDEX IF NOT EXISTS idx_entity_edges_source_relation ON entity_edges(source_entity_id, relation_type)',
  },
  {
    kind: 'index',
    name: 'idx_entity_edges_target_relation',
    ddl: 'CREATE INDEX IF NOT EXISTS idx_entity_edges_target_relation ON entity_edges(target_entity_id, relation_type)',
  },
  {
    kind: 'index',
    name: 'idx_entity_edges_source_memory',
    ddl: 'CREATE INDEX IF NOT EXISTS idx_entity_edges_source_memory ON entity_edges(source_memory_id)',
  },
  { kind: 'table', name: 'messages_fts_jieba', ddl: DDL_MESSAGES_FTS_JIEBA },
];

function schemaObjectExists(db: Database.Database, kind: 'table' | 'index', name: string): boolean {
  return (
    db.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get(kind, name) !==
    undefined
  );
}

/**
 * Populate `messages_fts_jieba` from `messages` when the index is empty.
 *
 * Guarded by a COUNT so a populated index is never re-inserted (FTS5 has no
 * unique constraint, so duplicates would skew BM25), and wrapped in try/catch:
 * a database whose jieba dictionary/extension is unavailable must still boot —
 * message search then simply stays on the unicode61 `memories_fts` path.
 *
 * @returns number of messages indexed.
 */
function backfillMessagesFts(db: Database.Database): number {
  try {
    const indexed = (
      db.prepare('SELECT COUNT(*) AS cnt FROM messages_fts_jieba').get() as {
        cnt: number;
      }
    ).cnt;
    if (indexed > 0) return 0;

    const total = (db.prepare('SELECT COUNT(*) AS cnt FROM messages').get() as { cnt: number }).cnt;
    if (total === 0) return 0;

    const rows = db
      .prepare('SELECT id, session_id, role, content, created_at FROM messages')
      .all() as Array<{
      id: string;
      session_id: string;
      role: string;
      content: string;
      created_at: string | number | null;
    }>;

    const insert = db.prepare(`
      INSERT INTO messages_fts_jieba (content, content_original, message_id, session_id, role, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    let written = 0;
    db.transaction(() => {
      for (const row of rows) {
        insert.run(
          tokenizeForIndex(row.content),
          row.content,
          row.id,
          row.session_id,
          row.role,
          row.created_at,
        );
        written++;
      }
    })();

    if (!isJiebaAvailable()) {
      // Not fatal: unicode61 still indexes the raw text — but Chinese recall is
      // materially worse without jieba segmentation, so say it out loud.
      logger.warn(
        '[migration-v10] jieba tokenizer unavailable — messages_fts_jieba indexed with plain fts5 (unicode61)',
      );
    }
    logger.info(`[migration-v10] Backfilled messages_fts_jieba (${written} rows)`);
    return written;
  } catch (err) {
    // A database that predates `messages`, or one without the jieba
    // dictionary, must still boot: message search stays on the existing index.
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      '[migration-v10] messages_fts_jieba backfill skipped (messages table or jieba unavailable)',
    );
    return 0;
  }
}

/**
 * Apply the v10 schema. Safe to call on every startup.
 */
export function migrateV10(db: Database.Database): MigrateV10Result {
  const created: string[] = [];

  for (const object of V10_OBJECTS) {
    const existed = schemaObjectExists(db, object.kind, object.name);
    db.exec(object.ddl);
    if (!existed) created.push(object.name);
  }

  // ON DELETE CASCADE above only fires when the connection has FK enforcement
  // on. openDatabase() sets `foreign_keys = ON`; a connection opened directly
  // with `new Database(...)` (tests, scripts) defaults to OFF and would leave
  // orphaned aliases/edges behind.
  if (db.pragma('foreign_keys', { simple: true }) !== 1) {
    logger.warn(
      '[migration-v10] PRAGMA foreign_keys is OFF on this connection — entity_aliases/entity_edges ON DELETE CASCADE will not fire',
    );
  }

  backfillMessagesFts(db);

  if (created.length > 0) {
    logger.info(`[migration-v10] Created: ${created.join(', ')}`);
  }
  return { created };
}
