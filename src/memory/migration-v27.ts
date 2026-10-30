/**
 * Migration v27: the derived numbers the graph reads are now stored, not recomputed.
 *
 * Two read paths were quadratic in the corpus, both measured on the device:
 * `loadOverview`'s seed ranking was 43 ms of a 55 ms request (one `memory_links` scan
 * *per entity*), and `/stats` read every entity and every edge into JavaScript and ran
 * union-find on each request — while the graph tab fetches it on every mount. Neither is
 * a drawing problem; both are "computed from the whole graph, per request" problems, and
 * the fix the plan chose is to compute them where the graph is already being walked: the
 * `graph_sync` maintenance job.
 *
 * Two tables rather than columns on `entities`:
 *
 *   - a column-adding migration must run BEFORE `applySchema()`, or `schema.ts`'s index
 *     DDL throws on an upgraded database and the exception escapes `openDatabase()`,
 *     killing bootstrap (the trap `db.ts` still carries a comment about);
 *   - these are a derived view of `entity_edges`, and the graph layer's whole design is
 *     "derived, never authored" — a separate table with a `computed_at` says that out
 *     loud, and dropping it is safe by construction.
 *
 * `degree_live` exists beside `degree_total` on purpose: the drawing's node radius and
 * the roster's degree count every incident edge including retracted ones, while
 * "isolated" means nothing can be drawn for it, which is a live-edge question. Storing
 * one number and deriving the other would make the two disagree the first time a fact is
 * retracted.
 *
 * Runs AFTER `applySchema` like the new-table migrations v10/v14: nothing here is declared
 * by `schema.ts`, and `IF NOT EXISTS` keeps the replay (this runs on every open) free.
 */

import type Database from 'better-sqlite3';

export interface MigrateV27Result {
  createdTables: string[];
  createdIndexes: string[];
}

const METRICS_TABLE = 'entity_graph_metrics';
const COMPONENTS_TABLE = 'entity_components';

/**
 * The rank index mirrors the overview's ORDER BY, so the seed query becomes an index
 * scan of `budget` rows instead of a sort of the whole table.
 */
const DDL_METRICS = `
CREATE TABLE IF NOT EXISTS ${METRICS_TABLE} (
  entity_id     TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
  degree_out    INTEGER NOT NULL DEFAULT 0,
  degree_in     INTEGER NOT NULL DEFAULT 0,
  degree_total  INTEGER NOT NULL DEFAULT 0,
  degree_live   INTEGER NOT NULL DEFAULT 0,
  mention_count INTEGER NOT NULL DEFAULT 0,
  computed_at   INTEGER NOT NULL
)`;

const DDL_METRICS_RANK = `
CREATE INDEX IF NOT EXISTS idx_entity_graph_metrics_rank
  ON ${METRICS_TABLE}(degree_total DESC, mention_count DESC)`;

const DDL_COMPONENTS = `
CREATE TABLE IF NOT EXISTS ${COMPONENTS_TABLE} (
  entity_id      TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
  component_id   TEXT NOT NULL,
  component_size INTEGER NOT NULL,
  computed_at    INTEGER NOT NULL
)`;

const DDL_COMPONENTS_RANK = `
CREATE INDEX IF NOT EXISTS idx_entity_components_size
  ON ${COMPONENTS_TABLE}(component_size DESC, component_id)`;

/**
 * Membership lookup, which the rank index cannot serve: its leading column is
 * `component_size`, and every "who is in this component" question filters on
 * `component_id` ("what is the member preview", "how many open edges are inside").
 * Without this, listing twenty components scanned the whole table twenty times.
 */
const DDL_COMPONENTS_MEMBER = `
CREATE INDEX IF NOT EXISTS idx_entity_components_member
  ON ${COMPONENTS_TABLE}(component_id)`;

function tableExists(db: Database.Database, table: string): boolean {
  const row = db
    .prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ?')
    .get('table', table) as { name: string } | undefined;
  return row !== undefined;
}

export function migrateV27(db: Database.Database): MigrateV27Result {
  const createdTables: string[] = [];
  const createdIndexes: string[] = [];
  // Without `entities` there is nothing to reference, and the foreign keys here would
  // make the CREATE fail rather than degrade — a pre-v10 database gets nothing.
  if (!tableExists(db, 'entities')) return { createdTables, createdIndexes };

  db.exec(DDL_METRICS);
  createdTables.push(METRICS_TABLE);
  db.exec(DDL_COMPONENTS);
  createdTables.push(COMPONENTS_TABLE);

  db.exec(DDL_METRICS_RANK);
  createdIndexes.push('idx_entity_graph_metrics_rank');
  db.exec(DDL_COMPONENTS_RANK);
  createdIndexes.push('idx_entity_components_size');
  db.exec(DDL_COMPONENTS_MEMBER);
  createdIndexes.push('idx_entity_components_member');

  return { createdTables, createdIndexes };
}
