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
   * Days an unapproved note draft survives (`notes.draft.ttl_days`). `0` =
   * never expire. Expiring a draft archives it (`status_reason: expired`), it
   * never deletes the row — plan §6.
   */
  notesDraftTtlDays: number;
  /** Retention days for `note_events` (`notes.log_retention_days`). 0 = forever. */
  notesLogRetentionDays: number;
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
      notesDraftTtlDays: this.config.notesDraftTtlDays ?? 14,
      notesLogRetentionDays: this.config.notesLogRetentionDays ?? 90,
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
   *            plus per-turn `memory.injection` rows past their horizon
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

      // Notes: an unapproved draft is a decision that was never made, so it
      // expires into `archived(expired)` rather than accumulating in the review
      // queue forever. Archiving, not deleting — the body may still be the only
      // record of a useful command (plan §6). `note_events` is append-only and
      // grows with writes rather than with rows, so it rides the same pass.
      const expiredDrafts = this.expireNoteDrafts(config.notesDraftTtlDays);
      if (expiredDrafts > 0) {
        cleanedKinds['notes.draft'] = expiredDrafts;
      }
      const prunedNoteEvents = this.pruneNoteEvents(config.notesLogRetentionDays);
      if (prunedNoteEvents > 0) {
        cleanedKinds['note_events'] = prunedNoteEvents;
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
        cleanedCount: rows.length + prunedInjectionRows,
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
   * Expire stale drafts. Guarded on the tables existing: a database opened
   * before v31 ran (or a notes-disabled install) must not throw here — the
   * hygiene pass is shared and must stay independent of the notes layer.
   */
  private expireNoteDrafts(ttlDays: number): number {
    if (ttlDays <= 0) return 0;
    if (!this.tableExists('notes')) return 0;
    const cutoff = Date.now() - ttlDays * 24 * 3600_000;
    const result = this.db
      .prepare(
        `UPDATE notes SET status = 'archived', status_reason = 'expired', updated_at = ?
                WHERE status = 'draft' AND created_at < ?`,
      )
      .run(Date.now(), cutoff);
    return result.changes;
  }

  private pruneNoteEvents(retentionDays: number): number {
    if (retentionDays <= 0) return 0;
    if (!this.tableExists('note_events')) return 0;
    const cutoff = Date.now() - retentionDays * 24 * 3600_000;
    return this.db.prepare('DELETE FROM note_events WHERE created_at < ?').run(cutoff).changes;
  }

  private tableExists(name: string): boolean {
    return !!this.db
      .prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?')
      .get('table', name);
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
