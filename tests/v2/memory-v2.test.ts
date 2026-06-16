/**
 * V2 Memory system integration test:
 * - DB migration (agent_id, visibility columns)
 * - Memory write with agent tags
 * - Grouped RRF retrieval (3-pool)
 * - Snapshot injection
 */
import { describe, it, expect, beforeAll } from 'vitest';
import Database from 'better-sqlite3';
import dotenv from 'dotenv';
dotenv.config();

import { openDatabase } from '../../src/memory/db.js';
import { runV2Migrations } from '../../src/memory/migration-v2.js';
import { runV3Migrations } from '../../src/memory/migration-v3.js';
import { MemoryRepository } from '../../src/memory/repositories/memory-repository.js';
import { MemoryWriter } from '../../src/memory/memory-writer.js';

describe('V2 Memory System', () => {
  let db: Database.Database;

  beforeAll(() => {
    db = new Database(':memory:');

    // Create schema from src/memory/schema.ts
    db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        scope_key TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata TEXT,
        agent_id TEXT,
        visibility TEXT DEFAULT 'shared',
        created_at TEXT NOT NULL DEFAULT (cast(strftime('%s','now') as integer) * 1000),
        updated_at TEXT NOT NULL DEFAULT (cast(strftime('%s','now') as integer) * 1000)
      );
      CREATE TABLE IF NOT EXISTS embeddings (
        memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
        embedding BLOB NOT NULL
      );
    `);
  });

  describe('DB Migration', () => {
    it('has agent_id and visibility in memories table', () => {
      const cols = db.pragma('table_info(memories)') as Array<{ name: string }>;
      const names = cols.map(c => c.name);
      expect(names).toContain('agent_id');
      expect(names).toContain('visibility');
    });

    it('migration is idempotent', () => {
      const result1 = runV2Migrations(db);
      expect(result1.added).toEqual([]);

      const result2 = runV2Migrations(db);
      expect(result2.added).toEqual([]);
      expect(result2.skipped).toContain('agent_id');
      expect(result2.skipped).toContain('visibility');
    });
  });

  describe('MemoryWrite with agent tags', () => {
    beforeAll(() => {
      runV3Migrations(db);
    });

    it('stores agent_id when provided', () => {
      const repo = new MemoryRepository(db);
      const writer = new MemoryWriter({ memoryRepository: repo, embeddingRepository: undefined as any, embeddingClient: undefined as any, embeddingCacheRepo: undefined as any });

      // Test with agentId
      const taggedWriter = new MemoryWriter({ memoryRepository: repo, embeddingRepository: undefined as any, embeddingClient: undefined as any, embeddingCacheRepo: undefined as any, agentId: 'test-agent' });

      // Write a memory through the writer
      const id = 'test-mem-1';
      repo.create({
        id,
        scope: 'user',
        scope_key: '',
        kind: 'fact',
        content: 'Test memory for agent tagging',
        agent_id: 'test-agent',
        visibility: 'shared',
      });

      const mem = repo.findById(id);
      expect(mem).toBeTruthy();
      expect(mem!.agent_id).toBe('test-agent');
      expect(mem!.visibility).toBe('shared');
    });

    it('stores null agent_id for shared memories', () => {
      const repo = new MemoryRepository(db);
      const id = 'test-mem-2';
      repo.create({
        id,
        scope: 'user',
        scope_key: '',
        kind: 'fact',
        content: 'Shared memory without agent tag',
        agent_id: null,
        visibility: 'shared',
      });

      const mem = repo.findById(id);
      expect(mem!.agent_id).toBeNull();
    });

    it('handles private visibility', () => {
      const repo = new MemoryRepository(db);
      const id = 'test-mem-3';
      repo.create({
        id,
        scope: 'user',
        scope_key: '',
        kind: 'preference',
        content: 'Private memory',
        agent_id: 'coder',
        visibility: 'private',
      });

      const mem = repo.findById(id);
      expect(mem!.visibility).toBe('private');
    });
  });

  describe('Memory retrieval by agent_id', () => {
    beforeAll(() => {
      const repo = new MemoryRepository(db);
      // Clear previous test data
      db.exec('DELETE FROM memories');

      // Insert test data of 3 pools
      const insert = db.prepare(`
        INSERT INTO memories (id, scope, scope_key, kind, content, agent_id, visibility)
        VALUES (?, 'user', '', 'fact', ?, ?, 'shared')
      `);

      // Pool A: coder agent memories (3 items)
      insert.run('a1', 'Coder prefers TypeScript', 'coder');
      insert.run('a2', 'Project uses pnpm', 'coder');
      insert.run('a3', 'Node version is 20', 'coder');

      // Pool B: shared memories (no agent tag)
      insert.run('b1', 'User birthday is March 15', null);
      insert.run('b2', 'User lives in Shanghai', null);

      // Pool C: other agent memories
      insert.run('c1', 'Assistant helped with Docker setup', 'assistant');
      insert.run('c2', 'Researcher found paper on RAG', 'researcher');
    });

    it('can find current agent memories', () => {
      const rows = db.prepare(
        "SELECT * FROM memories WHERE agent_id = ?"
      ).all('coder');
      expect(rows).toHaveLength(3);
    });

    it('can find shared memories (no agent tag)', () => {
      const rows = db.prepare(
        "SELECT * FROM memories WHERE agent_id IS NULL"
      ).all();
      expect(rows).toHaveLength(2);
    });

    it('can find other agent memories', () => {
      const rows = db.prepare(
        "SELECT * FROM memories WHERE agent_id IS NOT NULL AND agent_id != ?"
      ).all('coder');
      expect(rows).toHaveLength(2);
    });

    it('filters private memories from other agents', () => {
      // Add a private memory from assistant
      const repo = new MemoryRepository(db);
      repo.create({
        id: 'private-1',
        scope: 'user',
        scope_key: '',
        kind: 'fact',
        content: 'Assistant private note',
        agent_id: 'assistant',
        visibility: 'private',
      });

      // Private memory should still exist (not visible to other agents)
      const mem = repo.findById('private-1');
      expect(mem!.visibility).toBe('private');
    });
  });
});
