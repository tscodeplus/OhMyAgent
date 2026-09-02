import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { parseEpochMs } from '../../src/shared/timestamp';
import { applySchema } from '../../src/memory/schema';
import { MemoryRepository } from '../../src/memory/repositories/memory-repository';
import { SceneClusterer } from '../../src/memory/scene-cluster';
import { textFallbackRetrieve } from '../../src/memory/fallback-retriever';
import { applyTemporalDecay } from '../../src/memory/temporal-decay';
import type { MergedResult } from '../../src/memory/rrf-merge';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('parseEpochMs', () => {
  it('parses the bare epoch-millis digit string written by the schema DEFAULT', () => {
    // 2026-01-01T00:00:00Z
    expect(parseEpochMs('1767225600000')).toBe(1767225600000);
  });

  it('is needed because new Date() rejects that same shape', () => {
    expect(new Date('1767225600000').getTime()).toBeNaN();
  });

  it('parses ISO-8601 to the same instant as the digit string', () => {
    expect(parseEpochMs('2026-01-01T00:00:00.000Z')).toBe(parseEpochMs('1767225600000'));
  });

  it('parses SQLite datetime("now") style strings', () => {
    const ms = parseEpochMs('2026-01-02 03:04:05');
    expect(ms).toBeGreaterThan(0);
    expect(new Date(ms).getFullYear()).toBe(2026);
  });

  it('accepts numbers', () => {
    expect(parseEpochMs(1767225600000)).toBe(1767225600000);
    expect(parseEpochMs(0)).toBe(0);
  });

  it('returns 0 for values it cannot interpret', () => {
    expect(parseEpochMs('not-a-date')).toBe(0);
    expect(parseEpochMs('')).toBe(0);
    expect(parseEpochMs(null)).toBe(0);
    expect(parseEpochMs(undefined)).toBe(0);
    expect(parseEpochMs(Number.NaN)).toBe(0);
  });
});

describe('SceneClusterer with epoch-millis created_at', () => {
  let db: Database.Database;
  let memoryRepo: MemoryRepository;
  let clusterer: SceneClusterer;
  let baseDir: string;
  let idCounter = 0;

  /** created_at holds the bare digit string the column DEFAULT produces. */
  function insertMemory(createdAt: string, content: string, scopeKey = 'mixed'): void {
    idCounter++;
    db.prepare(`
      INSERT INTO memories (id, scope, scope_key, kind, content, created_at)
      VALUES (?, 'user', ?, 'fact', ?, ?)
    `).run(`mem-${idCounter}`, scopeKey, content, createdAt);
  }

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applySchema(db);
    memoryRepo = new MemoryRepository(db);
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'timestamp-parsing-test-'));
    clusterer = new SceneClusterer(memoryRepo, baseDir);
    idCounter = 0;
  });

  afterEach(() => {
    db.close();
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('splits memories into separate time windows instead of collapsing them', () => {
    const t0 = Date.UTC(2026, 0, 1, 10, 0, 0);
    for (let i = 0; i < 5; i++) {
      insertMemory(String(t0), `day0 #${i}`);
    }
    for (let i = 0; i < 5; i++) {
      insertMemory(String(t0 + 10 * DAY_MS), `day10 #${i}`);
    }

    const results = clusterer.cluster('user', 7, 5);

    // Before the fix both sides were Invalid Date → NaN window index → one
    // bogus window holding all 10 memories.
    expect(results).toHaveLength(2);
    expect(results[0].memoryCount).toBe(5);
    expect(results[1].memoryCount).toBe(5);
    expect(results[0].content).toContain('day0 #0');
    expect(results[0].content).not.toContain('day10 #0');
    expect(results[1].content).toContain('day10 #0');
  });

  it('derives YYYY-MM-DD labels from digit-string timestamps', () => {
    const t0 = Date.UTC(2026, 0, 1, 10, 0, 0);
    for (let i = 0; i < 5; i++) {
      insertMemory(String(t0 + i * DAY_MS), `same-${i}`, 'labels');
    }

    const results = clusterer.cluster('user', 7, 5);

    expect(results).toHaveLength(1);
    expect(results[0].startDate).toBe('2026-01-01');
    expect(results[0].endDate).toBe('2026-01-05');
    expect(results[0].startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(results[0].refPath).toBe('scenes/labels_2026-01-01_2026-01-05.md');
    expect(results[0].content).toContain('时间: 2026-01-01 ~ 2026-01-05');
  });

  it('orders markdown records chronologically when row order is not numeric', () => {
    // '1767...' sorts before '2026-...' as text, so findAllByScope returns
    // D1, D2, I1, I2, I3 — but D2 (Jan 08) is the newest of the five.
    insertMemory('1767398400000', 'm-0103'); // 2026-01-03T00:00:00Z
    insertMemory('1767830400000', 'm-0108'); // 2026-01-08T00:00:00Z
    insertMemory('2026-01-04T00:00:00.000Z', 'm-0104');
    insertMemory('2026-01-05T00:00:00.000Z', 'm-0105');
    insertMemory('2026-01-06T00:00:00.000Z', 'm-0106');

    const results = clusterer.cluster('user', 7, 5);

    expect(results).toHaveLength(1);
    const content = results[0].content;
    const order = ['m-0103', 'm-0104', 'm-0105', 'm-0106', 'm-0108']
      .map(tag => content.indexOf(tag));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every(i => i >= 0)).toBe(true);
  });
});

describe('retrieval createdAt with repository-written timestamps', () => {
  let db: Database.Database;
  let memoryRepo: MemoryRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applySchema(db);
    memoryRepo = new MemoryRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('fallback retriever yields a finite createdAt', async () => {
    // repo.create() omits created_at, so SQLite's DEFAULT stores "1767...".
    memoryRepo.create({
      id: 'mem-alpha',
      scope: 'user',
      scope_key: 'session-1',
      kind: 'fact',
      content: 'alpha beta gamma',
    });

    const results = await textFallbackRetrieve(memoryRepo, 'alpha', 5, 'user', 'session-1');

    expect(results).toHaveLength(1);
    expect(Number.isFinite(results[0].createdAt)).toBe(true);
    expect(results[0].createdAt).toBeGreaterThan(0);
    expect(Math.abs(Date.now() - results[0].createdAt)).toBeLessThan(5000);
  });

  it('temporal decay actually applies to digit-string rows', () => {
    const now = Date.UTC(2026, 0, 31, 0, 0, 0);
    const thirtyDaysAgo = String(now - 30 * DAY_MS);
    const results: MergedResult[] = [{
      id: 'mem-old',
      content: 'old fact',
      score: 1,
      source: 'cosine',
      scope: 'user',
      scopeKey: 'k',
      kind: 'fact',
      createdAt: parseEpochMs(thirtyDaysAgo),
    }];

    const [decayed] = applyTemporalDecay(results, { halfLifeDays: 30, nowMs: now });

    // One half-life elapsed → score halves (previously skipped entirely,
    // because !NaN is true).
    expect(decayed.score).toBeCloseTo(0.5, 5);
  });
});
