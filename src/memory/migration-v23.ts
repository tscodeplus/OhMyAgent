/**
 * Migration v23: the graph projection's link-refusal ledger.
 *
 * `graph-sync`'s batch query (`BATCH_MEMORY_SQL`) calls a memory "unprojected"
 * while no edge carries its id — but the JS gates that actually decide
 * admissibility (`isVouchableEntityName` / `isTokenAlignedMention` /
 * `attestsRelation` / `directionOf`) are invisible to SQL. Memories whose links
 * will never pass were therefore re-scanned on every ~6 h run, and once enough
 * of them filled the batch, later (projectable) memories were starved of slots —
 * the measured pre-K3 extractor left hundreds of such rows behind.
 *
 * The ledger answers "which memories have already been refused under the
 * current rules": one row per memory, written only when the projection evaluated
 * it and every one of its edge-eligible links failed the gates. `graph-sync`
 * then excludes ledgered memories from the batch, so steady-state runs only ever
 * see fresh or rule-changed work. v18's `entity_extraction_log` does this for
 * the extraction model; this is the projector's answer to the same problem.
 *
 * Freshness is three-valued and every consumer checks it in SQL:
 *
 *   - `rule_version` — the gate set's version (see `LINK_REFUSAL_RULE_VERSION`
 *     in `src/graph/entity-mining.ts`). A mismatch makes `graph-sync`'s batch
 *     exclusion miss the row, so the memory is re-evaluated and the row is
 *     rewritten or deleted without any manual purge.
 *   - `decided_at` vs `memories.updated_at` — a memory edited after its refusal
 *     re-enters the batch on the next run. `updated_at` is bumped by every
 *     content change (`memory-writer`, supersede, restore), so an edit re-opens
 *     the row lazily, the way the repository drops v18's ledger row on update.
 *     The content hash is recorded for v18 parity and operator inspection, not
 *     for SQL comparison: SQLite has no sha256.
 *   - `graph:reset` / `legacy-cleanup` deliberately keep these rows — content
 *     and rules did not change, so the same evaluation is guaranteed to reach
 *     the same verdict, and clearing it would only pay for the rescan again.
 *
 * Runs AFTER `applySchema()` like v17/v18 — it is a new table with its own DDL,
 * nothing in `schema.ts` declares it, so there is no column for an upgraded
 * database (or for `CREATE TABLE IF NOT EXISTS`) to be missing.
 */

import type Database from 'better-sqlite3';

export interface MigrateV23Result {
  /** True when this call created the table (false on a re-run). */
  created: boolean;
  /** True when the table carries all required columns after this call. */
  verified: boolean;
}

/** Table name shared with the projector (`graph-sync.ts`, `entity-mining.ts`). */
export const ENTITY_LINK_REFUSALS_TABLE = 'entity_link_refusals';

/** Columns the ledger cannot work without; verified by PRAGMA on every replay. */
const REQUIRED_COLUMNS = ['memory_id', 'content_hash', 'rule_version', 'decided_at'];

export function migrateV23(db: Database.Database): MigrateV23Result {
  const existed = tableExists(db, ENTITY_LINK_REFUSALS_TABLE);
  db.exec(`
    CREATE TABLE IF NOT EXISTS entity_link_refusals (
      memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
      -- sha256 of the memory text the refusal was decided on. Diagnostic only:
      -- content changes are detected through decided_at vs updated_at.
      content_hash TEXT NOT NULL,
      -- Which gate set produced the verdict (LINK_REFUSAL_RULE_VERSION).
      rule_version INTEGER NOT NULL,
      -- Epoch ms when the verdict was written; freshness cue against updated_at.
      decided_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_entity_link_refusals_rule_version
      ON entity_link_refusals(rule_version);
  `);

  // PRAGMA-guarded replay: a table from a hypothetical partial DDL (e.g. an
  // interrupted create) would otherwise sit malformed forever, silently failing
  // the projector's NOT EXISTS clause. Dropping and recreating is the only case
  // in which this migration deletes rows, and it can only trigger when the
  // required columns were never all present — i.e. nothing meaningful to lose.
  const columns = (
    db.prepare(`PRAGMA table_info(${ENTITY_LINK_REFUSALS_TABLE})`).all() as Array<{
      name: string;
    }>
  ).map((row) => row.name);
  const verified = REQUIRED_COLUMNS.every((column) => columns.includes(column));
  if (!verified) {
    db.exec(`DROP TABLE ${ENTITY_LINK_REFUSALS_TABLE}; ${createTableDdl()};`);
  }
  return { created: !existed, verified };
}

function createTableDdl(): string {
  return `
    CREATE TABLE IF NOT EXISTS entity_link_refusals (
      memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
      content_hash TEXT NOT NULL,
      rule_version INTEGER NOT NULL,
      decided_at INTEGER NOT NULL
    )`;
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name);
  return row !== undefined;
}
