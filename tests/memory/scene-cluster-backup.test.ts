import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { applySchema } from '../../src/memory/schema';
import { MemoryRepository } from '../../src/memory/repositories/memory-repository';
import { SceneClusterer } from '../../src/memory/scene-cluster';

/**
 * Fail-soft scene artifact backup (TDAM v0.3.6 `scene_blocks` pattern):
 * a mid-run failure must restore the previous scenes/ snapshot instead of
 * leaving a half-written directory.
 */
describe('SceneClusterer fail-soft backup', () => {
  let db: Database.Database;
  let memoryRepo: MemoryRepository;
  let clusterer: SceneClusterer;
  let baseDir: string;
  let idCounter = 0;

  function uniqueId(prefix: string): string {
    idCounter++;
    return `${prefix}-${Date.now()}-${idCounter}`;
  }

  function insertMemory(scopeKey: string, createdAt: string): void {
    db.prepare(
      `INSERT INTO memories (id, scope, scope_key, kind, content, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(uniqueId('mem'), 'user', scopeKey, 'fact', `${scopeKey} content`, createdAt);
  }

  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db);
    memoryRepo = new MemoryRepository(db);
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scene-backup-test-'));
    clusterer = new SceneClusterer(
      memoryRepo,
      baseDir,
      {},
      {
        debug() {},
        info() {},
        warn() {},
      },
    );
    idCounter = 0;
  });

  afterEach(() => {
    db.close();
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('writes scene files and leaves no backup dir on success', () => {
    for (let i = 0; i < 6; i++) {
      insertMemory('key-a', '2026-01-01 10:00:00');
    }
    const results = clusterer.cluster('user', 7, 5);
    expect(results).toHaveLength(1);
    const scenesDir = path.join(baseDir, 'scenes');
    expect(fs.existsSync(scenesDir)).toBe(true);
    expect(fs.readdirSync(scenesDir).length).toBeGreaterThan(0);
    // No backup left behind after a successful run
    expect(fs.existsSync(path.join(baseDir, 'scenes.bak'))).toBe(false);
  });

  it('restores the previous scenes snapshot when persistence throws mid-run', () => {
    // First successful run establishes the on-disk baseline.
    for (let i = 0; i < 6; i++) {
      insertMemory('key-a', '2026-01-01 10:00:00');
    }
    const firstRun = clusterer.cluster('user', 7, 5);
    expect(firstRun).toHaveLength(1);
    const scenesDir = path.join(baseDir, 'scenes');
    const baselineFiles = fs.readdirSync(scenesDir).sort();
    const baselinePath = path.join(scenesDir, baselineFiles[0]);
    const baselineContent = fs.readFileSync(baselinePath, 'utf-8');

    // Mutate a memory so a re-cluster would regenerate key-a's markdown with
    // different content (proving rollback actually reverts the file).
    const targetId = (
      db.prepare("SELECT id FROM memories WHERE scope_key = 'key-a' LIMIT 1").get() as {
        id: string;
      }
    ).id;
    db.prepare('UPDATE memories SET content = ? WHERE id = ?').run('updated content', targetId);

    // A second cluster (different date window) so the second run has two
    // persistScene calls and the injected failure lands mid-run.
    for (let i = 0; i < 6; i++) {
      insertMemory('key-b', '2026-02-01 10:00:00');
    }

    // Second run: persistence blows up after scene files were rewritten.
    const originalUpsert = memoryRepo.upsert.bind(memoryRepo);
    let calls = 0;
    (memoryRepo as any).upsert = (input: unknown) => {
      calls++;
      if (calls > 1) throw new Error('db gone mid-cluster');
      return originalUpsert(input as never);
    };

    expect(() => clusterer.cluster('user', 7, 5)).toThrow('db gone mid-cluster');

    // key-a's rewritten markdown is rolled back to the first-run snapshot;
    // key-b (no pre-existing snapshot) is gone entirely.
    const restoredFiles = fs.readdirSync(scenesDir).sort();
    expect(restoredFiles).toEqual(baselineFiles);
    expect(fs.readFileSync(path.join(scenesDir, restoredFiles[0]), 'utf-8')).toBe(baselineContent);
    expect(fs.existsSync(path.join(baseDir, 'scenes.bak'))).toBe(false);

    (memoryRepo as any).upsert = originalUpsert;
  });
});
