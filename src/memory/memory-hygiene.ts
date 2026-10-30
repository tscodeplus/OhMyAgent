import type Database from 'better-sqlite3';
import type { MemoryRepository } from './repositories/memory-repository.js';
import { EmbeddingRepository } from './repositories/embedding-repository.js';
import type { SceneClusterer } from './scene-cluster.js';

export interface HygieneConfig {
  /** Retention days for temporary memories (fact/task/device_state). Default 90. */
  tempRetentionDays: number;
  /** Minimum interval between hygiene checks in ms. Default 12 hours. */
  checkIntervalMs: number;
  /** Memory key used to store the last check timestamp. */
  lastCheckKey: string;
  /**
   * Retention days for `knowledge_log` rows (`knowledge.log_retention_days`).
   * `0` = keep forever. Default 90, the knowledge layer's own default — this
   * pass is the only thing that prunes that table, by design (no extra
   * scheduler, no extra CLI: the plan gives the retention to the existing
   * hygiene pass).
   */
  knowledgeLogRetentionDays: number;
}

export interface HygieneReport {
  cleanedCount: number;
  cleanedKinds: Record<string, number>;
  /**
   * Deleted memories that an `active` knowledge page still cites (plan §8 S2).
   * Those pages are now unverifiable — the citation points at a row that no
   * longer exists — and the deletion is the moment an operator can still decide
   * to keep the row. The doctor reports the standing total; this reports this
   * pass's contribution, which is the number the delete decision needs.
   */
  citedByActivePages?: number;
  durationMs: number;
  error?: string;
}

/**
 * `memories.updated_at` stores epoch milliseconds as TEXT (schema default
 * `cast(strftime('%s','now') as integer) * 1000`). Cutoff comparisons must
 * use the same representation — lexicographic comparison of numeric strings
 * is only correct when both sides share the format.
 */
function toEpochMsString(date: Date): string {
  return String(date.getTime());
}

/**
 * Retention for `memory.injection` observation rows (plan §6 K0 item 3).
 *
 * 30 days, not the 90 the other horizons use: this table grows with prompt
 * builds rather than with content, so it is the one whose row count is a
 * function of usage time. Only the per-prompt rows are pruned — fault events
 * and the `memory.injection.referenced` rows are rare, and each one is evidence
 * (of a defect, or of an offer that was actually used).
 */
const INJECTION_OBSERVATION_RETENTION_DAYS = 30;

/**
 * How many of `ids` are cited by an `active` knowledge page (plan §8 S2).
 *
 * Bounded by the caller's delete batch, so the `IN (...)` list is the size of one
 * hygiene pass, not the corpus. Returns 0 when the knowledge layer is absent —
 * the probe is a single `sqlite_master` lookup, which is cheaper than making every
 * caller know about `knowledge_sources`.
 */
function countCitedIds(db: Database.Database, ids: readonly string[]): number {
  if (ids.length === 0) return 0;
  try {
    const table = db
      .prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_sources'",
      )
      .get() as { present: number } | undefined;
    if (!table) return 0;
    const placeholders = ids.map(() => '?').join(',');
    const row = db
      .prepare(
        `SELECT COUNT(DISTINCT s.source_id) AS n
           FROM knowledge_sources s
           JOIN knowledge_pages p ON p.id = s.page_id
          WHERE s.source_kind = 'memory' AND p.status = 'active'
            AND s.source_id IN (${placeholders})`,
      )
      .get(...ids) as { n: number } | undefined;
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

export class MemoryHygiene {
  constructor(
    private memoryRepository: MemoryRepository,
    private db: Database.Database,
    private config: Partial<HygieneConfig> = {},
    private sceneClusterer?: SceneClusterer,
    private onMemoryChanged?: () => void,
  ) {}

  private get resolvedConfig(): Required<HygieneConfig> {
    return {
      tempRetentionDays: this.config.tempRetentionDays ?? 90,
      checkIntervalMs: this.config.checkIntervalMs ?? 12 * 60 * 60 * 1000,
      lastCheckKey: this.config.lastCheckKey ?? '__hygiene_last_check__',
      knowledgeLogRetentionDays: this.config.knowledgeLogRetentionDays ?? 90,
    };
  }

  /**
   * Run hygiene if enough time has passed since the last check.
   * Returns a report. If not due, returns cleanedCount=0.
   */
  runIfDue(): HygieneReport {
    const config = this.resolvedConfig;

    const lastCheckMemory = this.memoryRepository.findById(config.lastCheckKey);
    if (lastCheckMemory) {
      const lastCheckMs = Number(lastCheckMemory.updated_at);
      if (Number.isFinite(lastCheckMs) && Date.now() - lastCheckMs < config.checkIntervalMs) {
        return { cleanedCount: 0, cleanedKinds: {}, durationMs: 0 };
      }
    }

    return this.clean();
  }

  /**
   * Execute cleanup unconditionally.
   *
   * Preserves: kind='preference', kind='summary'
   * Cleans:    kind='fact', kind='task', kind='device_state' older than tempRetentionDays
   *            plus `knowledge_log` rows older than knowledgeLogRetentionDays
   *            plus `memory.injection` observation rows older than 30 days   *
   * A pass refused by the 80% safety threshold touches nothing at all — not the
   * memories and not the log — so a refused pass cannot look like a partial one.
   */
  clean(): HygieneReport {
    const startMs = Date.now();
    const config = this.resolvedConfig;

    const cutoff = new Date(Date.now() - config.tempRetentionDays * 24 * 60 * 60 * 1000);
    const cutoffStored = toEpochMsString(cutoff);

    try {
      const tempKinds = ['fact', 'task', 'device_state'];
      const placeholders = tempKinds.map(() => '?').join(',');
      const rows = this.db
        .prepare(
          `
        SELECT id, kind FROM memories
        WHERE kind IN (${placeholders})
          AND updated_at < ?
        ORDER BY updated_at ASC
      `,
        )
        .all(...tempKinds, cutoffStored) as Array<{ id: string; kind: string }>;

      // Safety: refuse to delete > 80% of temp-kind memories in one pass.
      // Prevents catastrophic data loss from misconfigured retention or clock skew.
      const totalRow = this.db
        .prepare(`SELECT COUNT(*) as cnt FROM memories WHERE kind IN (${placeholders})`)
        .get(...tempKinds) as { cnt: number };
      const totalCount = totalRow?.cnt ?? 0;
      const expiredCount = rows.length;
      if (totalCount > 0 && expiredCount > 0) {
        const ratio = expiredCount / totalCount;
        if (ratio > 0.8) {
          return {
            cleanedCount: 0,
            cleanedKinds: {},
            durationMs: Date.now() - startMs,
            error: `Safety threshold exceeded: would delete ${expiredCount}/${totalCount} (${(ratio * 100).toFixed(1)}%) temp-kind memories, > 80% limit — refusing`,
          };
        }
      }

      const cleanedKinds: Record<string, number> = {};
      // Plan §8 S2: count the deletions that will orphan an active page's
      // citation BEFORE deleting — afterwards the citation is dangling and the
      // question "did this pass cost a page its evidence" is unanswerable. One
      // indexed query over this pass's ids; 0 on an install without the
      // knowledge layer (the table probe is inside `countCitedIds`).
      const citedByActivePages = countCitedIds(
        this.db,
        rows.map((row) => row.id),
      );
      // Delete via the repositories so vec_memory_embeddings and the jieba
      // FTS index stay consistent — raw SQL here would leave orphan vectors
      // (vec_ virtual tables have no FK cascade) and orphan FTS rows.
      const embeddingRepository = new EmbeddingRepository(this.db);

      const deleteBatch = this.db.transaction((items: Array<{ id: string; kind: string }>) => {
        for (const item of items) {
          embeddingRepository.deleteByMemoryId(item.id);
          this.memoryRepository.delete(item.id);
          cleanedKinds[item.kind] = (cleanedKinds[item.kind] ?? 0) + 1;
        }
      });

      deleteBatch(rows);
      if (rows.length > 0) {
        this.onMemoryChanged?.();
      }

      // `knowledge_log` grows with write count rather than page count (a nightly
      // batch of 5 pages is ~1800 rows a year), so it needs a horizon — and this
      // pass already runs on a timer, which is why it prunes here.
      const prunedLogRows = this.pruneKnowledgeLog(config.knowledgeLogRetentionDays);
      if (prunedLogRows > 0) {
        cleanedKinds['knowledge_log'] = prunedLogRows;
      }

      // The per-turn injection rows are the same kind of append-only growth —
      // one row per prompt build — so they take the same ride on this pass.
      const prunedInjectionRows = this.pruneInjectionObservations(
        INJECTION_OBSERVATION_RETENTION_DAYS,
      );
      if (prunedInjectionRows > 0) {
        cleanedKinds['memory.injection'] = prunedInjectionRows;
      }

      // Update last-check timestamp
      this.memoryRepository.upsert({
        id: config.lastCheckKey,
        scope: 'system',
        scope_key: '__internal__',
        kind: 'hygiene_checkpoint',
        content: String(Date.now()),
        metadata: null,
      });

      // Re-cluster scenes asynchronously after cleanup
      if (this.sceneClusterer) {
        setImmediate(() => {
          try {
            this.sceneClusterer!.cluster();
          } catch {
            // Non-fatal: clustering failure should not affect hygiene
          }
        });
      }

      return {
        cleanedCount: rows.length + prunedLogRows + prunedInjectionRows,
        cleanedKinds,
        ...(citedByActivePages > 0 ? { citedByActivePages } : {}),
        durationMs: Date.now() - startMs,
      };
    } catch (e) {
      return {
        cleanedCount: 0,
        cleanedKinds: {},
        durationMs: Date.now() - startMs,
        error: String(e),
      };
    }
  }

  /**
   * Delete `knowledge_log` rows past the retention horizon; returns how many.
   *
   * `knowledge_log.created_at` is INTEGER epoch-ms (migration-v14), unlike the
   * legacy TEXT digit-string columns — so the cutoff is a number, not a string.
   * `retentionDays <= 0` means keep forever.
   *
   * Returns 0 rather than throwing when the table does not exist: a database
   * that has not run migration-v14 yet (or a build without the knowledge layer)
   * must still get its memory hygiene.
   */
  private pruneKnowledgeLog(retentionDays: number): number {
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) return 0;

    const table = this.db
      .prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_log'",
      )
      .get() as { present: number } | undefined;
    if (!table) return 0;

    const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const result = this.db.prepare('DELETE FROM knowledge_log WHERE created_at < ?').run(cutoffMs);
    return result.changes;
  }

  /**
   * Delete per-turn `memory.injection` observation rows past the horizon;
   * returns how many.
   *
   * `created_at` is a TEXT column whose DEFAULT writes epoch-ms as a digit
   * string, so the comparison casts — the same shape `memory-routes.ts` reads
   * it with. The match is the exact event name on purpose: every other row in
   * that table is a fault, or a `memory.injection.referenced` correlation, and
   * both are rare enough that losing them would lose the evidence.
   */
  private pruneInjectionObservations(retentionDays: number): number {
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) return 0;

    const table = this.db
      .prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'memory_observation_events'",
      )
      .get() as { present: number } | undefined;
    if (!table) return 0;

    const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const result = this.db
      .prepare(
        "DELETE FROM memory_observation_events WHERE event = 'memory.injection' AND CAST(created_at AS INTEGER) < ?",
      )
      .run(cutoffMs);
    return result.changes;
  }
}
