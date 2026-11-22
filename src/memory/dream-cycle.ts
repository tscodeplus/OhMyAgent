/**
 * DreamCycle — nightly maintenance orchestrator.
 *
 * Inspired by TencentDB-Agent-Memory's ManagedTimer + sequential phase
 * execution patterns. Runs 5 phases in order at a configurable time each
 * day (default 2:00 AM in the system local timezone).
 *
 * Phases (sequential, failure in one does not block the next):
 *   1. embed          — fill missing embeddings (health first: the vector lane
 *                       underlies recall, so it must never be starved by a slow
 *                       consolidation phase)
 *   2. purge          — evict stale embedding cache entries
 *   3. hygiene        — expire old memories (delegates to MemoryHygiene)
 *   4. synthesize     — batch-merge highly similar memory pairs via vector KNN + LLM
 *   5. sceneCluster   — scene clustering (delegates to SceneClusterer)
 *
 * Order rationale: maintenance phases are cheap and bounded, consolidation
 * phases make LLM calls and are the ones that run long. Ordering health before
 * consolidation means a night that only half-finishes still leaves retrieval in
 * a good state (TDAM v2.0.4: a slow consolidation must not block extraction).
 *
 * ## Phase timeouts are enforced, not advisory
 * `phaseTimeoutMs` races the phase promise, so a hung phase is abandoned and
 * the run continues. An `AbortController` alone is not enough on its own: a
 * phase is only cancellable where it polls `signal.aborted`, which is why both
 * the synthesize loop and `SceneClusterer.clusterBatch()` take the signal and
 * check it between items.
 *
 * ## Resumable consolidation
 * The two consolidation phases persist a resume cursor on their own
 * `maintenance_runs` row, so each night advances a bounded slice of the backlog
 * (`synthesizeBatchSize` memories, `sceneClusterBatchSize` scopeKeys) and
 * continues where the previous night stopped — instead of redoing the head of
 * the backlog every night and never reaching the tail.
 *
 * ## Grace window
 * If DreamCycle fires more than `windowGraceMinutes` past the scheduled
 * time (e.g. the process was down overnight), heavy phases (synthesize,
 * sceneCluster, embed) are skipped to avoid a resource spike during user-active
 * hours.
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
import type { EmbeddingRepository } from './repositories/embedding-repository.js';
import type { EmbeddingClient } from '../provider/embedding-client.js';
import type { MemoryHygiene } from './memory-hygiene.js';
import type { MemoryWriter } from './memory-writer.js';
import type { SceneClusterer } from './scene-cluster.js';
import type { MaintenanceRunRepository } from './maintenance/maintenance-run-repository.js';
import { mergeMemory, appendMemoryDispute } from './memory-merge.js';
import type { MergeConfig } from './memory-merge.js';
import { generateId } from '../shared/ids.js';
import { parseEpochMs } from '../shared/timestamp.js';

/**
 * Phase names in execution order.
 *
 * Exported because `/api/memory/pipeline/status` renders exactly this list: the
 * route and this class each used to carry their own copy, and the copies
 * drifted — the panel reported phases (`backlinks`, `extract`) that no longer
 * had a runner, so they showed "never ran" forever.
 */
export const DREAMCYCLE_PHASE_NAMES = [
  // Cheap, bounded, and directly protective of recall — always run first so a
  // slow consolidation phase cannot starve them (see the order rationale in the
  // file header).
  'embed',
  'purge',
  'hygiene',
  'synthesize',
  'sceneCluster',
] as const;

export type DreamCyclePhaseName = (typeof DREAMCYCLE_PHASE_NAMES)[number];

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
  /** Max scopeKeys to cluster per sceneCluster phase (0 = all). */
  sceneClusterBatchSize: number;
  /** On startup, run a catch-up cycle if the last run is older than 24h
   * (covers dev machines / Termux devices that are off at the nightly fire
   * time; without catch-up the cycle can be missed forever). Default true. */
  catchUpOnStart: boolean;
}

// ── Phase result ─────────────────────────────────────────────────────────

interface PhaseResult {
  phase: string;
  durationMs: number;
  affectedRows: number;
  error?: string;
}

/** What a phase needs to persist its own progress (the cursor lives on its own
 * `maintenance_runs` row, which `runAll` creates before the phase starts). */
interface PhaseContext {
  runId: string;
  jobName: string;
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
    private embeddingRepo: EmbeddingRepository,
    private embeddingClient: EmbeddingClient,
    private memoryHygiene: MemoryHygiene,
    private sceneClusterer: SceneClusterer | undefined,
    private mergeConfig: MergeConfig,
    private logger: Logger,
    /**
     * Optional: the shared writer, used to refresh derived data after a merge
     * (vectors + terms). Appended after `logger` so the existing positional
     * call sites stay valid; without it the merge path falls back to dropping
     * the stale vector so the backfill queue re-embeds the row.
     */
    private memoryWriter?: MemoryWriter,
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
    if (this.config.catchUpOnStart && this.shouldCatchUpOnStart()) {
      this.logger.info('DreamCycle catch-up: last run older than 24h — running now');
      // Fire-and-forget catch-up; the regular nightly timer is still armed and
      // runAll() itself deduplicates concurrent invocations.
      this.runAll({ force: true }).catch((err) =>
        this.logger.warn({ err }, 'DreamCycle startup catch-up failed'),
      );
    }
    this.scheduleNext();
  }

  /**
   * True when no DreamCycle run is recorded in maintenance_runs, or the last
   * recorded run started more than 24h ago (nightly cadence was missed).
   */
  shouldCatchUpOnStart(): boolean {
    const last = this.runRepo.getLastRunByPrefix('dreamcycle_');
    if (!last) return true;
    const lastAt = Number(last.started_at);
    if (!Number.isFinite(lastAt) || lastAt <= 0) return true;
    return Date.now() - lastAt > 24 * 60 * 60 * 1000;
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
    const offsetPart =
      offsetFmt.formatToParts(now).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
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
    return Date.now() - lastScheduled <= this.config.windowGraceMinutes * 60 * 1000;
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
        .catch((err) => this.logger.error({ err }, 'DreamCycle runAll failed'))
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
  /**
   * Run all phases sequentially. Each phase has its own timeout and error
   * isolation — a failure in one phase does not prevent subsequent phases.
   * Heavy phases are skipped when outside the grace window, unless
   * `options.force` is set (manual trigger / missed-nightly catch-up).
   */
  async runAll(options?: { force?: boolean }): Promise<PhaseResult[]> {
    if (this.running) {
      this.logger.debug('DreamCycle runAll already in progress, skipping');
      return [];
    }
    this.running = true;

    try {
      const withinGrace = options?.force === true || this.isWithinGraceWindow();

      if (!withinGrace) {
        this.logger.info('DreamCycle started outside grace window — heavy phases will be skipped');
      }

      const runners: Record<
        DreamCyclePhaseName,
        { heavy: boolean; fn: (signal: AbortSignal, ctx: PhaseContext) => Promise<number> }
      > = {
        synthesize: { heavy: true, fn: (s, ctx) => this.synthesize(s, ctx) },
        sceneCluster: { heavy: true, fn: (s, ctx) => this.sceneCluster(s, ctx) },
        hygiene: { heavy: false, fn: async (s) => this.hygiene(s) },
        embed: { heavy: true, fn: (s) => this.embed(s) },
        purge: { heavy: false, fn: async (s) => this.purge(s) },
      };
      // `Record<DreamCyclePhaseName, …>` is exhaustive: a name added to
      // DREAMCYCLE_PHASE_NAMES without a runner fails the build, and
      // `DREAMCYCLE_PHASE_NAMES.map` is what keeps the run order.
      const phases = DREAMCYCLE_PHASE_NAMES.map((name) => ({ name, ...runners[name] }));

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
        let timedOut = false;
        let timeoutId: ReturnType<typeof setTimeout> | undefined;

        // The abort is advisory in the sense that each phase decides where it
        // polls `signal.aborted`; the race below is what guarantees the run
        // itself cannot hang. `scheduleNext()` is called from the finally of the
        // run that armed the timer, so "pending forever" would mean the nightly
        // cycle never re-arms.
        const timeoutPromise = new Promise<never>((_, reject) => {
          const timer = setTimeout(() => {
            timedOut = true;
            const err = new Error(
              `Phase "${phase.name}" timed out after ${this.config.phaseTimeoutMs}ms`,
            );
            controller.abort(err);
            reject(err);
          }, this.config.phaseTimeoutMs);
          timer.unref();
          timeoutId = timer;
        });

        // The abandoned run keeps going after the timeout wins the race. Its
        // late settlement must not become an unhandled rejection (the gateway
        // shuts down on those), so it is handled here and logged at debug.
        const guardedRun = (signal: AbortSignal, ctx: PhaseContext) =>
          phase.fn(signal, ctx).catch((err: unknown) => {
            if (!timedOut) throw err;
            this.logger.debug(
              { phase: phase.name, err: err instanceof Error ? err.message : String(err) },
              'DreamCycle phase rejected after its timeout — ignored',
            );
            return -1;
          });
        try {
          const affectedRows = await Promise.race([
            guardedRun(controller.signal, { runId, jobName }),
            timeoutPromise,
          ]);
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

  // ── Phase 4: Synthesize (merge highly similar memories) ──────────────

  private async synthesize(signal: AbortSignal, ctx: PhaseContext): Promise<number> {
    const batchSize = this.config.synthesizeBatchSize;

    // Continue after the rowid the previous run stopped at instead of sampling
    // the whole table at random: random batches never converge on a backlog
    // (the tail can go unvisited indefinitely) and cannot resume after a
    // timeout. `'0'` means the previous run reached the end and wrapped.
    const previousCursor = Number(this.runRepo.getLastCursor(ctx.jobName, ctx.runId) ?? 0) || 0;

    const selectBatch = (afterRowId: number, limit: number) =>
      this.db
        .prepare(
          `SELECT m.rowid AS row_id, m.id, m.content, m.kind, m.scope, m.scope_key, m.created_at
             FROM memories m
            WHERE m.status = 'active'
              AND m.rowid > ?
              AND EXISTS (SELECT 1 FROM memory_embeddings me WHERE me.memory_id = m.id)
            ORDER BY m.rowid ASC
            LIMIT ?`,
        )
        .all(afterRowId, limit) as Array<{
        row_id: number;
        id: string;
        content: string;
        kind: string;
        scope: string;
        scope_key: string;
        created_at: string;
      }>;

    let candidates = selectBatch(previousCursor, batchSize);
    const wrapped = candidates.length === 0 && previousCursor > 0;
    if (wrapped) {
      // Past the tail — start the next sweep from the head.
      candidates = selectBatch(0, batchSize);
    }

    // A short batch means this sweep reached the end of the table; the next run
    // then wraps to the head instead of continuing from `previousCursor`.
    const reachedTail = wrapped || candidates.length < batchSize;

    if (candidates.length === 0) {
      this.logger.debug('DreamCycle synthesize: no memories with embeddings to process');
      return 0;
    }

    // Track which pairs we've already processed (avoid A↔B then B↔A)
    const processed = new Set<string>();
    let mergedCount = 0;
    let examined = 0;

    for (const memory of candidates) {
      if (signal.aborted) break;

      examined++;
      // Advance the resume point as each row is examined, not at the end: an
      // aborted phase never reaches its own tail, and a batch examined twice is
      // wasted LLM work.
      this.runRepo.setCursor(ctx.runId, String(memory.row_id));

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
        if (
          !anchorMem ||
          !neighborMem ||
          anchorMem.status !== 'active' ||
          neighborMem.status !== 'active'
        )
          continue;

        // Try merge — newer content goes into the older memory
        const isNewer = parseEpochMs(anchorMem.created_at) > parseEpochMs(neighborMem.created_at);
        const existing = isNewer ? neighborMem : anchorMem;
        const newContent = isNewer ? anchorMem.content : neighborMem.content;

        const result = await mergeMemory(existing, newContent, neighbor.score, this.mergeConfig);

        if (result && 'judgedRelation' in result && result.judgedRelation === 'contradicts') {
          // Judged conflict (kernel M2 `memory.merge`): keep BOTH rows — mark
          // the older record with the dispute marker, same semantics as the
          // MemoryWriter contradicts path. No soft-delete of the newer row.
          this.memoryRepo.update(existing.id, {
            metadata: appendMemoryDispute(existing.metadata),
          });
          mergedCount++;
          this.logger.debug(
            { existingId: existing.id, otherId: isNewer ? anchorMem.id : neighborMem.id },
            'DreamCycle synthesize: judged conflict — dispute marker set, both kept',
          );
          continue;
        }

        if (result && 'mergedContent' in result && result.mergedContent !== existing.content) {
          // Update the existing memory with merged content
          this.memoryRepo.update(existing.id, {
            content: result.mergedContent,
          });

          // Content changed → derived data has to follow, exactly as the
          // writer's merge path does (`MemoryWriter.refreshDerivedData`). The
          // FTS lane is kept current by `memoryRepository.update`, but vectors
          // and terms are not, and nothing downstream re-derives them: the
          // `embed` phase and `embedding_backfill` only fill rows with NO
          // embedding (`me.id IS NULL`). A stale vector would therefore survive
          // forever and every later dedup/merge would compare the row against
          // its pre-merge text.
          if (this.memoryWriter) {
            await this.memoryWriter.refreshDerivedData(existing.id, result.mergedContent);
          } else {
            // Minimal wiring (tests, or a deployment without the writer): drop
            // the wrong vector so the backfill queue re-embeds the row instead
            // of keeping it.
            this.embeddingRepo.deleteByMemoryId(existing.id);
          }

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

    // A completed sweep that reached the tail restarts from the head next time;
    // an aborted one keeps the row it got to so the next run resumes there.
    if (reachedTail && examined === candidates.length) {
      this.runRepo.setCursor(ctx.runId, '0');
    }

    return mergedCount;
  }

  // ── Phase 5: Scene Clustering ────────────────────────────────────────

  /**
   * Cluster the user's memories into scene documents — one bounded slice of
   * scopeKeys per night, resumable via this phase's own cursor.
   *
   * The batch cap is what makes the phase fit inside `phaseTimeoutMs` on a large
   * backlog, and the cursor is what makes a capped run progress instead of
   * re-clustering the same head every night. A slice that reaches the tail of
   * the scopeKey list resets the cursor, so the next night starts from the head
   * again (the scenes are a rolling view, not an append-only log).
   */
  private async sceneCluster(signal: AbortSignal, ctx: PhaseContext): Promise<number> {
    if (!this.sceneClusterer) {
      this.logger.debug('DreamCycle: SceneClusterer not available, skipping');
      return 0;
    }

    const cursor = this.runRepo.getLastCursor(ctx.jobName, ctx.runId) ?? '';
    const summary = this.sceneClusterer.clusterBatch({
      signal,
      afterScopeKey: cursor || undefined,
      maxScopeKeys: this.config.sceneClusterBatchSize,
      // Persisted per committed scopeKey, not once at the end: an aborted or
      // timed-out phase never reaches its own tail, and re-clustering committed
      // scopeKeys is wasted work (the phase timeout abandons the promise but the
      // run keeps going long enough to write the rows).
      onScopeKeyDone: (scopeKey) => this.runRepo.setCursor(ctx.runId, scopeKey),
    });

    for (const { scopeKey, message } of summary.errors) {
      this.logger.info({ scopeKey, err: message }, 'DreamCycle sceneCluster scopeKey failed');
    }

    if (signal.aborted) {
      // Keep the cursor where the last committed scopeKey left it.
      return summary.clusters.length;
    }

    if (summary.reachedEnd) {
      this.runRepo.setCursor(ctx.runId, '');
    }

    if (summary.clusters.length === 0 && summary.errors.length > 0) {
      // Nothing committed and something broke: surface it so the phase row is
      // marked failed instead of reporting a quiet zero-row success.
      throw new Error(summary.errors[0].message);
    }

    return summary.clusters.length;
  }

  // ── Phase 3: Hygiene ─────────────────────────────────────────────────

  private hygiene(_signal: AbortSignal): number {
    const report = this.memoryHygiene.clean();
    if (report.error) {
      this.logger.warn({ error: report.error }, 'DreamCycle hygiene reported error');
    }
    return report.cleanedCount;
  }

  // ── Phase 1: Embed (health first) ───────────────────────────────────────────────────

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

  // ── Phase 2: Purge ───────────────────────────────────────────────────

  private purge(_signal: AbortSignal): number {
    const maxEntries = 10000;
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM embedding_cache').get() as {
      cnt: number;
    };

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
