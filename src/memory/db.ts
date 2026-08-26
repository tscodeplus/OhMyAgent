import Database from 'better-sqlite3';
import { applySchema } from './schema.js';
import { runV2Migrations } from './migration-v2.js';
import { runV3Migrations } from './migration-v3.js';
import { migrateV4 } from './migration-v4.js';
import { migrateV5 } from './migration-v5.js';
import { migrateV6 } from './migration-v6.js';
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

  // Apply schema (creates tables + indexes, idempotent for existing tables)
  applySchema(db);
  attachMemoryObservabilityDb(db);

  // Backfill FTS index for memories that are missing from it (first-time
  // migration for existing databases, plus partial corruption self-heal:
  // previously only a fully-empty index triggered the rebuild).
  {
    const ftsCount = (
      db.prepare('SELECT COUNT(*) as cnt FROM memories_fts').get() as { cnt: number }
    ).cnt;
    const memCount = (
      db.prepare("SELECT COUNT(*) as cnt FROM memories WHERE status = 'active'").get() as {
        cnt: number;
      }
    ).cnt;
    if (ftsCount < memCount) {
      const backfilled = db.transaction(() =>
        db.exec('INSERT INTO memories_fts(rowid, content) SELECT rowid, content FROM memories'),
      );
      try {
        backfilled();
        logger.info(`[FTS] Backfilled memories_fts (${ftsCount} -> ${memCount} rows)`);
      } catch (err) {
        logger.warn({ err }, '[FTS] memories_fts backfill failed — search falls back to LIKE');
      }
    }
  }

  // V2 migration: add agent_id and visibility columns (idempotent)
  const v2Result = runV2Migrations(db);
  if (v2Result.added.length > 0) {
    logger.info(`[V2] Memory migration: added columns: ${v2Result.added.join(', ')}`);
  }

  // V3 migration: add lifecycle fields, persona/maintenance run tables (idempotent)
  const v3Result = runV3Migrations(db);
  if (v3Result.added.length > 0) {
    logger.info(`[V3] Memory migration: added columns: ${v3Result.added.join(', ')}`);
  }

  // V5 migration: convert TEXT timestamps to INTEGER milliseconds (idempotent)
  migrateV5(db);

  // V6 migration: add performance-optimizing composite indexes (idempotent)
  migrateV6(db);

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
