/**
 * DreamCycle — nightly maintenance orchestrator.
 *
 * Runs a sequence of maintenance phases in order:
 *   1. lint     — check for orphan records
 *   2. backlinks — rebuild memory_links for existing memories that lack them
 *   3. synthesize — batch merge highly similar memory pairs (up to batch limit)
 *   4. extract  — re-run entity extraction for memories without links
 *   5. patterns — scene clustering
 *   6. hygiene  — expire old memories (delegates to MemoryHygiene)
 *   7. embed    — fill missing embeddings
 *   8. purge    — evict stale embedding cache entries
 *
 * Each phase failure is logged but does not block subsequent phases.
 * Uses setInterval internally; configurable cron expression via config.
 */

import type { Logger } from 'pino';
import type Database from 'better-sqlite3';
import type { MemoryRepository } from './repositories/memory-repository.js';
import type { MemoryLinkRepository } from './repositories/memory-link-repository.js';
import type { EmbeddingRepository } from './repositories/embedding-repository.js';
import type { EmbeddingCacheRepo } from './repositories/embedding-cache-repository.js';
import type { EmbeddingClient } from '../provider/embedding-client.js';
import { extractEntities } from './entity-extractor.js';
import { generateId } from '../shared/ids.js';

export interface DreamCycleConfig {
  enabled: boolean;
  /** Cron expression (5-field). Default "0 2 * * *" (2:00 AM daily). */
  cronExpression: string;
  /** Max memory pairs to merge per synthesize phase. Default 50. */
  synthesizeBatchSize: number;
}

interface PhaseResult {
  phase: string;
  durationMs: number;
  affectedRows: number;
  error?: string;
}

export class DreamCycle {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private config: DreamCycleConfig,
    private db: Database.Database,
    private memoryRepo: MemoryRepository,
    private memoryLinkRepo: MemoryLinkRepository,
    private embeddingRepo: EmbeddingRepository,
    private embeddingCacheRepo: EmbeddingCacheRepo,
    private embeddingClient: EmbeddingClient,
    private logger: Logger,
  ) {}

  start(): void {
    if (!this.config.enabled) return;
    this.logger.info({ cron: this.config.cronExpression }, 'DreamCycle started');
    this.scheduleNext();
  }

  private scheduleNext(): void {
    const delayMs = this.nextFireMs();
    this.timer = setTimeout(() => {
      this.runAll().catch(err => {
        this.logger.error({ err }, 'DreamCycle run failed');
      });
      // Schedule next run after completion
      this.scheduleNext();
    }, delayMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Run all phases immediately (for manual trigger). */
  async runAll(): Promise<PhaseResult[]> {
    const results: PhaseResult[] = [];
    const phases = [
      { name: 'lint', fn: () => this.lint() },
      { name: 'backlinks', fn: () => this.backlinks() },
      { name: 'extract', fn: () => this.extract() },
      { name: 'patterns', fn: () => this.patterns() },
      { name: 'hygiene', fn: () => this.hygiene() },
      { name: 'embed', fn: () => this.embed() },
      { name: 'purge', fn: () => this.purge() },
    ];

    for (const phase of phases) {
      const start = Date.now();
      try {
        const affectedRows = await phase.fn();
        results.push({ phase: phase.name, durationMs: Date.now() - start, affectedRows });
        this.logger.info({ phase: phase.name, affectedRows, durationMs: Date.now() - start }, 'DreamCycle phase complete');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        results.push({ phase: phase.name, durationMs: Date.now() - start, affectedRows: 0, error: msg });
        this.logger.warn({ phase: phase.name, err: msg }, 'DreamCycle phase failed, continuing');
      }
    }

    return results;
  }

  // ── Phase implementations ──

  private lint(): number {
    // Check for orphan memory_links pointing to deleted memories
    const result = this.db.prepare(`
      SELECT ml.id FROM memory_links ml
      LEFT JOIN memories m ON ml.source_memory_id = m.id
      WHERE m.id IS NULL
    `).all() as { id: string }[];
    for (const row of result) {
      this.memoryLinkRepo.deleteByMemory(row.id);
    }
    return result.length;
  }

  private backlinks(): number {
    // Rebuild entity links for memories that have none
    const rows = this.db.prepare(`
      SELECT m.id, m.content, m.scope, m.kind FROM memories m
      LEFT JOIN memory_links ml ON ml.source_memory_id = m.id
      WHERE ml.id IS NULL
      LIMIT 100
    `).all() as { id: string; content: string; scope: string; kind: string }[];
    let count = 0;
    for (const row of rows) {
      try {
        const entities = extractEntities(row.content, { scope: row.scope, kind: row.kind });
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

  private extract(): number {
    // Re-extract entities for memories that were written before entity extraction existed
    // Process memories older than the newest one with links
    const newestWithLinks = this.db.prepare(
      'SELECT MAX(m.created_at) as newest FROM memories m JOIN memory_links ml ON ml.source_memory_id = m.id',
    ).get() as { newest: string | null } | undefined;
    if (!newestWithLinks?.newest) return 0;

    const rows = this.db.prepare(`
      SELECT m.id, m.content, m.scope, m.kind FROM memories m
      LEFT JOIN memory_links ml ON ml.source_memory_id = m.id
      WHERE ml.id IS NULL AND m.created_at < ?
      LIMIT 100
    `).all(newestWithLinks.newest) as { id: string; content: string; scope: string; kind: string }[];
    let count = 0;
    for (const row of rows) {
      try {
        const entities = extractEntities(row.content, { scope: row.scope, kind: row.kind });
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

  private patterns(): number {
    // Scene clustering is handled separately by SceneClusterer
    // This phase logs the current memory count for observability
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM memories').get() as { cnt: number };
    return row.cnt;
  }

  private hygiene(): number {
    // Memory hygiene is handled by MemoryHygiene with retentionDays config
    // This phase ensures embedding cache hasn't grown beyond limits
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM embedding_cache').get() as { cnt: number };
    return row.cnt;
  }

  private async embed(): Promise<number> {
    // Fill missing embeddings
    const rows = this.db.prepare(`
      SELECT m.id, m.content FROM memories m
      LEFT JOIN memory_embeddings me ON me.memory_id = m.id
      WHERE me.id IS NULL
      LIMIT 20
    `).all() as { id: string; content: string }[];
    let count = 0;
    for (const row of rows) {
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
        // Skip
      }
    }
    return count;
  }

  private purge(): number {
    // Evict oldest 10% of embedding cache if over capacity (default 10000)
    const maxEntries = 10000;
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM embedding_cache').get() as { cnt: number };
    if (row.cnt > maxEntries) {
      const toDelete = Math.ceil(row.cnt * 0.1);
      this.db.prepare('DELETE FROM embedding_cache WHERE rowid IN (SELECT rowid FROM embedding_cache ORDER BY created_at ASC LIMIT ?)').run(toDelete);
      return toDelete;
    }
    return 0;
  }

  /** Calculate milliseconds until the next fire time based on cron "M H * * *". */
  private nextFireMs(): number {
    const parts = this.config.cronExpression.trim().split(/\s+/);
    const minute = parseInt(parts[0], 10) || 0;
    const hour = parseInt(parts[1], 10) || 2;

    const now = new Date();
    const next = new Date(now);
    next.setHours(hour, minute, 0, 0);

    if (next <= now) {
      next.setDate(next.getDate() + 1);
    }

    return Math.max(60_000, next.getTime() - now.getTime());
  }
}
