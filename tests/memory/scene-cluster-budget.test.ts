/**
 * Per-scene-document byte ceiling (`memory.sceneClustering.maxFileBytes`).
 *
 * TDAM v2.0.4 puts a 256KB cap on a scene file and allows an already-oversized
 * file to only shrink. A scene document here is the flattened text of every
 * memory in its window, so without a cap the file grows with the conversation
 * (and with `windowDays`); without the shrink rule an old oversized file is
 * rewritten oversized every night and lowering the limit never takes effect.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { applySchema } from '../../src/memory/schema';
import { MemoryRepository } from '../../src/memory/repositories/memory-repository';
import { SceneClusterer, DEFAULT_MAX_FILE_BYTES } from '../../src/memory/scene-cluster';

describe('SceneClusterer file budget', () => {
  let db: Database.Database;
  let memoryRepo: MemoryRepository;
  let baseDir: string;
  let counter = 0;

  function insertMemory(scopeKey: string, content: string): void {
    counter++;
    db.prepare(
      `INSERT INTO memories (id, scope, scope_key, kind, content, created_at)
       VALUES (?, 'user', ?, 'fact', ?, ?)`,
    ).run(`mem-${counter}`, scopeKey, content, '2026-01-01 10:00:00');
  }

  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db);
    memoryRepo = new MemoryRepository(db);
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scene-budget-test-'));
    counter = 0;
  });

  afterEach(() => {
    db.close();
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('keeps a generated document inside the budget and says how much it clipped', () => {
    const clusterer = new SceneClusterer(memoryRepo, baseDir, { maxFileBytes: 2048 });
    // ~120 bytes each × 40 = ~4.8KB, comfortably over the 2KB budget.
    for (let i = 0; i < 40; i++) insertMemory('big', `记忆条目 ${i} `.repeat(10));

    const [scene] = clusterer.cluster('user', 7, 5);
    expect(scene).toBeDefined();
    expect(Buffer.byteLength(scene.content, 'utf-8')).toBeLessThanOrEqual(2048);
    expect(scene.content).toMatch(/已截断 \d+ 条/);
    // The file on disk is what the budget is really about.
    const filePath = path.join(baseDir, scene.refPath);
    expect(fs.statSync(filePath).size).toBeLessThanOrEqual(2048);
  });

  it('leaves a small document untouched (no truncation marker)', () => {
    const clusterer = new SceneClusterer(memoryRepo, baseDir, { maxFileBytes: 256 * 1024 });
    for (let i = 0; i < 6; i++) insertMemory('small', `短记忆 ${i}`);

    const [scene] = clusterer.cluster('user', 7, 5);
    expect(scene.content).not.toMatch(/已截断/);
    expect(scene.content).toContain('短记忆 5');
  });

  it('rewrites an oversized file from an older release downward, never upward', () => {
    // A file written before the ceiling existed: allowed to stay/shrink, and the
    // next run brings it under the limit rather than preserving the bloat.
    const refPath = 'scenes/user_2026-01-01_2026-01-01.md';
    fs.mkdirSync(path.join(baseDir, 'scenes'), { recursive: true });
    fs.writeFileSync(path.join(baseDir, refPath), 'x'.repeat(4096), 'utf-8');

    const clusterer = new SceneClusterer(memoryRepo, baseDir, { maxFileBytes: 512 });
    for (let i = 0; i < 6; i++) insertMemory('user', `条目 ${i}`);
    clusterer.cluster('user', 7, 5);

    const after = fs.statSync(path.join(baseDir, refPath)).size;
    expect(after).toBeLessThan(4096);
    expect(after).toBeLessThanOrEqual(512);
  });

  it('exports the 256KB default', () => {
    expect(DEFAULT_MAX_FILE_BYTES).toBe(262_144);
  });
});
