/**
 * Migration v32: drop the knowledge-page and entity-graph tables.
 *
 * Both layers were removed from the code — notes replaced the curated pages,
 * and the graph's read surface (routes, `entity_query`, the vault export) went
 * with it. Their tables are the only thing left, and on an install that used
 * either layer they are not empty: a stray `knowledge_pages` row or an
 * `entity_edges` history that nothing reads is dead weight in every backup and
 * every `VACUUM`.
 *
 * Dropping is the honest option here, unlike the graph's own rule that a fact
 * stops being true by closing rather than deleting: `valid_to` exists so
 * *relations between memories* stay answerable, and with no reader there is
 * nobody left to ask. Nothing writes these tables any more, so nothing can
 * recreate what this removes.
 *
 * What is deliberately kept:
 *   - `memories`, `messages`, `sessions`, `episodes`, `memory_sources` and every
 *     FTS/vector index — the layers above them still read those, and
 *     `messages_fts_jieba` (v10) is what `session_search` ranks over.
 *   - `notes` (v31), including `note_sources`, whose citations point at
 *     session/message ids that survive this.
 *
 * Order matters: children before parents, because the connection runs with
 * `foreign_keys = ON` and `DROP TABLE` on a parent first performs an implicit
 * DELETE that can trip the remaining references. `knowledge_fts_jieba` is a
 * standalone FTS5 table, so dropping it takes its shadow tables with it.
 *
 * Idempotent by construction: every statement is `DROP TABLE IF EXISTS`, so a
 * re-run drops nothing and reports an empty list. A fresh install never creates
 * these tables (`migration-v10` no longer declares the entity ones, and the
 * knowledge ones lost their only creator when their migrations were removed),
 * so it finds nothing to do.
 */

import type Database from 'better-sqlite3';
import { createLogger } from '../app/logger.js';

const logger = createLogger();

export interface MigrateV32Result {
  /** Tables this call actually dropped (empty on a re-run). */
  dropped: string[];
}

/**
 * Children first, then parents. `knowledge_sources`/`knowledge_links` cite
 * `knowledge_pages`; `entity_edges`/`entity_aliases` cite `entities`;
 * `entity_edges.source_memory_id` cites `memory_links`' siblings in `memories`.
 */
const DROP_ORDER = [
  // knowledge layer (v14 and its widenings)
  'knowledge_fts_jieba',
  'knowledge_sources',
  'knowledge_links',
  'knowledge_log',
  'knowledge_pages',
  // entity graph (v10 + the ledgers/derived tables v18/v23/v27 added)
  'entity_edges',
  'entity_aliases',
  'entity_extraction_log',
  'entity_link_refusals',
  'entity_components',
  'entity_graph_metrics',
  'entities',
  // the projection's input: one row per asserted relation, written by the
  // extractor that no longer runs
  'memory_links',
] as const;

export function migrateV32(db: Database.Database): MigrateV32Result {
  const exists = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?");
  const dropped: string[] = [];

  for (const table of DROP_ORDER) {
    if (!exists.get(table)) continue;
    db.exec(`DROP TABLE IF EXISTS ${table}`);
    dropped.push(table);
  }

  if (dropped.length > 0) {
    logger.info(`[V32] Dropped retired knowledge/graph tables: ${dropped.join(', ')}`);
  }
  return { dropped };
}
