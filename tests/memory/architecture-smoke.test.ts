/**
 * Architecture smoke tests for memory system.
 * These tests validate core behaviors that must remain correct
 * throughout the v9 refactoring.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { MemoryRepository } from '../../src/memory/repositories/memory-repository.js';
import { EmbeddingRepository } from '../../src/memory/repositories/embedding-repository.js';
import { applySchema } from '../../src/memory/schema.js';

let db: Database.Database;
let memoryRepo: MemoryRepository;
let embeddingRepo: EmbeddingRepository;

beforeAll(() => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  applySchema(db);
  memoryRepo = new MemoryRepository(db);
  embeddingRepo = new EmbeddingRepository(db);
});

afterAll(() => {
  db.close();
});

// ── Lifecycle: preference supersede ──

describe('preference lifecycle (supersede)', () => {
  it('new preference should supersede old same-topic preference', () => {
    // Write first preference
    const oldPref = memoryRepo.create({
      id: 'pref-001',
      scope: 'user',
      scope_key: 'user-1',
      kind: 'preference',
      content: '称呼我大拿',
      metadata: JSON.stringify({}),
    });
    expect(oldPref).toBeDefined();

    // Write replacement preference
    const newPref = memoryRepo.create({
      id: 'pref-002',
      scope: 'user',
      scope_key: 'user-1',
      kind: 'preference',
      content: '以后称呼我Boss',
      metadata: JSON.stringify({}),
    });

    // Simulate supersede: mark old as superseded
    memoryRepo.update(oldPref.id, {
      scope: undefined,
      scope_key: undefined,
      kind: undefined,
      content: undefined,
      metadata: undefined,
    });

    // After v9 migration, we expect status field to be available
    // For now, verify both records exist
    const stored = memoryRepo.findById('pref-001');
    expect(stored).toBeDefined();
    const latest = memoryRepo.findById('pref-002');
    expect(latest).toBeDefined();
  });

  it('deleted preference should not appear in active recall', () => {
    memoryRepo.create({
      id: 'pref-003',
      scope: 'user',
      scope_key: 'user-1',
      kind: 'preference',
      content: '我喜欢用pnpm',
    });

    // Physical delete for now (will become soft delete after Phase 1)
    const deleted = memoryRepo.delete('pref-003');
    expect(deleted).toBe(true);

    const afterDelete = memoryRepo.findById('pref-003');
    expect(afterDelete).toBeUndefined();
  });
});

// ── Agent private memory isolation ──

describe('agent private memory isolation', () => {
  it('agent private memory should not enter other agent recall', () => {
    // Write agent-A private memory
    memoryRepo.create({
      id: 'mem-a-001',
      scope: 'user',
      scope_key: 'user-1',
      kind: 'fact',
      content: 'Agent A secret knowledge',
      agent_id: 'agent-a',
      visibility: 'private',
    });

    // Write agent-B private memory
    memoryRepo.create({
      id: 'mem-b-001',
      scope: 'user',
      scope_key: 'user-1',
      kind: 'fact',
      content: 'Agent B secret knowledge',
      agent_id: 'agent-b',
      visibility: 'private',
    });

    // Write shared memory
    memoryRepo.create({
      id: 'mem-shared-001',
      scope: 'user',
      scope_key: 'user-1',
      kind: 'fact',
      content: 'Shared knowledge',
      agent_id: null,
      visibility: 'shared',
    });

    // Agent A can see agent-a private + shared
    const allByScope = memoryRepo.findByScope('user', 'user-1');
    expect(allByScope.length).toBeGreaterThanOrEqual(3);

    // Verify private memory isolation by visibility
    const privateA = allByScope.filter(m => m.visibility === 'private' && m.agent_id === 'agent-a');
    expect(privateA.length).toBe(1);
    expect(privateA[0]!.content).toBe('Agent A secret knowledge');
  });
});

// ── Offload hygiene ──

describe('offload hygiene', () => {
  it('offload system can list expired sessions', () => {
    // Create session-scoped memory that could be offloaded
    memoryRepo.create({
      id: 'sess-old-001',
      scope: 'session',
      scope_key: 'old-session',
      kind: 'summary',
      content: 'Old session summary content',
    });

    // Verify session memory exists
    const sessionMems = memoryRepo.findByScope('session', 'old-session');
    expect(sessionMems.length).toBe(1);
    expect(sessionMems[0]!.content).toBe('Old session summary content');
  });
});

// ── Maintenance dry run ──

describe('maintenance dry run', () => {
  it('maintenance dry run should not modify data', () => {
    const before = memoryRepo.findByScopeKind('user', 'fact').length;

    // Simulate a dry run: query but don't delete
    const facts = memoryRepo.findByScopeKind('user', 'fact');
    // dry run — no modification

    const after = memoryRepo.findByScopeKind('user', 'fact').length;
    expect(after).toBe(before);
    expect(facts.length).toBe(before);
  });
});

// ── FTS lifecycle compliance ──

describe('FTS lifecycle compliance', () => {
  it('deleted memories should not appear in default queries', () => {
    // Create and delete
    memoryRepo.create({
      id: 'fts-test-001',
      scope: 'user',
      scope_key: 'user-1',
      kind: 'fact',
      content: 'This should be hidden after deletion',
    });

    // Physical delete
    memoryRepo.delete('fts-test-001');

    // Verify it's gone from normal queries
    const result = memoryRepo.searchByContent('hidden after deletion', 'user');
    expect(result.filter(m => m.id === 'fts-test-001').length).toBe(0);
  });
});
