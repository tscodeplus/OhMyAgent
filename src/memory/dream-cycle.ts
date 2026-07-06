/**
 * DreamCycle — nightly maintenance orchestrator.
 *
 * Inspired by TencentDB-Agent-Memory's ManagedTimer + sequential phase
 * execution patterns. Runs 7 phases in order at a configurable time each
 * day (default 2:00 AM in the system local timezone).
 *
 * Phases (sequential, failure in one does not block the next):
 *   1. synthesize   — batch-merge highly similar memory pairs via vector KNN + LLM
 *   2. backlinks    — rebuild missing memory_links
 *   3. extract      — re-extract entities for memories without links
 *   4. sceneCluster — scene clustering (delegates to SceneClusterer)
 *   5. hygiene      — expire old memories (delegates to MemoryHygiene)
 *   6. embed        — fill missing embeddings
 *   7. purge        — evict stale embedding cache entries
 *
 * ## Grace window
 * If DreamCycle fires more than `windowGraceMinutes` past the scheduled
 * time (e.g. the process was down overnight), heavy phases (synthesize,
 * sceneCluster, embed) are skipped to avoid a resource spike during
 * user-active hours.
 *
 * ## Scheduling
 * Uses an inline ManagedTimer pattern: `scheduleAt(epochMs)` computes
 * the next occurrence of (hour, minute) in the configured timezone, then
 * sets a single-shot setTimeout with `.unref()` so the timer does not
 * keep the process alive.
 *
 * ## Audit trail
 * Each phase writes a row to the `maintenance_runs` table (via
 * MaintenanceRunRepository) with job_name = "dreamcycle_<phase>".
 */

import type { Logger } from 'pino';
import type Database from 'better-sqlite3';
import type { MemoryRepository } from './repositories/memory-repository.js';
import type { MemoryLinkRepository } from './repositories/memory-link-repository.js';
import type { EmbeddingRepository } from './repositories/embedding-repository.js';
import type { EmbeddingClient } from '../provider/embedding-client.js';
import type { MemoryHygiene } from './memory-hygiene.js';
import type { SceneClusterer } from './scene-cluster.js';
import type { MaintenanceRunRepository } from './maintenance/maintenance-run-repository.js';
import { mergeMemory } from './memory-merge.js';
import type { MergeConfig } from './memory-merge.js';
import { extractEntities } from './entity-extractor.js';
import { generateId } from '../shared/ids.js';

// ── Config ──────────────────────────────────────────────────────────────

export interface DreamCycleConfig {
  /** Whether the nightly maintenance orchestrator is enabled. */
  enabled: boolean;
  /** IANA timezone (e.g. "Asia/Shanghai"). Empty string = system local. */
  timezone: string;
  /** Hour of day in the configured timezone (0-23). Default 2. */
  hour: number;
  /** Minute of hour (0-59). Default 0. */
  minute: number;
  /** If started more than this many minutes past schedule, skip heavy phases. */
  windowGraceMinutes: number;
  /** Per-phase timeout in ms. Default 30 min. */
  phaseTimeoutMs: number;
  /** Max memory pairs to merge per synthesize phase. */
  synthesizeBatchSize: number;
}

// ── Phase result ─────────────────────────────────────────────────────────

interface PhaseResult {
  phase: string;
  durationMs: number;
  affectedRows: number;
  error?: string;
}

// ── DreamCycle ───────────────────────────────────────────────────────────

export class DreamCycle {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private running = false;

  constructor(
    private config: DreamCycleConfig,
    private db: Database.Database,
    private runRepo: MaintenanceRunRepository,
    private memoryRepo: MemoryRepository,
    private memoryLinkRepo: MemoryLinkRepository,
    private embeddingRepo: EmbeddingRepository,
    private embeddingClient: EmbeddingClient,
    private memoryHygiene: MemoryHygiene,
    private sceneClusterer: SceneClusterer | undefined,
    private mergeConfig: MergeConfig,
    private logger: Logger,
  ) {}

  // ── Lifecycle ────────────────────────────────────────────────────────

  start(): void {
    if (!this.config.enabled) {
      this.logger.info('DreamCycle disabled, skipping start');
      return;
    }
    this.logger.info(
      {
        timezone: this.config.timezone || '(system local)',
        hour: this.config.hour,
        minute: this.config.minute,
        windowGraceMinutes: this.config.windowGraceMinutes,
      },
      'DreamCycle starting — nightly maintenance orchestrator',
    );
    this.scheduleNext();
  }

  async stop(): Promise<void> {
    this.destroyed = true;
    this.cancelTimer();
    this.logger.info('DreamCycle stopped');
  }

  // ── Scheduling ───────────────────────────────────────────────────────

  /**
   * Calculate the epoch-ms of the next occurrence of (hour, minute) in the
   * configured timezone. Uses Intl.DateTimeFormat to get the current date
   * in the target TZ, then builds an ISO string with UTC offset to produce
   * a deterministic epoch value.
   */
  private calculateNextFireTime(): number {
    const now = Date.now();
    const tz = this.config.timezone || undefined; // undefined = system local

    // Get current date components in the target timezone
    const dateFmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const dateStr = dateFmt.format(now); // "2026-06-22"

    // Get the UTC offset string for the target timezone at current time
    const offsetFmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      timeZoneName: 'longOffset',
    });
    const offsetPart = offsetFmt
      .formatToParts(now)
      .find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
    const offsetMatch = offsetPart.match(/[+-]\d{2}:\d{2}/);
    const offset = offsetMatch ? offsetMatch[0] : '+00:00';

    // Build ISO 8601 string with the target time and TZ offset
    const hh = String(this.config.hour).padStart(2, '0');
    const mm = String(this.config.minute).padStart(2, '0');
    const targetISO = `${dateStr}T${hh}:${mm}:00${offset}`;
    const targetEpoch = new Date(targetISO).getTime();

    if (targetEpoch > now) return targetEpoch;

    // Already past today's window → schedule for tomorrow
    // Add 24h of ms; DST transitions may shift by ±1h but that's acceptable
    // for a nightly maintenance window
    return targetEpoch + 24 * 60 * 60 * 1000;
  }

  /** Whether we are within the grace window past the scheduled fire time. */
  private isWithinGraceWindow(): boolean {
    const nextFire = this.calculateNextFireTime();
    if (nextFire > Date.now()) return true;
    // We're past today's window. The last scheduled time was nextFire - 24h.
    const lastScheduled = nextFire - 24 * 60 * 60 * 1000;
    return (Date.now() - lastScheduled) <= this.config.windowGraceMinutes * 60 * 1000;
  }

  private scheduleNext(): void {
    if (this.destroyed) return;
    const nextFire = this.calculateNextFireTime();
    const delayMs = Math.max(60_000, nextFire - Date.now());

    const delayMin = Math.round(delayMs / 60_000);
    const fireDate = new Date(nextFire).toLocaleString();
    this.logger.info(
      { nextFire: fireDate, delayMinutes: delayMin },
      'DreamCycle next run scheduled',
    );

    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.destroyed) return;
      this.runAll()
        .catch((err) =>
          this.logger.error({ err }, 'DreamCycle runAll failed'),
        )
        .finally(() => {
          // Reschedule after completion regardless of outcome
          this.scheduleNext();
        });
    }, delayMs);
    this.timer.unref();
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  // ── Orchestration ────────────────────────────────────────────────────

  /**
   * Run all phases sequentially. Each phase has its own timeout and error
   * isolation — a failure in one phase does not prevent subsequent phases.
   * Heavy phases are skipped when outside the grace window.
   */
  async runAll(): Promise<PhaseResult[]> {
    if (this.running) {
      this.logger.debug('DreamCycle runAll already in progress, skipping');
      return [];
    }
    this.running = true;

    try {
      const withinGrace = this.isWithinGraceWindow();

      if (!withinGrace) {
        this.logger.info(
          'DreamCycle started outside grace window — heavy phases will be skipped',
        );
      }

      const phases: Array<{
        name: string;
        heavy: boolean;
        fn: (signal: AbortSignal) => Promise<number>;
      }> = [
        { name: 'synthesize',   heavy: true,  fn: (s) => this.synthesize(s) },
        { name: 'backlinks',    heavy: false, fn: async (s) => this.backlinks(s) },
        { name: 'extract',      heavy: false, fn: async (s) => this.extract(s) },
        { name: 'sceneCluster', heavy: true,  fn: (s) => this.sceneCluster(s) },
        { name: 'hygiene',      heavy: false, fn: async (s) => this.hygiene(s) },
        { name: 'embed',        heavy: true,  fn: (s) => this.embed(s) },
        { name: 'purge',        heavy: false, fn: async (s) => this.purge(s) },
      ];

      const results: PhaseResult[] = [];

      for (const phase of phases) {
        const jobName = `dreamcycle_${phase.name}`;
        const runId = this.runRepo.startRun(jobName, false);

        // Skip heavy phases when outside grace window
        if (phase.heavy && !withinGrace) {
          this.runRepo.finishRun(runId, 0, 'skipped: outside grace window');
          results.push({
            phase: phase.name,
            durationMs: 0,
            affectedRows: 0,
            error: 'skipped: outside grace window',
          });
          this.logger.info(
            { phase: phase.name },
            'DreamCycle phase skipped (grace window exceeded)',
          );
          continue;
        }

        const start = Date.now();
        const controller = new AbortController();
        const timeoutId = setTimeout(
          () =>
            controller.abort(
              new Error(
                `Phase "${phase.name}" timed out after ${this.config.phaseTimeoutMs}ms`,
              ),
            ),
          this.config.phaseTimeoutMs,
        );

        try {
          const affectedRows = await phase.fn(controller.signal);
          const durationMs = Date.now() - start;
          this.runRepo.finishRun(runId, affectedRows);
          results.push({ phase: phase.name, durationMs, affectedRows });
          this.logger.info(
            { phase: phase.name, affectedRows, durationMs },
            'DreamCycle phase complete',
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const durationMs = Date.now() - start;
          this.runRepo.finishRun(runId, 0, msg);
          results.push({
            phase: phase.name,
            durationMs,
            affectedRows: 0,
            error: msg,
          });
          this.logger.warn(
            { phase: phase.name, err: msg },
            'DreamCycle phase failed, continuing to next phase',
          );
        } finally {
          clearTimeout(timeoutId);
        }
      }

      return results;
    } finally {
      this.running = false;
    }
  }

  // ── Phase 1: Synthesize (merge highly similar memories) ──────────────

  private async synthesize(signal: AbortSignal): Promise<number> {
    const batchSize = this.config.synthesizeBatchSize;

    // Pick random active memories that have embeddings
    const candidates = this.db
      .prepare(
        `SELECT m.id, m.content, m.kind, m.scope, m.scope_key, m.created_at
         FROM memories m
         WHERE m.status = 'active'
           AND EXISTS (SELECT 1 FROM memory_embeddings me WHERE me.memory_id = m.id)
         ORDER BY RANDOM()
         LIMIT ?`,
      )
      .all(batchSize) as Array<{
      id: string;
      content: string;
      kind: string;
      scope: string;
      scope_key: string;
      created_at: string;
    }>;

    if (candidates.length === 0) {
      this.logger.debug('DreamCycle synthesize: no memories with embeddings to process');
      return 0;
    }

    // Track which pairs we've already processed (avoid A↔B then B↔A)
    const processed = new Set<string>();
    let mergedCount = 0;

    for (const memory of candidates) {
      if (signal.aborted) break;

      // Get the embedding for this memory
      const emb = this.embeddingRepo.findByMemoryId(memory.id);
      if (!emb) continue;

      try {
        // Convert Buffer to Float32Array
        const vec = new Float32Array(
          emb.embedding.buffer,
          emb.embedding.byteOffset,
          emb.embedding.byteLength / 4,
        );

        // Find nearest neighbor (limit=2 because first result is self)
        const similar = this.embeddingRepo.searchSimilar(vec, 2);

        // Filter out self-match
        const neighbor = similar.find((r) => r.memory_id !== memory.id);
        if (!neighbor || neighbor.score < this.mergeConfig.mergeThreshold) continue;

        // Avoid duplicate processing
        const pairKey = [memory.id, neighbor.memory_id].sort().join('|');
        if (processed.has(pairKey)) continue;
        processed.add(pairKey);

        // Load both memories in full
        const anchorMem = this.memoryRepo.findById(memory.id);
        const neighborMem = this.memoryRepo.findById(neighbor.memory_id);
        if (!anchorMem || !neighborMem || anchorMem.status !== 'active' || neighborMem.status !== 'active') continue;

        // Try merge — newer content goes into the older memory
        const isNewer =
          new Date(anchorMem.created_at).getTime() >
          new Date(neighborMem.created_at).getTime();
        const existing = isNewer ? neighborMem : anchorMem;
        const newContent = isNewer ? anchorMem.content : neighborMem.content;

        const result = await mergeMemory(
          existing,
          newContent,
          neighbor.score,
          this.mergeConfig,
        );

        if (result && result.mergedContent !== existing.content) {
          // Update the existing memory with merged content
          this.memoryRepo.update(existing.id, {
            content: result.mergedContent,
          });

          // Soft-delete the newer memory (superseded by the merged one)
          const superseded = isNewer ? anchorMem : neighborMem;
          this.memoryRepo.softDelete(superseded.id);

          mergedCount++;
          this.logger.debug(
            {
              existingId: existing.id,
              supersededId: superseded.id,
              similarity: neighbor.score.toFixed(3),
            },
            'DreamCycle synthesize: memories merged',
          );
        }
      } catch (err) {
        // Individual pair failure is non-fatal
        this.logger.debug(
          { memoryId: memory.id, err },
          'DreamCycle synthesize: pair merge failed, continuing',
        );
      }
    }

    return mergedCount;
  }

  // ── Phase 2: Backlinks ───────────────────────────────────────────────

  private backlinks(signal: AbortSignal): number {
    const rows = this.db
      .prepare(
        `SELECT m.id, m.content, m.scope, m.kind FROM memories m
         LEFT JOIN memory_links ml ON ml.source_memory_id = m.id
         WHERE m.status = 'active' AND ml.id IS NULL
         LIMIT 100`,
      )
      .all() as Array<{
      id: string;
      content: string;
      scope: string;
      kind: string;
    }>;

    let count = 0;
    for (const row of rows) {
      if (signal.aborted) break;
      try {
        const entities = extractEntities(row.content, {
          scope: row.scope,
          kind: row.kind,
        });
        for (const ent of entities) {
          if (ent.confidence >= 0.5) {
            this.memoryLinkRepo.create({
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
        // Skip problematic memories
      }
    }

    return count;
  }

  // ── Phase 3: Extract ─────────────────────────────────────────────────

  private extract(signal: AbortSignal): number {
    // Find the newest memory that has links (to use as cursor)
    const newestLinked = this.db
      .prepare(
        `SELECT MAX(m.created_at) as newest
         FROM memories m
         JOIN memory_links ml ON ml.source_memory_id = m.id`,
      )
      .get() as { newest: string | null } | undefined;
    if (!newestLinked?.newest) return 0;

    const rows = this.db
      .prepare(
        `SELECT m.id, m.content, m.scope, m.kind FROM memories m
         LEFT JOIN memory_links ml ON ml.source_memory_id = m.id
         WHERE m.status = 'active' AND ml.id IS NULL AND m.created_at < ?
         LIMIT 100`,
      )
      .all(newestLinked.newest) as Array<{
      id: string;
      content: string;
      scope: string;
      kind: string;
    }>;

    let count = 0;
    for (const row of rows) {
      if (signal.aborted) break;
      try {
        const entities = extractEntities(row.content, {
          scope: row.scope,
          kind: row.kind,
        });
        for (const ent of entities) {
          if (ent.confidence >= 0.5) {
            this.memoryLinkRepo.create({
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

    return count;
  }

  // ── Phase 4: Scene Clustering ────────────────────────────────────────

  private async sceneCluster(signal: AbortSignal): Promise<number> {
    if (!this.sceneClusterer) {
      this.logger.debug('DreamCycle: SceneClusterer not available, skipping');
      return 0;
    }

    try {
      const clusters = await this.sceneClusterer.cluster();
      if (signal.aborted) return 0;
      return clusters.length;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.info({ err: msg }, 'DreamCycle sceneCluster failed');
      throw err;
    }
  }

  // ── Phase 5: Hygiene ─────────────────────────────────────────────────

  private hygiene(_signal: AbortSignal): number {
    const report = this.memoryHygiene.clean();
    if (report.error) {
      this.logger.warn(
        { error: report.error },
        'DreamCycle hygiene reported error',
      );
    }
    return report.cleanedCount;
  }

  // ── Phase 6: Embed ───────────────────────────────────────────────────

  private async embed(signal: AbortSignal): Promise<number> {
    const rows = this.db
      .prepare(
        `SELECT m.id, m.content FROM memories m
         LEFT JOIN memory_embeddings me ON me.memory_id = m.id
         WHERE m.status = 'active' AND me.id IS NULL
         LIMIT 20`,
      )
      .all() as Array<{ id: string; content: string }>;

    let count = 0;
    for (const row of rows) {
      if (signal.aborted) break;
      try {
        const embedding = await this.embeddingClient.embedOne(row.content);
        if (embedding) {
          this.embeddingRepo.create({
            id: generateId(),
            memory_id: row.id,
            embedding,
            model: this.embeddingClient.model,
            dimension: embedding.length,
          });
          count++;
        }
      } catch {
        // Skip individual failures
      }
    }

    return count;
  }

  // ── Phase 7: Purge ───────────────────────────────────────────────────

  private purge(_signal: AbortSignal): number {
    const maxEntries = 10000;
    const row = this.db
      .prepare('SELECT COUNT(*) as cnt FROM embedding_cache')
      .get() as { cnt: number };

    if (row.cnt > maxEntries) {
      const toDelete = Math.ceil(row.cnt * 0.1);
      this.db
        .prepare(
          `DELETE FROM embedding_cache
           WHERE rowid IN (
             SELECT rowid FROM embedding_cache ORDER BY created_at ASC LIMIT ?
           )`,
        )
        .run(toDelete);
      return toDelete;
    }

    return 0;
  }
}
