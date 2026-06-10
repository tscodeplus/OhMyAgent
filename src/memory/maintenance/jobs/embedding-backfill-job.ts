import type Database from 'better-sqlite3';
import type { EmbeddingRepository } from '../../repositories/embedding-repository.js';
import type { EmbeddingClient } from '../../../provider/embedding-client.js';
import type { MaintenanceJob, MaintenanceJobResult } from '../maintenance-job.js';
import { generateId } from '../../../shared/ids.js';

export function createEmbeddingBackfillJob(
  db: Database.Database,
  embeddingRepo: EmbeddingRepository,
  embeddingClient: EmbeddingClient,
  intervalMs: number = 6 * 60 * 60 * 1000,
): MaintenanceJob {
  return {
    name: 'embedding_backfill',
    enabled: true,
    intervalMs,
    async run({ dryRun }): Promise<MaintenanceJobResult> {
      const rows = db.prepare(`
        SELECT m.id, m.content FROM memories m
        LEFT JOIN memory_embeddings me ON me.memory_id = m.id
        WHERE me.id IS NULL AND m.status = 'active'
        LIMIT 20
      `).all() as Array<{ id: string; content: string }>;

      if (dryRun) {
        return {
          name: 'embedding_backfill',
          status: 'success',
          dryRun: true,
          affectedRows: 0,
          durationMs: 0,
          details: { missingCount: rows.length },
        };
      }

      let count = 0;
      for (const row of rows) {
        try {
          const embedding = await embeddingClient.embedOne(row.content);
          if (embedding) {
            embeddingRepo.create({
              id: generateId(),
              memory_id: row.id,
              embedding,
              model: embeddingClient.model,
              dimension: embedding.length,
            });
            count++;
          }
        } catch {
          // Skip individual failures
        }
      }
      return {
        name: 'embedding_backfill',
        status: 'success',
        dryRun: false,
        affectedRows: count,
        durationMs: 0,
        details: { total: rows.length, backfilled: count },
      };
    },
  };
}
