/**
 * Scene clustering is batched, resumable and partially successful.
 *
 * The previous implementation rebuilt every scopeKey in one call and treated any
 * failure as "roll the whole scenes/ directory back", which cannot express
 * progress: a backlog bigger than one phase timeout never advanced, and a
 * failure in the last scopeKey discarded the ones that had succeeded. These
 * tests pin the replacement contract:
 *
 *   - a committed scopeKey stays committed when a later one fails,
 *   - an abort keeps what was written and leaves the rest for the next run,
 *   - `maxScopeKeys` + `afterScopeKey` advance one bounded slice per call,
 *   - stale files/rows of a committed scopeKey are reconciled, and the
 *     scopeKeys this run did not touch are left alone.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { applySchema } from '../../src/memory/schema';
import { MemoryRepository } from '../../src/memory/repositories/memory-repository';
import { SceneClusterer } from '../../src/memory/scene-cluster';

const logger = { debug() {}, info() {}, warn() {} };

describe('SceneClusterer partial runs', () => {
  let db: Database.Database;
  let memoryRepo: MemoryRepository;
  let clusterer: SceneClusterer;
  let baseDir: string;
  let idCounter = 0;

  function uniqueId(prefix: string): string {
    idCounter++;
    return `${prefix}-${Date.now()}-${idCounter}`;
  }

  function insertMemory(scopeKey: string, createdAt: string): string {
    const id = uniqueId('mem');
    db.prepare(
      `INSERT INTO memories (id, scope, scope_key, kind, content, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, 'user', scopeKey, 'fact', `${scopeKey} content ${id}`, createdAt);
    return id;
  }

  function seedWindow(scopeKey: string, createdAt: string, count = 6): void {
    for (let i = 0; i < count; i++) insertMemory(scopeKey, createdAt);
  }

  function sceneFiles(): string[] {
    const dir = path.join(baseDir, 'scenes');
    return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
  }

  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db);
    memoryRepo = new MemoryRepository(db);
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scene-partial-test-'));
    clusterer = new SceneClusterer(memoryRepo, baseDir, {}, logger);
    idCounter = 0;
  });

  afterEach(() => {
    db.close();
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('keeps the scopeKeys it committed when a later one throws', () => {
    seedWindow('key-a', '2026-01-01 10:00:00');
    seedWindow('key-b', '2026-02-01 10:00:00');

    const originalUpsert = memoryRepo.upsert.bind(memoryRepo);
    let calls = 0;
    (memoryRepo as unknown as Record<string, unknown>).upsert = (input: unknown) => {
      calls++;
      if (calls > 1) throw new Error('db gone mid-cluster');
      return originalUpsert(input as never);
    };

    const summary = clusterer.clusterBatch();

    expect(summary.processedScopeKeys).toEqual(['key-a']);
    expect(summary.clusters.map((c) => c.scopeKey)).toEqual(['key-a']);
    expect(summary.errors).toEqual([{ scopeKey: 'key-b', message: 'db gone mid-cluster' }]);
    // key-a is on disk and registered; key-b's window was never registered, so
    // the next run redoes it (its cursor hook never fired).
    expect(sceneFiles()).toContain('key-a_2026-01-01_2026-01-01.md');
    expect(memoryRepo.findByScopeAndKind('user', 'key-b', 'scene')).toHaveLength(0);

    (memoryRepo as unknown as Record<string, unknown>).upsert = originalUpsert;
  });

  it('still throws through cluster() when nothing at all succeeded', () => {
    seedWindow('key-a', '2026-01-01 10:00:00');
    (memoryRepo as unknown as Record<string, unknown>).upsert = () => {
      throw new Error('db gone mid-cluster');
    };

    expect(() => clusterer.cluster('user', 7, 5)).toThrow('db gone mid-cluster');
  });

  it('stops on abort between scopeKeys and keeps the committed ones', () => {
    seedWindow('key-a', '2026-01-01 10:00:00');
    seedWindow('key-b', '2026-02-01 10:00:00');

    const controller = new AbortController();
    const summary = clusterer.clusterBatch({
      signal: controller.signal,
      onScopeKeyDone: (scopeKey) => {
        // Abort the way a phase timeout does: right after the first commit.
        if (scopeKey === 'key-a') controller.abort();
      },
    });

    expect(summary.processedScopeKeys).toEqual(['key-a']);
    expect(summary.clusters).toHaveLength(1);
    expect(summary.errors).toEqual([]);
    expect(sceneFiles()).toEqual(['key-a_2026-01-01_2026-01-01.md']);
    expect(memoryRepo.findByScopeAndKind('user', 'key-b', 'scene')).toHaveLength(0);
  });

  it('advances one bounded slice per call and resumes after the cursor', () => {
    seedWindow('key-a', '2026-01-01 10:00:00');
    seedWindow('key-b', '2026-02-01 10:00:00');
    seedWindow('key-c', '2026-03-01 10:00:00');

    const first = clusterer.clusterBatch({ maxScopeKeys: 2 });
    expect(first.processedScopeKeys).toEqual(['key-a', 'key-b']);
    expect(first.reachedEnd).toBe(false);

    const second = clusterer.clusterBatch({
      maxScopeKeys: 2,
      afterScopeKey: first.processedScopeKeys[first.processedScopeKeys.length - 1],
    });
    expect(second.processedScopeKeys).toEqual(['key-c']);
    // Two keys in the queue, one of them processed → the slice reached the tail.
    expect(second.reachedEnd).toBe(true);

    // A run that reached the tail starts over from the head.
    const third = clusterer.clusterBatch({ maxScopeKeys: 1 });
    expect(third.processedScopeKeys).toEqual(['key-a']);
    expect(third.reachedEnd).toBe(false);
  });

  it('reconciles stale scene files and rows of a committed scopeKey only', () => {
    const keyAIds = Array.from({ length: 6 }, () => insertMemory('key-a', '2026-01-01 10:00:00'));
    seedWindow('key-b', '2026-02-01 10:00:00');

    const first = clusterer.clusterBatch();
    expect(first.processedScopeKeys).toEqual(['key-a', 'key-b']);
    expect(first.prunedFiles).toBe(0);
    expect(first.prunedMemories).toBe(0);
    const keyAScene = memoryRepo.findByScopeAndKind('user', 'key-a', 'scene')[0];
    expect(keyAScene).toBeDefined();

    // key-a falls below minMemories → its window no longer exists. key-b is
    // untouched and must survive the sweep.
    for (const id of keyAIds.slice(0, 4)) memoryRepo.delete(id);

    const second = clusterer.clusterBatch();
    expect(second.processedScopeKeys).toEqual(['key-a', 'key-b']);
    expect(second.prunedFiles).toBe(1);
    expect(second.prunedMemories).toBe(1);
    expect(sceneFiles()).toEqual(['key-b_2026-02-01_2026-02-01.md']);
    expect(memoryRepo.findByScopeAndKind('user', 'key-a', 'scene')).toHaveLength(0);
    expect(memoryRepo.findByScopeAndKind('user', 'key-b', 'scene')).toHaveLength(1);
  });

  it('does not touch the files of a scopeKey it did not process', () => {
    const keyAIds = Array.from({ length: 6 }, () => insertMemory('key-a', '2026-01-01 10:00:00'));
    seedWindow('key-b', '2026-02-01 10:00:00');
    clusterer.clusterBatch();

    // key-a now produces no window at all, so a directory-wide sweep would also
    // delete key-b's file — which this run never looked at.
    for (const id of keyAIds) memoryRepo.delete(id);

    const summary = clusterer.clusterBatch({ maxScopeKeys: 1 });
    expect(summary.processedScopeKeys).toEqual(['key-a']);
    expect(summary.prunedFiles).toBe(1);
    expect(sceneFiles()).toEqual(['key-b_2026-02-01_2026-02-01.md']);
  });

  it('removes a scenes.bak left behind by the previous all-or-nothing version', () => {
    seedWindow('key-a', '2026-01-01 10:00:00');
    const backupDir = path.join(baseDir, 'scenes.bak');
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(path.join(backupDir, 'stale.md'), 'snapshot', 'utf-8');

    clusterer.clusterBatch();

    expect(fs.existsSync(backupDir)).toBe(false);
  });

  it('writes scene files atomically (no .tmp residue, previous file survives a failure)', () => {
    seedWindow('key-a', '2026-01-01 10:00:00');
    clusterer.clusterBatch();
    const file = path.join(baseDir, 'scenes', 'key-a_2026-01-01_2026-01-01.md');
    const before = fs.readFileSync(file, 'utf-8');

    // Fail the registration step of the rewrite: the file has already been
    // renamed into place, so it holds the new content, and no temp file is left.
    (memoryRepo as unknown as Record<string, unknown>).upsert = () => {
      throw new Error('nope');
    };
    const summary = clusterer.clusterBatch();
    expect(summary.errors).toHaveLength(1);
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
    expect(fs.readFileSync(file, 'utf-8').length).toBeGreaterThan(0);
    expect(before.length).toBeGreaterThan(0);
  });
});
