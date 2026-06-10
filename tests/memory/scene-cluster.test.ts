import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { applySchema } from '../../src/memory/schema';
import { MemoryRepository } from '../../src/memory/repositories/memory-repository';
import { SceneClusterer } from '../../src/memory/scene-cluster';

describe('SceneClusterer', () => {
  let db: Database.Database;
  let memoryRepo: MemoryRepository;
  let clusterer: SceneClusterer;
  let baseDir: string;
  let idCounter = 0;

  function uniqueId(prefix: string): string {
    idCounter++;
    return `${prefix}-${Date.now()}-${idCounter}`;
  }

  /**
   * Insert a memory directly with a controllable created_at timestamp.
   * The repo.create() method does not expose created_at, so raw SQL is used
   * for precise date control in tests.
   */
  function insertMemory(overrides: {
    scope?: string;
    scope_key?: string;
    kind?: string;
    content?: string;
    created_at?: string;
  } = {}): void {
    const id = uniqueId('mem');
    db.prepare(`
      INSERT INTO memories (id, scope, scope_key, kind, content, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      id,
      overrides.scope ?? 'user',
      overrides.scope_key ?? 'test-key',
      overrides.kind ?? 'fact',
      overrides.content ?? 'test content',
      overrides.created_at ?? new Date().toISOString(),
    );
  }

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applySchema(db);
    memoryRepo = new MemoryRepository(db);
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scene-cluster-test-'));
    clusterer = new SceneClusterer(memoryRepo, baseDir);
    idCounter = 0;
  });

  afterEach(() => {
    db.close();
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  describe('cluster()', () => {
    it('should return empty list when no memories exist', () => {
      const results = clusterer.cluster();
      expect(results).toEqual([]);
    });

    it('should not generate scenes for fewer memories than minMemories', () => {
      for (let i = 0; i < 3; i++) {
        insertMemory({ created_at: `2026-01-0${i + 1} 10:00:00` });
      }

      const results = clusterer.cluster('user', 7, 5);
      expect(results).toEqual([]);
    });

    it('should generate at least one scene for 20 memories with same scopeKey', () => {
      for (let i = 0; i < 20; i++) {
        insertMemory({ created_at: '2026-01-01 10:00:00' });
      }

      const results = clusterer.cluster();
      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it('should cluster different scopeKeys separately', () => {
      for (let i = 0; i < 6; i++) {
        insertMemory({ scope_key: 'key-a', created_at: '2026-01-01 10:00:00' });
      }
      for (let i = 0; i < 6; i++) {
        insertMemory({ scope_key: 'key-b', created_at: '2026-01-02 10:00:00' });
      }

      const results = clusterer.cluster('user', 7, 5);
      expect(results).toHaveLength(2);
      const scopeKeys = results.map(r => r.scopeKey).sort();
      expect(scopeKeys).toEqual(['key-a', 'key-b']);
    });

    it('should generate correct markdown format with kind grouping', () => {
      insertMemory({
        scope_key: 'test-user',
        kind: 'preference',
        content: 'likes dark mode',
        created_at: '2026-01-01 10:00:00',
      });
      insertMemory({
        scope_key: 'test-user',
        kind: 'fact',
        content: 'name is Alice',
        created_at: '2026-01-01 11:00:00',
      });
      insertMemory({
        scope_key: 'test-user',
        kind: 'task',
        content: 'buy groceries',
        created_at: '2026-01-02 10:00:00',
      });
      insertMemory({
        scope_key: 'test-user',
        kind: 'device_state',
        content: 'battery at 80%',
        created_at: '2026-01-02 11:00:00',
      });
      insertMemory({
        scope_key: 'test-user',
        kind: 'summary',
        content: 'user had a productive day',
        created_at: '2026-01-03 10:00:00',
      });

      const results = clusterer.cluster('user', 7, 5);
      expect(results).toHaveLength(1);

      const content = results[0].content;
      expect(content).toContain('# 场景: test-user');
      expect(content).toContain('时间: 2026-01-01 ~ 2026-01-03');
      expect(content).toContain('记忆数: 5');
      expect(content).toContain('## 偏好');
      expect(content).toContain('- likes dark mode');
      expect(content).toContain('## 事实');
      expect(content).toContain('- name is Alice');
      expect(content).toContain('## 任务');
      expect(content).toContain('- buy groceries');
      expect(content).toContain('## 设备状态');
      expect(content).toContain('- battery at 80%');
      expect(content).toContain('## 摘要');
      expect(content).toContain('- user had a productive day');
    });

    it('should write scene markdown files to disk', () => {
      for (let i = 0; i < 5; i++) {
        insertMemory({ created_at: '2026-01-01 10:00:00' });
      }

      const results = clusterer.cluster();
      expect(results).toHaveLength(1);

      const filePath = path.join(baseDir, results[0].refPath);
      expect(fs.existsSync(filePath)).toBe(true);
      const fileContent = fs.readFileSync(filePath, 'utf-8');
      expect(fileContent).toBe(results[0].content);
    });

    it('should return SceneCluster list consistent with actual files', () => {
      for (let i = 0; i < 5; i++) {
        insertMemory({ scope_key: 'user-a', created_at: '2026-01-01 10:00:00' });
      }
      for (let i = 0; i < 5; i++) {
        insertMemory({ scope_key: 'user-b', created_at: '2026-01-05 10:00:00' });
      }

      const results = clusterer.cluster('user', 7, 5);
      expect(results).toHaveLength(2);

      for (const cluster of results) {
        const filePath = path.join(baseDir, cluster.refPath);
        expect(fs.existsSync(filePath)).toBe(true);
        const actualContent = fs.readFileSync(filePath, 'utf-8');
        expect(actualContent).toBe(cluster.content);
        expect(cluster.memoryCount).toBe(5);
      }
    });

    it('should split memories with windowDays=3 across 6 days into 2 scenes', () => {
      // Window 1: 5 memories on day 0
      for (let i = 0; i < 5; i++) {
        insertMemory({ created_at: '2026-01-01 10:00:00' });
      }
      // Window 2: 5 memories on day 3 (within the next 3-day window)
      for (let i = 0; i < 5; i++) {
        insertMemory({ created_at: '2026-01-04 10:00:00' });
      }

      const results = clusterer.cluster('user', 3, 5);
      expect(results).toHaveLength(2);
      expect(results[0].memoryCount).toBe(5);
      expect(results[1].memoryCount).toBe(5);
      expect(results[0].startDate).toBe('2026-01-01');
      expect(results[1].startDate).toBe('2026-01-04');
    });

    it('should persist scene as kind=scene memory', () => {
      for (let i = 0; i < 5; i++) {
        insertMemory({ created_at: '2026-01-01 10:00:00' });
      }

      const results = clusterer.cluster();
      expect(results).toHaveLength(1);

      const sceneId = `scene-${results[0].scopeKey}-${results[0].startDate}-${results[0].endDate}`;
      const sceneMemory = memoryRepo.findById(sceneId);
      expect(sceneMemory).toBeDefined();
      expect(sceneMemory!.kind).toBe('scene');
      expect(sceneMemory!.content).toBe(results[0].refPath);
    });

    it('uses constructor defaults for windowDays and minMemories', () => {
      clusterer = new SceneClusterer(memoryRepo, baseDir, { windowDays: 3, minMemories: 2 });
      insertMemory({ scope_key: 'defaults', created_at: '2026-01-01 10:00:00' });
      insertMemory({ scope_key: 'defaults', created_at: '2026-01-01 11:00:00' });
      insertMemory({ scope_key: 'defaults', created_at: '2026-01-04 10:00:00' });
      insertMemory({ scope_key: 'defaults', created_at: '2026-01-04 11:00:00' });

      const results = clusterer.cluster();

      expect(results).toHaveLength(2);
      expect(results.map(r => r.memoryCount)).toEqual([2, 2]);
    });

    it('sanitizes scopeKey before writing scene paths', () => {
      for (let i = 0; i < 5; i++) {
        insertMemory({ scope_key: '../evil/user', created_at: '2026-01-01 10:00:00' });
      }

      const results = clusterer.cluster();

      expect(results[0].scopeKey).toBe('../evil/user');
      expect(results[0].refPath).toBe('scenes/evil_user_2026-01-01_2026-01-01.md');
      expect(fs.existsSync(path.join(baseDir, results[0].refPath))).toBe(true);
      expect(fs.existsSync(path.join(baseDir, '..', 'evil'))).toBe(false);
    });

    it('logs persisted scene clusters for observability', () => {
      const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
      clusterer = new SceneClusterer(memoryRepo, baseDir, {}, logger as any);
      for (let i = 0; i < 5; i++) {
        insertMemory({ scope_key: 'observed', created_at: '2026-01-01 10:00:00' });
      }

      clusterer.cluster();

      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          sceneId: 'scene-observed-2026-01-01-2026-01-01',
          scope: 'user',
          scopeKey: 'observed',
          memoryCount: 5,
        }),
        'Scene cluster persisted',
      );
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: 'user',
          clusterCount: 1,
          windowDays: 7,
          minMemories: 5,
        }),
        'Scene clustering completed',
      );
    });
  });
});
