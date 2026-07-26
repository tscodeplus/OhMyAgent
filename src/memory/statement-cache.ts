import { LRUCache } from 'lru-cache';
import type Database from 'better-sqlite3';

/**
 * Caches compiled SQLite prepared statements to avoid repeated calls to
 * `db.prepare(sql)` for the same SQL text. While better-sqlite3 has an
 * internal statement cache, this class provides a bounded LRU cache at the
 * application layer, preventing unbounded memory growth when a large number
 * of distinct SQL patterns are used across different repository methods.
 *
 * The cache is bounded to `max` entries (default 200). Entries are evicted
 * in LRU order when the limit is exceeded.
 */
export class PreparedStatementCache {
  private readonly cache: LRUCache<string, Database.Statement>;

  /**
   * @param max Maximum number of prepared statements to cache (default 200).
   */
  constructor(max: number = 200) {
    this.cache = new LRUCache<string, Database.Statement>({ max });
  }

  /**
   * Return a cached prepared statement for the given SQL string, or compile
   * and cache it if no entry exists.
   *
   * @param db The better-sqlite3 database instance.
   * @param sql The SQL statement to prepare.
   * @returns A compiled Statement ready for `.run()`, `.get()`, or `.all()`.
   */
  prepare(db: Database.Database, sql: string): Database.Statement {
    let stmt = this.cache.get(sql);
    if (!stmt) {
      stmt = db.prepare(sql);
      this.cache.set(sql, stmt);
    }
    return stmt;
  }

  /**
   * Clear all cached prepared statements. Call this when the database
   * connection is closed or replaced to avoid stale statements.
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Return the current number of cached prepared statements.
   */
  get size(): number {
    return this.cache.size;
  }
}
