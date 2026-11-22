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

  function insertMemory(scopeKey: string, createdAt: string, scope = 'user'): string {
    const id = uniqueId('mem');
    db.prepare(
      `INSERT INTO memories (id, scope, scope_key, kind, content, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, scope, scopeKey, 'fact', `${scopeKey} content ${id}`, createdAt);
    return id;
  }

  function seedWindow(scopeKey: string, createdAt: string, count = 6, scope = 'user'): void {
    for (let i = 0; i < count; i++) insertMemory(scopeKey, createdAt, scope);
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
    // key-a is on disk and registered. key-b wrote its file before the upsert
    // threw, so the run leaves that file unreferenced — and the orphan sweep
    // removes it rather than parking a document no row points at. key-b is redone
    // by the next run (its cursor hook never fired).
    expect(sceneFiles()).toEqual(['key-a_2026-01-01_2026-01-01.md']);
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

  it('keeps the documents of another scope that shares the scenes directory', () => {
    // `scenes/` is one directory for every scope, so the orphan sweep must judge
    // a file by every scope's rows — filtering them by the scope being clustered
    // would delete the other scope's documents as "unreferenced".
    seedWindow('session-key', '2026-01-01 10:00:00', 6, 'session');
    clusterer.clusterBatch({ scope: 'session' });

    seedWindow('user-key', '2026-02-01 10:00:00');
    clusterer.clusterBatch({ scope: 'user' });
    // A second user-scope run (the nightly case) must still leave session alone.
    clusterer.clusterBatch({ scope: 'user' });

    expect(sceneFiles()).toEqual([
      'session-key_2026-01-01_2026-01-01.md',
      'user-key_2026-02-01_2026-02-01.md',
    ]);
    expect(memoryRepo.findByScopeAndKind('session', 'session-key', 'scene')).toHaveLength(1);
  });

  it('removes a scenes.bak left behind by the previous all-or-nothing version', () => {
    seedWindow('key-a', '2026-01-01 10:00:00');
    const backupDir = path.join(baseDir, 'scenes.bak');
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(path.join(backupDir, 'stale.md'), 'snapshot', 'utf-8');

    clusterer.clusterBatch();

    expect(fs.existsSync(backupDir)).toBe(false);
  });

  it('leaves the committed documents intact and no .tmp behind when a write fails', () => {
    seedWindow('key-a', '2026-01-01 10:00:00');
    clusterer.clusterBatch();
    const file = path.join(baseDir, 'scenes', 'key-a_2026-01-01_2026-01-01.md');
    const before = fs.readFileSync(file, 'utf-8');

    // A directory squatting on key-b's target path makes the tmp+rename fail
    // mid-write for that scopeKey only.
    seedWindow('key-b', '2026-02-01 10:00:00');
    const blocked = path.join(baseDir, 'scenes', 'key-b_2026-02-01_2026-02-01.md');
    fs.mkdirSync(blocked);

    const summary = clusterer.clusterBatch();

    expect(summary.errors.map((e) => e.scopeKey)).toEqual(['key-b']);
    // The failed write is atomic from the reader's point of view: key-a's
    // document is byte-identical and no half-written temp file survives.
    expect(fs.readFileSync(file, 'utf-8')).toBe(before);
    expect(fs.readdirSync(path.join(baseDir, 'scenes')).filter((f) => f.endsWith('.tmp'))).toEqual(
      [],
    );
    expect(fs.existsSync(blocked)).toBe(true);
  });
});
