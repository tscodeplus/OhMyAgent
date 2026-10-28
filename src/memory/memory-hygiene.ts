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
   *
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
        cleanedCount: rows.length + prunedLogRows,
        cleanedKinds,
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
}
