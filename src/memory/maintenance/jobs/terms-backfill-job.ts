import type Database from 'better-sqlite3';
import type { MaintenanceJob, MaintenanceJobResult } from '../maintenance-job.js';
import {
  MemoryTermRepository,
  extractMemoryTerms,
} from '../../repositories/memory-term-repository.js';

/**
 * Backfills lexical terms (memory_terms) for active memories that lack them.
 *
 * Old memories written through paths that bypassed MemoryWriter (bulk import,
 * legacy deletions of the writer wiring) never got terms extracted, leaving
 * the lexical recall channel (termSearchWrapper) blind to ~most of the store.
 * Extraction is local (jieba tokenization + regex) — no LLM dependency, so
 * failures are limited to malformed rows.
 */
export function createTermsBackfillJob(
  db: Database.Database,
  intervalMs: number = 6 * 60 * 60 * 1000,
  batchSize: number = 500,
): MaintenanceJob {
  return {
    name: 'terms_backfill',
    enabled: true,
    intervalMs,
    async run({ dryRun }): Promise<MaintenanceJobResult> {
      const rows = db
        .prepare(
          `
        SELECT m.id, m.content, m.metadata FROM memories m
        WHERE m.status = 'active'
          AND NOT EXISTS (SELECT 1 FROM memory_terms mt WHERE mt.memory_id = m.id)
        LIMIT ?
      `,
        )
        .all(batchSize) as Array<{ id: string; content: string; metadata: string | null }>;

      if (dryRun) {
        return {
          name: 'terms_backfill',
          status: 'success',
          dryRun: true,
          affectedRows: 0,
          durationMs: 0,
          details: { missingCount: rows.length },
        };
      }

      const termRepo = new MemoryTermRepository(db);
      let count = 0;
      let noTerms = 0;
      for (const row of rows) {
        let metadata: Record<string, unknown> | null = null;
        try {
          metadata = row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : null;
        } catch {
          // Unparsable metadata — extract from content only.
        }
        const terms = extractMemoryTerms(row.content, metadata);
        // Placeholder-content rows ("N/A", "（无）") legitimately extract to
        // zero terms — report them separately instead of counting as
        // progress so the job's affected_rows converges to zero.
        if (terms.length === 0) {
          noTerms++;
          continue;
        }
        termRepo.replaceForMemory(row.id, terms);
        count++;
      }
      return {
        name: 'terms_backfill',
        status: 'success',
        dryRun: false,
        affectedRows: count,
        durationMs: 0,
        details: { total: rows.length, backfilled: count, noExtractableTerms: noTerms },
      };
    },
  };
}
