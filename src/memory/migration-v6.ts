/**
 * Migration v6: Add performance-optimizing composite indexes.
 *
 * Verifies table/column names against the actual schema before creating indexes.
 * Two requested indexes were adapted to match the real database schema (see below).
 *
 * Index validation results:
 *
 *   1. idx_memories_scope_kind_status          -- VALID: memories(scope, kind, status) all exist
 *   2. idx_memories_agent_scope_status         -- VALID: memories(agent_id, scope, status) all exist
 *   3. idx_cron_jobs_next_run                  -- SKIPPED: no SQLite `cron_jobs` table exists.
 *        Cron jobs are persisted as JSON in cron-jobs.json (see src/cron/store.ts),
 *        not in the SQLite database. A partial index cannot be created.
 *   4. idx_approval_decisions_session_created  -- ADAPTED: approval_decisions has no `session_id`
 *        column. The FK column is `request_id` (references approval_requests.id). Common
 *        query patterns are findByRequestId / findLatestByRequestId which filter on
 *        `request_id` and order by `created_at`. The index name was changed to
 *        `idx_approval_decisions_request_created` to reflect the actual column.
 */

import type Database from 'better-sqlite3';
import { createLogger } from '../app/logger.js';

const logger = createLogger();

const INDEXES: string[] = [
  // memory_retrieval: filter by scope + kind + active status
  // Used by MemoryRepository.findByScopeKind() and CandidateSelector.selectIds()
  'CREATE INDEX IF NOT EXISTS idx_memories_scope_kind_status ON memories(scope, kind, status)',

  // memory_retrieval: filter by agent_id + scope + active status
  // Used by CandidateSelector.selectIds() when pool is 'current'
  'CREATE INDEX IF NOT EXISTS idx_memories_agent_scope_status ON memories(agent_id, scope, status)',

  // approval_decisions: filter by request_id with chronological ordering
  // Used by ApprovalDecisionRepository.findByRequestId() and findLatestByRequestId()
  'CREATE INDEX IF NOT EXISTS idx_approval_decisions_request_created ON approval_decisions(request_id, created_at DESC)',
];

/**
 * Apply v6 performance indexes to the database.
 * All statements use IF NOT EXISTS for idempotency.
 */
export function migrateV6(db: Database.Database): void {
  const applied: string[] = [];
  const skipped: string[] = [];

  for (const ddl of INDEXES) {
    // Extract index name from DDL for reporting
    const match = ddl.match(/CREATE INDEX IF NOT EXISTS (\S+)/);
    const name = match ? match[1] : 'unknown';

    // Verify the referenced table exists
    const tableMatch = ddl.match(/ON\s+(\w+)/);
    if (tableMatch) {
      const tableName = tableMatch[1];
      const tableExists = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
      ).get(tableName);
      if (!tableExists) {
        skipped.push(`${name} (table '${tableName}' does not exist)`);
        continue;
      }
    }

    // Verify columns exist on the table
    const tableName = tableMatch ? tableMatch[1] : '';
    const colListMatch = ddl.match(/\(([^)]+)\)/);
    if (tableName && colListMatch) {
      const columns = colListMatch[1].split(',').map(c => c.trim().split(/\s+/)[0]);
      const existingColumns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
      const existingColNames = new Set(existingColumns.map(c => c.name));
      const missingCols = columns.filter(col => !existingColNames.has(col));
      if (missingCols.length > 0) {
        skipped.push(`${name} (columns missing: ${missingCols.join(', ')})`);
        continue;
      }
    }

    db.exec(ddl);
    applied.push(name);
  }

  if (applied.length > 0) {
    logger.info(`[migration-v6] Applied indexes: ${applied.join(', ')}`);
  }
  if (skipped.length > 0) {
    logger.info(`[migration-v6] Skipped indexes: ${skipped.join(', ')}`);
  }
}
