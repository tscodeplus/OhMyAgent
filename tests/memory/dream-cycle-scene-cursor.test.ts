/**
 * DreamCycle sceneCluster cursor (`maintenance_runs.cursor`, migration v39).
 *
 * The phase used to rebuild every scopeKey in one call. On a backlog larger than
 * one `phaseTimeoutMs` that is not progress at all: the phase is abandoned (and
 * the run kept going long enough to rewrite the same head next night). These
 * tests pin the slice bookkeeping: one bounded slice per night, resume after the
 * last committed scopeKey, and a wrap once the slice reaches the tail.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { openDatabase } from '../../src/memory/db';
import { DreamCycle, type DreamCycleConfig } from '../../src/memory/dream-cycle';
import { MaintenanceRunRepository } from '../../src/memory/maintenance/maintenance-run-repository';
import { MemoryRepository } from '../../src/memory/repositories/memory-repository';
import { EmbeddingRepository } from '../../src/memory/repositories/embedding-repository';
import { SceneClusterer } from '../../src/memory/scene-cluster';

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

describe('DreamCycle sceneCluster cursor', () => {
  let db: Database.Database;
  let runRepo: MaintenanceRunRepository;
  let memoryRepo: MemoryRepository;
  let embeddingRepo: EmbeddingRepository;
  let baseDir: string;
  let idCounter = 0;

  beforeEach(() => {
    db = openDatabase(':memory:');
    runRepo = new MaintenanceRunRepository(db);
    memoryRepo = new MemoryRepository(db);
    embeddingRepo = new EmbeddingRepository(db);
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dreamcycle-scene-cursor-'));
    idCounter = 0;
  });

  afterEach(() => {
    db.close();
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  function seedWindow(scopeKey: string, createdAt: string, count = 6): void {
    for (let i = 0; i < count; i++) {
      idCounter++;
      db.prepare(
        `INSERT INTO memories (id, scope, scope_key, kind, content, created_at)
         VALUES (?, 'user', ?, 'fact', ?, ?)`,
      ).run(`mem-${scopeKey}-${idCounter}`, scopeKey, `${scopeKey} ${i}`, createdAt);
    }
  }

  function buildDreamCycle(sceneClusterBatchSize: number): DreamCycle {
    const config: DreamCycleConfig = {
      enabled: true,
      timezone: '',
      hour: 2,
      minute: 0,
      windowGraceMinutes: 120,
      phaseTimeoutMs: 60_000,
      synthesizeBatchSize: 50,
      sceneClusterBatchSize,
      catchUpOnStart: false,
    };
    const sceneClusterer = new SceneClusterer(memoryRepo, baseDir, {}, logger);
    return new DreamCycle(
      config,
      db,
      runRepo,
      memoryRepo,
      embeddingRepo,
      { model: 'test', embedOne: async () => undefined } as never,
      { clean: () => ({ cleanedCount: 0 }) } as never,
      sceneClusterer,
      // Unreachable threshold: the synthesize phase examines its batch without
      // merging, so only the sceneCluster phase writes anything here.
      { mergeThreshold: 2, logger },
      logger,
    );
  }

  function sceneRow(): { cursor: string | null; status: string; affected: number } | undefined {
    return db
      .prepare(
        `SELECT cursor, status, affected_rows AS affected FROM maintenance_runs
          WHERE job_name = 'dreamcycle_sceneCluster'
          ORDER BY CAST(started_at AS INTEGER) DESC, rowid DESC LIMIT 1`,
      )
      .get() as { cursor: string | null; status: string; affected: number } | undefined;
  }

  function sceneFiles(): string[] {
    const dir = path.join(baseDir, 'scenes');
    return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
  }

  it('clusters one bounded slice per run and records the resume point', async () => {
    seedWindow('key-a', '2026-01-01 10:00:00');
    seedWindow('key-b', '2026-02-01 10:00:00');

    await buildDreamCycle(1).runAll({ force: true });
    const first = sceneRow();
    expect(first?.status).toBe('success');
    expect(first?.affected).toBe(1);
    // The slice stopped after key-a, so the cursor names it.
    expect(first?.cursor).toBe('key-a');
    expect(sceneFiles()).toEqual(['key-a_2026-01-01_2026-01-01.md']);

    await buildDreamCycle(1).runAll({ force: true });
    const second = sceneRow();
    expect(second?.affected).toBe(1);
    // key-b was the last scopeKey in the queue → the sweep is complete, and the
    // cursor goes back to the head for the next night.
    expect(second?.cursor).toBe('');
    expect(sceneFiles()).toEqual([
      'key-a_2026-01-01_2026-01-01.md',
      'key-b_2026-02-01_2026-02-01.md',
    ]);
  });

  it('re-clusters from the head once a sweep has wrapped', async () => {
    seedWindow('key-a', '2026-01-01 10:00:00');

    await buildDreamCycle(8).runAll({ force: true });
    expect(sceneRow()?.cursor).toBe('');

    // The wrapped run processes the head again instead of continuing past it.
    await buildDreamCycle(8).runAll({ force: true });
    expect(sceneRow()?.affected).toBe(1);
    expect(sceneRow()?.cursor).toBe('');
  });
});
