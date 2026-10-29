import Database from 'better-sqlite3';
import { applySchema } from './schema.js';
import { runV2Migrations } from './migration-v2.js';
import { runV3Migrations } from './migration-v3.js';
import { migrateV4 } from './migration-v4.js';
import { migrateV5 } from './migration-v5.js';
import { migrateV6 } from './migration-v6.js';
import { migrateV7 } from './migration-v7.js';
import { migrateV8 } from './migration-v8.js';
import { migrateV9 } from './migration-v9.js';
import { migrateV10 } from './migration-v10.js';
import { migrateV11 } from './migration-v11.js';
import { migrateV12 } from './migration-v12.js';
import { migrateV13 } from './migration-v13.js';
import { migrateV14 } from './migration-v14.js';
import { migrateV15 } from './migration-v15.js';
import { migrateV16 } from './migration-v16.js';
import { migrateV17 } from './migration-v17.js';
import { migrateV18 } from './migration-v18.js';
import { migrateV19 } from './migration-v19.js';
import { attachMemoryObservabilityDb } from './observability.js';
import { createLogger } from '../app/logger.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

const logger = createLogger();

let cachedDb: Database.Database | null = null;

/**
 * Resolve a database file path, expanding `~` to the user's home directory
 * and converting relative paths to absolute.
 */
function resolveDbPath(dbPath: string): string {
  if (dbPath === ':memory:') return dbPath;
  if (dbPath.startsWith('~')) {
    return path.join(os.homedir(), dbPath.slice(1));
  }
  return path.resolve(dbPath);
}

/**
 * Open database connection.
 * Use ':memory:' for testing.
 */
export function openDatabase(dbPath: string): Database.Database {
  const resolvedPath = resolveDbPath(dbPath);

  // Create parent directories for file-based databases if they don't exist
  if (resolvedPath !== ':memory:') {
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const db = new Database(resolvedPath);

  // Enable WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL');
  // NORMAL is safe under WAL and avoids an fsync on every commit
  db.pragma('synchronous = NORMAL');
  // ~8MB page cache (negative value = KiB)
  db.pragma('cache_size = -8000');

  // Enable foreign keys
  db.pragma('foreign_keys = ON');
  // Wait (rather than instantly failing with SQLITE_BUSY) when another process
  // holds the write lock — e.g. the desktop sidecar plus a CLI invocation on
  // the same data/app.db, or an overlapping restart. WAL keeps readers
  // non-blocking; this covers the writer-vs-writer case.
  db.pragma('busy_timeout = 5000');

  // Set file permissions to 0600 (owner read/write only) for file-based databases
  if (resolvedPath !== ':memory:') {
    try {
      fs.chmodSync(resolvedPath, 0o600);
      // Also set permissions on WAL and SHM files if they exist
      try {
        fs.chmodSync(resolvedPath + '-wal', 0o600);
      } catch {
        /* ignore */
      }
      try {
        fs.chmodSync(resolvedPath + '-shm', 0o600);
      } catch {
        /* ignore */
      }
    } catch {
      // Silently ignore permission errors on filesystems that don't support chmod
    }
  }

  // V4 migration: add project_id to sessions (must run BEFORE applySchema
  // so that the idx_sessions_project index creation succeeds on existing DBs)
  migrateV4(db);

  // V9 migration: add channel / external_chat_id / title to sessions and
  // backfill them. Same ordering constraint as V4 — applySchema's
  // idx_sessions_channel_updated DDL references `channel`, which only the
  // migration can add to a table that already exists.
  const v9Result = migrateV9(db);
  if (v9Result.added.length > 0) {
    logger.info(`[V9] Session migration: added columns: ${v9Result.added.join(', ')}`);
  }
  if (v9Result.backfilled > 0) {
    logger.info(`[V9] Session migration: backfilled ${v9Result.backfilled} column values`);
  }

  // V11 migration: add sessions.archived_at (the WebUI archive flag) and its
  // index. Same ordering constraint as V4/V9 — applySchema's
  // idx_sessions_archived DDL references `archived_at`, which only this
  // migration can add to a table that already exists. Every existing row stays
  // NULL (active), so the upgrade archives nothing.
  const v11Result = migrateV11(db);
  if (v11Result.added.length > 0) {
    logger.info(`[V11] Session migration: added columns: ${v11Result.added.join(', ')}`);
  }

  // V12 migration: add sessions.archive_exempt_until, the "do not auto-archive me
  // yet" marker a manual 取消归档 writes. Same ordering constraint as V11: the
  // column is declared in schema.ts, which cannot add it to an existing table.
  const v12Result = migrateV12(db);
  if (v12Result.added.length > 0) {
    logger.info(`[V12] Session migration: added columns: ${v12Result.added.join(', ')}`);
  }

  // V2 + V3 migrations: the same ordering constraint as V4, for `memories`.
  // applySchema's index DDL covers agent_id / visibility / status, but
  // `CREATE TABLE IF NOT EXISTS` cannot add a column to a table that already
  // exists — so on an upgraded install the index statement threw inside
  // applySchema, escaped openDatabase() and killed bootstrap(), and the
  // migrations that would have fixed it were never reached. On a fresh database
  // both no-op (no `memories` table yet; DDL_MEMORIES declares the columns).
  const v2Result = runV2Migrations(db);
  if (v2Result.added.length > 0) {
    logger.info(`[V2] Memory migration: added columns: ${v2Result.added.join(', ')}`);
  }

  const v3Result = runV3Migrations(db);
  if (v3Result.added.length > 0) {
    logger.info(`[V3] Memory migration: added columns: ${v3Result.added.join(', ')}`);
  }

  // V13 migration: create memory_sources (memory -> message provenance) and add
  // memories.embedding_status. BEFORE applySchema for the same reason as v11/v12:
  // schema.ts declares `embedding_status` on `memories`, and
  // `CREATE TABLE IF NOT EXISTS` cannot add a column to a table that already
  // exists. The memory_sources table it also creates tolerates a not-yet-created
  // `memories` — SQLite resolves the REFERENCES target lazily.
  const v13Result = migrateV13(db);
  if (v13Result.created.length > 0) {
    logger.info(`[V13] Memory migration: created: ${v13Result.created.join(', ')}`);
  }
  if (v13Result.added.length > 0) {
    logger.info(`[V13] Memory migration: added columns: ${v13Result.added.join(', ')}`);
  }

  // V15 migration: memory_links.subject_entity / subject_entity_type /
  // target_entity_type. BEFORE applySchema: the columns are declared in
  // schema.ts, which cannot add them to an existing table.
  const v15Result = migrateV15(db);
  if (v15Result.added.length > 0) {
    logger.info(`[V15] Graph migration: added columns: ${v15Result.added.join(', ')}`);
  }

  // V16 migration: persona_distillation_runs.input_memory_ids / output_diff.
  // BEFORE applySchema, same constraint as v15.
  const v16Result = migrateV16(db);
  if (v16Result.added.length > 0) {
    logger.info(`[V16] Persona migration: added columns: ${v16Result.added.join(', ')}`);
  }

  // Apply schema (creates tables + indexes, idempotent for existing tables).
  const { failedIndexes } = applySchema(db);
  for (const failed of failedIndexes) {
    // Query performance only — the database is usable and boots.
    logger.warn(`[schema] index not created (${failed.reason}): ${failed.statement}`);
  }
  attachMemoryObservabilityDb(db);

  // NOTE: the memories_fts backfill used to run here — BEFORE the V2/V3
  // migrations. Its COUNT(...) query references `status`, which only exists
  // once runV3Migrations has added it, so on such a database the throw escaped
  // openDatabase() the same way. It now runs after every migration (below).

  // V5 migration: convert TEXT timestamps to INTEGER milliseconds (idempotent)
  migrateV5(db);

  // V6 migration: add performance-optimizing composite indexes (idempotent)
  migrateV6(db);

  // V7 migration: normalize memory_observation_events.created_at to epoch-ms
  // (legacy tables carry a datetime('now') DEFAULT that survives CREATE TABLE
  // IF NOT EXISTS and breaks time-window queries mixing formats).
  migrateV7(db);

  // V8 migration: create mcp_oauth_credentials for MCP OAuth state (idempotent;
  // nothing writes to it unless the user configures a server with `oauth:`).
  migrateV8(db);

  // V10 migration: knowledge-graph tables (entities / entity_aliases /
  // entity_edges, with valid_from/valid_to so a retracted fact is closed
  // rather than deleted) plus the messages_fts_jieba index. Runs AFTER
  // applySchema because its FTS backfill reads `messages`, which applySchema
  // creates on a fresh database. Nothing reads these tables unless the graph
  // layer is used, so an install that ignores it pays only the DDL.
  migrateV10(db);

  // V14 migration: the knowledge layer (knowledge_pages / knowledge_sources /
  // knowledge_links / knowledge_log / knowledge_fts_jieba). Runs AFTER
  // applySchema because it is all new tables — nothing schema.ts references — so
  // there is no column for an upgraded database to be missing. The whole layer is
  // inert until the knowledge tools write to it.
  const v14Result = migrateV14(db);
  if (v14Result.created.length > 0) {
    logger.info(`[V14] Knowledge migration: created: ${v14Result.created.join(', ')}`);
  }

  // V17 migration: repair legacy graph DATA (no schema change) — delete the
  // pre-K3 `memory:<id>` placeholder nodes, the `MENTIONED` co-occurrence edges
  // and the orphan edges, backfill `memory_links.subject_entity`, then project.
  // It belongs here rather than above because it adds no column: it needs the
  // tables first (`entities`/`entity_edges` from v10, `memory_links` from
  // applySchema) and `memory_links.subject_entity` from v15, so the v4/v9/v11/
  // v12/v15 rule that puts column-adding migrations *before* applySchema does
  // not apply to it. Like v10/v14 it is a replay on every open, so it guards on
  // "anything to repair" and costs one read-only COUNT query once the database
  // is clean.
  const v17Result = migrateV17(db, logger);
  const v17DeletedRows =
    v17Result.cleaned.placeholderEntities +
    v17Result.cleaned.placeholderEdges +
    v17Result.cleaned.mentionEdges +
    v17Result.cleaned.orphanEndpointEdges +
    v17Result.cleaned.orphanMemoryEdges;
  const v17LinkRows = v17Result.mined.linksCreated + v17Result.mined.linksAnnotated;
  if (v17DeletedRows > 0 || v17LinkRows > 0 || v17Result.projected.edgesCreated > 0) {
    logger.info(
      `[V17] Graph data migration: deleted ${v17DeletedRows} legacy rows, ` +
        `wrote ${v17LinkRows} link subjects, ` +
        `projected ${v17Result.projected.entitiesCreated} entities / ${v17Result.projected.edgesCreated} edges`,
    );
  }

  // V18: the extraction model's own ledger. After applySchema like v17 — it is a
  // new table, not a column add, and it must exist before the job that writes to
  // it is constructed (bootstrap builds services right after this returns).
  const v18Result = migrateV18(db);
  if (v18Result.created) {
    logger.info('[V18] Created entity_extraction_log (skips memories already read)');
  }

  // V19: one entity per name. Rewrites canonical names under the current folding
  // rule and merges the nodes that fold together, in that order (see the module).
  const v19Result = migrateV19(db);
  if (v19Result.merged > 0 || v19Result.renamedCanonical > 0) {
    logger.info(
      `[V19] merged ${v19Result.merged} duplicate node(s), rewrote ` +
        `${v19Result.renamedCanonical} canonical name(s)`,
    );
  }

  // Backfill FTS index for memories that are missing from it (first-time
  // migration for existing databases, plus partial corruption self-heal:
  // previously only a fully-empty index triggered the rebuild). Runs LAST so
  // every column it references has been added by the migrations above.
  try {
    const ftsCount = (
      db.prepare('SELECT COUNT(*) as cnt FROM memories_fts').get() as { cnt: number }
    ).cnt;
    const memCount = (
      db.prepare("SELECT COUNT(*) as cnt FROM memories WHERE status = 'active'").get() as {
        cnt: number;
      }
    ).cnt;
    if (ftsCount < memCount) {
      // Insert ONLY the rowids missing from the index — re-inserting all
      // rows would duplicate already-indexed entries (FTS5 has no unique
      // constraint) and skew BM25 ranking.
      const backfilled = db.transaction(() =>
        db.exec(
          `INSERT INTO memories_fts(rowid, content)
           SELECT m.rowid, m.content FROM memories m
           LEFT JOIN memories_fts f ON f.rowid = m.rowid
           WHERE f.rowid IS NULL`,
        ),
      );
      backfilled();
      logger.info(`[FTS] Backfilled memories_fts (${ftsCount} -> ${memCount} rows)`);
    }
  } catch (err) {
    // Never let an index-maintenance step abort startup: search degrades to
    // LIKE rather than the gateway failing to boot.
    logger.warn({ err }, '[FTS] memories_fts backfill failed — search falls back to LIKE');
  }

  return db;
}

/**
 * Get or create the cached database connection.
 *
 * The FIRST call must supply an explicit dbPath (a real file path, or the
 * literal ':memory:' for tests). Previously a missing path silently fell back
 * to an in-memory database, so a wiring bug would route all reads/writes to a
 * throwaway DB that vanishes on restart — with no error. Failing loudly here
 * surfaces that misconfiguration immediately.
 */
export function getDatabase(dbPath?: string): Database.Database {
  if (cachedDb) return cachedDb;
  if (dbPath === undefined) {
    throw new Error(
      'getDatabase() called before initialization: the first call must pass an explicit ' +
        "dbPath (or ':memory:' for tests).",
    );
  }
  cachedDb = openDatabase(dbPath);
  return cachedDb;
}

/**
 * Close cached database connection.
 */
export function closeDatabase(): void {
  if (cachedDb) {
    cachedDb.close();
    cachedDb = null;
  }
}

/**
 * Reset cached database (for testing).
 */
export function resetDatabase(): void {
  closeDatabase();
}
