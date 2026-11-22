/**
 * DreamCycle resume cursor (`maintenance_runs.cursor`, migration v39).
 *
 * The synthesize phase used to sample its batch with `ORDER BY RANDOM()`, which
 * cannot converge on a backlog and cannot resume after a timeout. These tests
 * pin the two behaviours the cursor exists for: it advances past rows already
 * examined, and it wraps to the head once a sweep reaches the tail.
 *
 * The merge itself is disabled here (`mergeThreshold: 2` can never be reached),
 * so the phase walks its batch without calling the LLM — what is under test is
 * the cursor bookkeeping, not the merge.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/memory/db';
import { DreamCycle, type DreamCycleConfig } from '../../src/memory/dream-cycle';
import { MaintenanceRunRepository } from '../../src/memory/maintenance/maintenance-run-repository';
import { MemoryRepository } from '../../src/memory/repositories/memory-repository';
import { EmbeddingRepository } from '../../src/memory/repositories/embedding-repository';

const logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  trace() {},
  child() {
    return logger;
  },
} as never;

describe('DreamCycle synthesize cursor', () => {
  let db: Database.Database;
  let runRepo: MaintenanceRunRepository;
  let memoryRepo: MemoryRepository;
  let embeddingRepo: EmbeddingRepository;

  beforeEach(() => {
    db = openDatabase(':memory:');
    runRepo = new MaintenanceRunRepository(db);
    memoryRepo = new MemoryRepository(db);
    embeddingRepo = new EmbeddingRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  function seedMemories(count: number): void {
    for (let i = 0; i < count; i++) {
      memoryRepo.create({
        id: `mem-${i}`,
        scope: 'session',
        scope_key: 's1',
        kind: 'fact',
        content: `fact number ${i}`,
      });
      // One-hot-ish vectors so `searchSimilar` has something to look at without
      // any two rows crossing the merge threshold used below.
      const vec = new Float32Array(8);
      vec[i % 8] = 1;
      embeddingRepo.create({
        id: `emb-${i}`,
        memory_id: `mem-${i}`,
        embedding: vec,
        model: 'test',
        dimension: 8,
      });
    }
  }

  function buildDreamCycle(batchSize: number): DreamCycle {
    const config: DreamCycleConfig = {
      enabled: true,
      timezone: '',
      hour: 2,
      minute: 0,
      windowGraceMinutes: 120,
      phaseTimeoutMs: 60_000,
      synthesizeBatchSize: batchSize,
      sceneClusterBatchSize: 8,
      catchUpOnStart: false,
    };
    return new DreamCycle(
      config,
      db,
      runRepo,
      memoryRepo,
      embeddingRepo,
      { model: 'test', embedOne: async () => undefined } as never,
      // Hygiene / scene clustering don't participate in this test.
      { clean: () => ({ cleanedCount: 0 }) } as never,
      undefined,
      // An unreachable threshold: the phase walks the batch without merging.
      { mergeThreshold: 2, logger },
      logger,
    );
  }

  function synthesizeRow(): { cursor: string | null; status: string } | undefined {
    return db
      .prepare(
        `SELECT cursor, status FROM maintenance_runs
          WHERE job_name = 'dreamcycle_synthesize'
          ORDER BY CAST(started_at AS INTEGER) DESC, rowid DESC LIMIT 1`,
      )
      .get() as { cursor: string | null; status: string } | undefined;
  }

  it('advances past the batch instead of re-sampling from the head', async () => {
    seedMemories(5);

    await buildDreamCycle(2).runAll({ force: true });
    const first = synthesizeRow();
    expect(first?.status).toBe('success');
    // Two rows examined → the cursor names the second one's rowid.
    expect(first?.cursor).toBe('2');

    await buildDreamCycle(2).runAll({ force: true });
    const second = synthesizeRow();
    // Resumed after rowid 2, so this batch covers rowids 3 and 4 — and since a
    // 2-row batch is short of the limit... it is exactly the limit, so the
    // cursor stays mid-table.
    expect(second?.cursor).toBe('4');
  });

  it('wraps to the head once a sweep reaches the tail', async () => {
    seedMemories(3);

    await buildDreamCycle(5).runAll({ force: true });
    const first = synthesizeRow();
    expect(first?.status).toBe('success');
    // Short batch (3 < 5) → the sweep is complete, next run starts over.
    expect(first?.cursor).toBe('0');

    await buildDreamCycle(2).runAll({ force: true });
    const second = synthesizeRow();
    // Wrapped run starts at the head again and stops after two rows.
    expect(second?.cursor).toBe('2');
  });

  it('keeps the cursor of a crashed predecessor instead of ignoring it', async () => {
    seedMemories(4);
    // A run that died mid-batch: status left 'running', cursor advanced to 2.
    const deadId = runRepo.startRun('dreamcycle_synthesize', false);
    runRepo.setCursor(deadId, '2');

    await buildDreamCycle(2).runAll({ force: true });
    const latest = synthesizeRow();
    expect(latest?.status).toBe('success');
    // 2 was the last examined rowid of the dead run → this batch is 3 and 4.
    expect(latest?.cursor).toBe('4');
  });
});
