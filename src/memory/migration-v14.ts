/**
 * Migration v14: the knowledge layer — `knowledge_pages` and its companions.
 *
 * A knowledge page is the curation unit: an entity / project / topic / decision
 * / snippet with a markdown body, an explicit `page_type` and explicit sources.
 * Relations are page-to-page links, so the graph is a table join instead of a
 * markdown parser, and the three problems the old graph could not solve (entity
 * resolution, subject attribution, type inference) never arise — nothing is
 * guessed at projection time because the author named it at write time.
 *
 * Tables:
 *   knowledge_pages    the page itself (content is markdown, incl. [[wikilinks]])
 *   knowledge_sources  provenance: which memories/messages/sessions a page cites
 *   knowledge_links    parsed [[wikilink]] edges between pages
 *   knowledge_log      append-only change log (needs a retention policy —
 *                      it grows with write count, not page count)
 *   knowledge_fts_jieba standalone jieba-segmented FTS5 index over page bodies
 *
 * `page_type` is deliberately not called `scope`: `memories.scope` already
 * holds user/project/session/system, and two same-named columns with different
 * meanings in one database is a pure reading trap.
 *
 * `status = 'active'` is a hard filter for every reader (search, get, per-turn
 * injection, link resolution, export); 'pending' rows (curation in shadow mode)
 * are visible only from the WebUI pending list. `version` carries the optimistic
 * concurrency the old design expressed as `expectedHash`: an update must pass
 * the version it read, otherwise it is refused and the caller re-reads.
 *
 * Timestamps are INTEGER epoch-milliseconds (`Date.now()`), not the TEXT
 * digit-string default the legacy tables carry — the same rule migration-v10
 * set. Nothing legacy reads these tables, so there is no format to stay
 * compatible with.
 *
 * The FTS table is standalone (not external-content): writes MUST be
 * "DELETE WHERE page_id = ? then INSERT", as in `fts.ts` for messages. An
 * INSERT-only update path would leave both the old and the new body in the
 * index (FTS5 has no unique constraint) and `knowledge_search` would return
 * superseded text.
 *
 * Runs AFTER applySchema (like v10): the whole layer is new tables, so there is
 * no column for schema.ts to reference. Nothing reads these tables unless the
 * knowledge layer is used, so an install that ignores it pays only the DDL.
 *
 * Idempotent: every statement is `CREATE ... IF NOT EXISTS`, so this runs on
 * every startup and reports only what it actually created.
 */

import type Database from 'better-sqlite3';
import { createLogger } from '../app/logger.js';

const logger = createLogger();

export interface MigrateV14Result {
  /** Tables/indexes this call created (empty on a re-run). */
  created: string[];
}

const DDL_KNOWLEDGE_PAGES = `
CREATE TABLE IF NOT EXISTS knowledge_pages (
  id TEXT PRIMARY KEY,
  page_type TEXT NOT NULL,          -- 'entity'|'project'|'topic'|'decision'|'snippet'
  slug TEXT NOT NULL,               -- 'power-query'
  title TEXT NOT NULL,
  content TEXT NOT NULL,            -- markdown body (incl. [[wikilink]])
  aliases TEXT,                     -- JSON array
  tags TEXT,                        -- JSON array
  confidence REAL,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active', -- 'active'|'pending'|'archived'
  created_at INTEGER, updated_at INTEGER,
  updated_by TEXT                   -- 'agent'|'user'|'import'
)`;

const DDL_KNOWLEDGE_SOURCES = `
CREATE TABLE IF NOT EXISTS knowledge_sources (
  page_id TEXT NOT NULL REFERENCES knowledge_pages(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL,        -- 'memory'|'message'|'session'
  source_id TEXT NOT NULL,
  created_at INTEGER,
  PRIMARY KEY (page_id, source_kind, source_id)
)`;

const DDL_KNOWLEDGE_LINKS = `
CREATE TABLE IF NOT EXISTS knowledge_links (
  from_page_id TEXT NOT NULL REFERENCES knowledge_pages(id) ON DELETE CASCADE,
  to_page_id TEXT NOT NULL REFERENCES knowledge_pages(id) ON DELETE CASCADE,
  label TEXT,
  created_at INTEGER,
  PRIMARY KEY (from_page_id, to_page_id)
)`;

const DDL_KNOWLEDGE_LOG = `
CREATE TABLE IF NOT EXISTS knowledge_log (
  id TEXT PRIMARY KEY,
  page_id TEXT,
  action TEXT NOT NULL,             -- 'create'|'update'|'link'|'pending'|'merge'
  actor TEXT NOT NULL,              -- 'agent'|'user'|'system'
  version INTEGER,
  reason TEXT,
  created_at INTEGER NOT NULL
)`;

// Mirrors DDL_MESSAGES_FTS_JIEBA in migration-v10.ts: a standalone FTS5 table
// (no external content, no `tokenize=` override — the default unicode61 splits
// the space-joined jieba tokens) with UNINDEXED metadata columns so search
// results can be assembled without a JOIN back to knowledge_pages.
const DDL_KNOWLEDGE_FTS_JIEBA = `
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts_jieba USING fts5(
  content,                        -- jieba-segmented body (for indexing)
  content_original UNINDEXED,     -- raw markdown (for display/export)
  page_id UNINDEXED,
  title UNINDEXED,
  page_type UNINDEXED
)`;

interface SchemaObject {
  kind: 'table' | 'index';
  name: string;
  ddl: string;
}

const V14_OBJECTS: SchemaObject[] = [
  { kind: 'table', name: 'knowledge_pages', ddl: DDL_KNOWLEDGE_PAGES },
  {
    kind: 'index',
    name: 'idx_knowledge_pages_slug',
    ddl: 'CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_pages_slug ON knowledge_pages(page_type, slug)',
  },
  // Listing a page type newest-first, which is what the WebUI page list does.
  {
    kind: 'index',
    name: 'idx_knowledge_pages_tag',
    ddl: 'CREATE INDEX IF NOT EXISTS idx_knowledge_pages_tag ON knowledge_pages(updated_at DESC)',
  },
  { kind: 'table', name: 'knowledge_sources', ddl: DDL_KNOWLEDGE_SOURCES },
  // Reads are "which pages cite this memory/message" — the reverse of the PK.
  {
    kind: 'index',
    name: 'idx_knowledge_sources_lookup',
    ddl: 'CREATE INDEX IF NOT EXISTS idx_knowledge_sources_lookup ON knowledge_sources(source_kind, source_id)',
  },
  { kind: 'table', name: 'knowledge_links', ddl: DDL_KNOWLEDGE_LINKS },
  { kind: 'table', name: 'knowledge_log', ddl: DDL_KNOWLEDGE_LOG },
  {
    kind: 'index',
    name: 'idx_knowledge_log_page',
    ddl: 'CREATE INDEX IF NOT EXISTS idx_knowledge_log_page ON knowledge_log(page_id, created_at DESC)',
  },
  { kind: 'table', name: 'knowledge_fts_jieba', ddl: DDL_KNOWLEDGE_FTS_JIEBA },
];

function schemaObjectExists(db: Database.Database, kind: 'table' | 'index', name: string): boolean {
  return (
    db.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get(kind, name) !==
    undefined
  );
}

/**
 * Apply the v14 schema. Safe to call on every startup.
 */
export function migrateV14(db: Database.Database): MigrateV14Result {
  const created: string[] = [];

  for (const object of V14_OBJECTS) {
    const existed = schemaObjectExists(db, object.kind, object.name);
    db.exec(object.ddl);
    if (!existed) created.push(object.name);
  }

  // ON DELETE CASCADE on knowledge_sources / knowledge_links only fires when FK
  // enforcement is on for this connection. openDatabase() sets it; a connection
  // opened directly with `new Database(...)` (tests, scripts) defaults to OFF
  // and would leave sources and links behind after a page is deleted.
  if (db.pragma('foreign_keys', { simple: true }) !== 1) {
    logger.warn(
      '[migration-v14] PRAGMA foreign_keys is OFF on this connection — knowledge_sources/knowledge_links ON DELETE CASCADE will not fire',
    );
  }

  if (created.length > 0) {
    logger.info(`[migration-v14] Created: ${created.join(', ')}`);
  }

  return { created };
}
