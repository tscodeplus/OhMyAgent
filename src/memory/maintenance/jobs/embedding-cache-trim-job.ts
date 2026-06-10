import type Database from 'better-sqlite3';
import type { MaintenanceJob, MaintenanceJobResult } from '../maintenance-job.js';

export function createEmbeddingCacheTrimJob(
  db: Database.Database,
  maxEntries: number = 10000,
  intervalMs: number = 12 * 60 * 60 * 1000,
): MaintenanceJob {
  return {
    name: 'embedding_cache_trim',
    enabled: true,
    intervalMs,
    async run({ dryRun }): Promise<MaintenanceJobResult> {
      const row = db.prepare('SELECT COUNT(*) as cnt FROM embedding_cache').get() as { cnt: number };
      if (row.cnt <= maxEntries) {
        return {
          name: 'embedding_cache_trim',
          status: 'success',
          dryRun,
          affectedRows: 0,
          durationMs: 0,
          details: { current: row.cnt, max: maxEntries },
        };
      }

      if (dryRun) {
        const toDelete = Math.ceil(row.cnt * 0.1);
        return {
          name: 'embedding_cache_trim',
          status: 'success',
          dryRun: true,
          affectedRows: 0,
          durationMs: 0,
          details: { wouldDelete: toDelete, current: row.cnt, max: maxEntries },
        };
      }

      const toDelete = Math.ceil(row.cnt * 0.1);
      db.prepare(
        'DELETE FROM embedding_cache WHERE rowid IN (SELECT rowid FROM embedding_cache ORDER BY created_at ASC LIMIT ?)'
      ).run(toDelete);
      return {
        name: 'embedding_cache_trim',
        status: 'success',
        dryRun: false,
        affectedRows: toDelete,
        durationMs: 0,
        details: { deleted: toDelete, remaining: row.cnt - toDelete },
      };
    },
  };
}
