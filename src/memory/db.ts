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
import { migrateV16 } from './migration-v16.js';
import { migrateV28 } from './migration-v28.js';
import { migrateV30 } from './migration-v30.js';
import { migrateV31 } from './migration-v31.js';
import { migrateV32 } from './migration-v32.js';
import { migrateV33 } from './migration-v33.js';
import { migrateV34 } from './migration-v34.js';
import { migrateV35 } from './migration-v35.js';
import { migrateV36 } from './migration-v36.js';
import { migrateV37 } from './migration-v37.js';
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

  // V16 migration: persona_distillation_runs.input_memory_ids / output_diff.
  // BEFORE applySchema, same constraint as v4/v9/v11/v12/v13.
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

  // V10 migration: the messages_fts_jieba index (jieba-segmented FTS5 over
  // `messages`). Runs AFTER applySchema because its backfill reads `messages`,
  // which applySchema creates on a fresh database.
  migrateV10(db);

  // V28 repairs data, not schema: a credential stored as a memory is replayed
  // into every later session (prompt, FTS hit, memory recall),
  // so rows written before the write path learned to mask them are rewritten
  // here. Idempotent by construction — a masked row redacts to itself.
  try {
    const v28Result = migrateV28(db);
    if (v28Result.redacted > 0) {
      logger.warn(
        `[V28] Redacted credentials in ${v28Result.redacted} memory row(s) (${v28Result.kinds.join(', ')})`,
      );
    }
  } catch (err) {
    logger.warn({ err }, '[V28] Credential redaction failed — continuing');
  }

  // V30 restores what v29 closed by mistake. Session summaries are *incremental*
  // (`summarizeSession` only feeds the messages since the last episode), so the
  // rows v29 called "superseded generations" were disjoint windows of the same
  // conversation — closing them cost recall instead of saving it.
  try {
    const v30Result = migrateV30(db);
    if (v30Result.restored > 0) {
      logger.warn(`[V30] Restored ${v30Result.restored} incremental session summar(y/ies)`);
    }
  } catch (err) {
    logger.warn({ err }, '[V30] Session summary restore failed — continuing');
  }

  // V31: the notes tables (MyDocs/NOTES_LAYER_PLAN.md §4). A new table set, so
  // it runs after applySchema() — schema.ts owns no DDL for these tables and
  // therefore has no index that could reference a missing column. Every
  // statement is IF NOT EXISTS, so a replay is a no-op.
  const v31Result = migrateV31(db);
  if (v31Result.created) {
    logger.info('[V31] Created notes tables (notes, sources, capture runs, events, FTS)');
  }

  // V32 drops what the retired knowledge-page and entity-graph layers left
  // behind. Runs after applySchema like the new-table migrations: the tables it
  // removes are ones schema.ts no longer declares, so nothing above depends on
  // them existing. Every statement is DROP TABLE IF EXISTS, so a replay is free
  // and a fresh install finds nothing to do.
  const v32Result = migrateV32(db);
  if (v32Result.dropped.length > 0) {
    logger.info(`[V32] Dropped ${v32Result.dropped.length} retired table(s)`);
  }

  // V33 rebuilds `note_relations` with a `basis` column. v31 created that table for a
  // feature nothing wrote to, so the rebuild cannot lose a row — but it is still a
  // rebuild rather than a column add, because the column it replaces is named
  // `origin`, which everywhere else in this database means authorship. After
  // applySchema like the other new-table migrations: `note_relations` is created by
  // v31 (also after applySchema) and schema.ts owns no DDL for it.
  const v33Result = migrateV33(db);
  if (v33Result.rebuilt) {
    logger.info(
      { discardedRows: v33Result.discardedRows },
      '[V33] note_relations rebuilt with a basis column',
    );
  }

  // v34: additive column on capture_runs so a session-wide capture can record how
  // many messages its budget dropped. `session` mode is the first window that can
  // lose material, and a loss the review card cannot see is a loss nobody audits.
  migrateV34(db);

  // v35: the summary a cold session resumes from. Compression summaries used to
  // live only in memory, so a restarted (or evicted) session fell back to raw
  // rows and lost everything its own compaction had already distilled.
  migrateV35(db);

  // v36: drop notes.kind. The aspect dimension moved into tags (backfill + FTS
  // re-index + relations rebuild), where the facet filter, search and counts
  // actually consume it. Runs after v31/v33 (which create the tables it touches)
  // and is replay-safe: everything is guarded on the column existing.
  try {
    migrateV36(db);
  } catch (err) {
    logger.warn({ err }, '[V36] notes.kind drop failed — continuing');
  }

  // v37: retire the two archived notes reasons that no longer exist as states. A
  // rejected draft is erased (its `reject` event kept for the approval rate), and a
  // draft the old TTL hid is put back in the queue. Both selectors are status/reason
  // matches, so a replay finds nothing and does nothing.
  try {
    migrateV37(db);
  } catch (err) {
    logger.warn({ err }, '[V37] notes retention migration failed — continuing');
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
