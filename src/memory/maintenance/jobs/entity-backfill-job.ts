import type Database from 'better-sqlite3';
import type { MemoryLinkRepository } from '../../repositories/memory-link-repository.js';
import type { MaintenanceJob, MaintenanceJobResult } from '../maintenance-job.js';
import { extractEntities } from '../../entity-extractor.js';
import { generateId } from '../../../shared/ids.js';

export function createEntityBackfillJob(
  db: Database.Database,
  memoryLinkRepo: MemoryLinkRepository,
  intervalMs: number = 12 * 60 * 60 * 1000,
): MaintenanceJob {
  return {
    name: 'entity_backfill',
    enabled: true,
    intervalMs,
    async run({ dryRun }): Promise<MaintenanceJobResult> {
      const rows = db.prepare(`
        SELECT m.id, m.content, m.scope, m.kind FROM memories m
        LEFT JOIN memory_links ml ON ml.source_memory_id = m.id
        WHERE ml.id IS NULL AND m.status = 'active'
        LIMIT 100
      `).all() as Array<{ id: string; content: string; scope: string; kind: string }>;

      if (dryRun) {
        return {
          name: 'entity_backfill',
          status: 'success',
          dryRun: true,
          affectedRows: 0,
          durationMs: 0,
          details: { wouldProcess: rows.length },
        };
      }

      let count = 0;
      for (const row of rows) {
        try {
          const entities = extractEntities(row.content, { scope: row.scope, kind: row.kind });
          for (const ent of entities) {
            if (ent.confidence >= 0.5) {
              memoryLinkRepo.create({
                id: generateId(),
                source_memory_id: row.id,
                target_entity: ent.entity,
                relation_type: ent.relationType,
                confidence: ent.confidence,
              });
              count++;
            }
          }
        } catch {
          // Skip
        }
      }
      return {
        name: 'entity_backfill',
        status: 'success',
        dryRun: false,
        affectedRows: count,
        durationMs: 0,
        details: { processed: rows.length, linksCreated: count },
      };
    },
  };
}
