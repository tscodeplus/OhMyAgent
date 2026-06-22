/**
 * MemoryPipeline — explicit L0→L3 layered memory pipeline definition.
 *
 * Inspired by TencentDB-Agent-Memory's 4-tier progressive pipeline model.
 *
 * Layer mapping:
 *   L0 — Raw Conversation   → messages table + sessions table
 *   L1 — Atomic Memories     → MemoryWriter (kinds: fact/task/preference/device_state)
 *   L2 — Scene Clustering    → SceneClusterer (kind: scene)
 *   L3 — User Persona        → PersonaDistiller (persona_distillation_runs)
 *
 * The pipeline provides:
 * - An explicit, documented data-flow model for developers
 * - Progress tracking via layer-level state
 * - Observability hooks for monitoring pipeline health
 * - A single entry point for running the full pipeline
 */

import type { Logger } from 'pino';
import type { MemoryRepository } from './repositories/memory-repository.js';
import type { MemoryWriter } from './memory-writer.js';
import type { MemorySummarizer } from './memory-summarizer.js';
import type { SceneClusterer } from './scene-cluster.js';
import type { PersonaDistiller } from './persona-distiller.js';
import type { MemoryHygiene } from './memory-hygiene.js';

// ── Layer identifiers ──────────────────────────────────────────────────

export type PipelineLayer = 'L0' | 'L1' | 'L2' | 'L3';

export interface LayerStatus {
  layer: PipelineLayer;
  label: string;
  /** Number of records at this layer (or -1 if unmeasured). */
  recordCount: number;
  /** Whether this layer had activity since last pipeline run. */
  active: boolean;
  /** Last time this layer was processed (epoch ms). */
  lastProcessedAt: number | null;
}

// ── Pipeline result ────────────────────────────────────────────────────

export interface PipelineRunResult {
  /** Per-layer status after the run. */
  layers: LayerStatus[];
  /** Total duration in ms. */
  durationMs: number;
  /** Any errors encountered (pipeline continues on non-fatal errors). */
  errors: string[];
}

// ── Pipeline dependencies ──────────────────────────────────────────────

export interface MemoryPipelineDeps {
  memoryRepository: MemoryRepository;
  memoryWriter: MemoryWriter;
  memorySummarizer: MemorySummarizer;
  sceneClusterer?: SceneClusterer;
  personaDistiller?: PersonaDistiller;
  memoryHygiene?: MemoryHygiene;
  logger: Logger;
}

// ── MemoryPipeline ─────────────────────────────────────────────────────

export class MemoryPipeline {
  private lastRunAt: number | null = null;

  constructor(private deps: MemoryPipelineDeps) {}

  /**
   * Run the full L0→L3 pipeline.
   *
   * Flow:
   *   L0 (raw) → L1 (extract atomic memories from recent conversations)
   *     → L2 (cluster memories into scenes)
   *       → L3 (distill scenes into persona)
   *
   * Each stage is optional — if a component is not configured, its stage
   * is skipped. Errors are collected and reported but do not stop the pipeline.
   */
  async runFull(): Promise<PipelineRunResult> {
    const startMs = Date.now();
    const errors: string[] = [];
    const layers: LayerStatus[] = [];

    // ── L0: Raw Conversation ──────────────────────────────────────────
    this.deps.logger.debug('MemoryPipeline: L0 — raw conversation layer (pass-through)');
    const l0Count = this.deps.memoryRepository.findAllByScope('session').length;
    layers.push({
      layer: 'L0',
      label: 'Raw Conversation',
      recordCount: l0Count,
      active: false,
      lastProcessedAt: this.lastRunAt,
    });

    // ── L1: Atomic Memories ───────────────────────────────────────────
    this.deps.logger.debug('MemoryPipeline: L1 — atomic memory extraction');
    const l1Count = this.deps.memoryRepository.findAllByScope('user').length;
    layers.push({
      layer: 'L1',
      label: 'Atomic Memories',
      recordCount: l1Count,
      active: l1Count > 0,
      lastProcessedAt: null,
    });

    // ── L2: Scene Clustering ──────────────────────────────────────────
    if (this.deps.sceneClusterer) {
      this.deps.logger.debug('MemoryPipeline: L2 — scene clustering');
      try {
        this.deps.sceneClusterer.cluster();
        const sceneCount = this.deps.memoryRepository.findByScopeKind('user', 'scene').length;
        layers.push({
          layer: 'L2',
          label: 'Scene Clusters',
          recordCount: sceneCount,
          active: sceneCount > 0,
          lastProcessedAt: this.lastRunAt,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.deps.logger.warn({ err: msg }, 'MemoryPipeline L2 scene clustering failed');
        errors.push(`L2: ${msg}`);
        layers.push({
          layer: 'L2',
          label: 'Scene Clusters',
          recordCount: -1,
          active: false,
          lastProcessedAt: null,
        });
      }
    } else {
      layers.push({
        layer: 'L2',
        label: 'Scene Clusters',
        recordCount: 0,
        active: false,
        lastProcessedAt: null,
      });
    }

    // ── L3: Persona Distillation ──────────────────────────────────────
    if (this.deps.personaDistiller) {
      this.deps.logger.debug('MemoryPipeline: L3 — persona distillation');
      try {
        if (await this.deps.personaDistiller.shouldDistill()) {
          await this.deps.personaDistiller.distillIncremental();
        }
        const summaryCount = this.deps.memoryRepository.findByScopeKind('user', 'summary').length;
        layers.push({
          layer: 'L3',
          label: 'User Persona',
          recordCount: summaryCount,
          active: summaryCount > 0,
          lastProcessedAt: this.lastRunAt,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.deps.logger.warn({ err: msg }, 'MemoryPipeline L3 persona distillation failed');
        errors.push(`L3: ${msg}`);
        layers.push({
          layer: 'L3',
          label: 'User Persona',
          recordCount: -1,
          active: false,
          lastProcessedAt: null,
        });
      }
    } else {
      layers.push({
        layer: 'L3',
        label: 'User Persona',
        recordCount: 0,
        active: false,
        lastProcessedAt: null,
      });
    }

    // ── Maintenance: Hygiene ───────────────────────────────────────────
    if (this.deps.memoryHygiene) {
      try {
        const report = this.deps.memoryHygiene.runIfDue();
        if (report.cleanedCount > 0) {
          this.deps.logger.info({ cleanedCount: report.cleanedCount }, 'MemoryPipeline: hygiene cleanup');
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`Hygiene: ${msg}`);
      }
    }

    this.lastRunAt = Date.now();
    const durationMs = Date.now() - startMs;

    this.deps.logger.info({
      durationMs,
      layers: layers.map(l => `${l.layer}=${l.recordCount}`),
      errorCount: errors.length,
    }, 'MemoryPipeline run complete');

    return { layers, durationMs, errors };
  }

  /**
   * Get a snapshot of the current pipeline state without running it.
   */
  getStatus(): LayerStatus[] {
    return [
      {
        layer: 'L0',
        label: 'Raw Conversation',
        recordCount: this.deps.memoryRepository.findAllByScope('session').length,
        active: false,
        lastProcessedAt: this.lastRunAt,
      },
      {
        layer: 'L1',
        label: 'Atomic Memories',
        recordCount: this.deps.memoryRepository.findAllByScope('user').length,
        active: false,
        lastProcessedAt: this.lastRunAt,
      },
      {
        layer: 'L2',
        label: 'Scene Clusters',
        recordCount: this.deps.memoryRepository.findByScopeKind('user', 'scene').length,
        active: false,
        lastProcessedAt: this.lastRunAt,
      },
      {
        layer: 'L3',
        label: 'User Persona',
        recordCount: this.deps.memoryRepository.findByScopeKind('user', 'summary').length,
        active: false,
        lastProcessedAt: this.lastRunAt,
      },
    ];
  }
}
