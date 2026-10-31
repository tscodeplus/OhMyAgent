/**
 * Migration v10: the jieba-segmented FTS5 index for `messages`.
 *
 * `messages_fts_jieba` is what `session_search` and the conversation lane of
 * `/api/search` rank over: the default unicode61 tokenizer splits CJK nowhere,
 * so a jieba-segmented copy of the text is the only way "上次那个方案" matches a
 * sentence that never repeats it verbatim. The tokens are space-joined into
 * `content`, and the raw text rides along in `content_original` so results need
 * no JOIN to be assembled.
 *
 * The index used to share this module with the entity tables (`entities`,
 * `entity_aliases`, `entity_edges`); those went with the graph, and `v32` drops
 * them from a database that still has them.
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

  backfillMessagesFts(db);

  if (created.length > 0) {
    logger.info(`[migration-v10] Created: ${created.join(', ')}`);
  }
  return { created };
}
