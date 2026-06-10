/**
 * Migration v5: Convert TEXT timestamps to INTEGER milliseconds (UTC).
 *
 * Previously, timestamp columns used TEXT NOT NULL DEFAULT (datetime('now'))
 * which produces "YYYY-MM-DD HH:MM:SS" strings. This migration converts all
 * existing TEXT timestamps to epoch milliseconds (UTC) for:
 * - Deterministic ordering without rowid tiebreakers
 * - Explicit UTC semantics (no timezone ambiguity)
 * - Faster integer comparisons
 *
 * New DEFAULT: (cast(strftime('%s','now') as integer) * 1000)
 *
 * Conversion: strftime('%s', <text>) gives UTC epoch seconds → * 1000 = ms
 */

import type Database from 'better-sqlite3';

/**
 * Convert a TEXT timestamp column to INTEGER milliseconds in-place.
 * Only converts rows with the OLD datetime format ('YYYY-MM-DD HH:MM:SS')
 * to avoid re-converting already-migrated numeric values.
 * Skips NULL values for nullable columns.
 *
 * Uses `created_at LIKE '%-%'` to distinguish old datetime strings from
 * new millisecond strings — TEXT affinity stores both as text, but only
 * the old format contains hyphens.
 */
function convertColumn(
  db: Database.Database,
  table: string,
  column: string,
  nullable: boolean,
): number {
  const tableCheck = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
  ).get(table);
  if (!tableCheck) return 0;

  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some(c => c.name === column)) return 0;

  const nullClause = nullable ? '' : `AND ${column} IS NOT NULL`;
  // Only convert old datetime strings (contain hyphens: 'YYYY-MM-DD HH:MM:SS').
  // New millisecond strings ('1780796411000') don't contain hyphens and must
  // be skipped — strftime('%s', '1780796411000') returns NULL.
  const result = db.prepare(`
    UPDATE ${table}
    SET ${column} = cast(strftime('%s', ${column}) as integer) * 1000
    WHERE ${column} LIKE '%-%'${nullClause}
  `).run();
  return result.changes;
}

export function migrateV5(db: Database.Database): void {
  let total = 0;

  // sessions
  total += convertColumn(db, 'sessions', 'created_at', false);
  total += convertColumn(db, 'sessions', 'updated_at', false);

  // messages
  total += convertColumn(db, 'messages', 'created_at', false);

  // processed_messages
  total += convertColumn(db, 'processed_messages', 'processed_at', false);

  // episodes
  total += convertColumn(db, 'episodes', 'created_at', false);

  // memories (invalidated_at is nullable)
  total += convertColumn(db, 'memories', 'created_at', false);
  total += convertColumn(db, 'memories', 'updated_at', false);
  total += convertColumn(db, 'memories', 'invalidated_at', true);

  // memory_embeddings
  total += convertColumn(db, 'memory_embeddings', 'created_at', false);

  // embedding_cache
  total += convertColumn(db, 'embedding_cache', 'created_at', false);

  // tool_runs
  total += convertColumn(db, 'tool_runs', 'created_at', false);

  // approval_policies
  total += convertColumn(db, 'approval_policies', 'created_at', false);
  total += convertColumn(db, 'approval_policies', 'updated_at', false);

  // approval_requests (expires_at is nullable)
  total += convertColumn(db, 'approval_requests', 'created_at', false);
  total += convertColumn(db, 'approval_requests', 'updated_at', false);
  total += convertColumn(db, 'approval_requests', 'expires_at', true);

  // approval_decisions
  total += convertColumn(db, 'approval_decisions', 'created_at', false);

  // memory_links
  total += convertColumn(db, 'memory_links', 'created_at', false);

  // persona_distillation_runs (finished_at is nullable)
  total += convertColumn(db, 'persona_distillation_runs', 'started_at', false);
  total += convertColumn(db, 'persona_distillation_runs', 'finished_at', true);

  // maintenance_runs (finished_at is nullable)
  total += convertColumn(db, 'maintenance_runs', 'started_at', false);
  total += convertColumn(db, 'maintenance_runs', 'finished_at', true);

  // memory_observation_events
  total += convertColumn(db, 'memory_observation_events', 'created_at', false);

  // memory_terms
  total += convertColumn(db, 'memory_terms', 'created_at', false);

  // schema_version
  total += convertColumn(db, 'schema_version', 'applied_at', false);

  // projects
  total += convertColumn(db, 'projects', 'created_at', false);
  total += convertColumn(db, 'projects', 'updated_at', false);

  console.log(`[migration-v5] Converted ${total} TEXT timestamps to INTEGER milliseconds`);
}
