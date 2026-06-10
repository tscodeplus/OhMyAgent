import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema } from '../../src/memory/schema.js';
import { MemoryRepository } from '../../src/memory/repositories/memory-repository.js';
import { EmbeddingRepository } from '../../src/memory/repositories/embedding-repository.js';
import { MemoryLinkRepository } from '../../src/memory/repositories/memory-link-repository.js';
import { createMemoryListToolDefinition } from '../../src/tools/builtins/memory/list-definition.js';
import { createMemoryDeleteToolDefinition } from '../../src/tools/builtins/memory/delete-definition.js';
import { createMemoryUpdateToolDefinition } from '../../src/tools/builtins/memory/update-definition.js';

function text(result: any): string {
  return result.content.map((c: any) => c.text ?? '').join('\n');
}

function ctx(agentId?: string) {
  return {
    cwd: process.cwd(),
    policyScope: {} as any,
    services: {} as any,
    agentId,
  };
}

describe('memory governance tools', () => {
  let db: Database.Database;
  let memoryRepo: MemoryRepository;
  let embeddingRepo: EmbeddingRepository;
  let linkRepo: MemoryLinkRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applySchema(db);
    memoryRepo = new MemoryRepository(db);
    embeddingRepo = new EmbeddingRepository(db);
    linkRepo = new MemoryLinkRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('lists only memories visible to the current agent', async () => {
    memoryRepo.create({ id: 'own', scope: 'user', scope_key: '', kind: 'fact', content: 'own private', agent_id: 'agent-a', visibility: 'private' });
    memoryRepo.create({ id: 'other-private', scope: 'user', scope_key: '', kind: 'fact', content: 'other private', agent_id: 'agent-b', visibility: 'private' });
    memoryRepo.create({ id: 'shared', scope: 'user', scope_key: '', kind: 'fact', content: 'shared memory', agent_id: 'agent-b', visibility: 'shared' });
    const def = createMemoryListToolDefinition({ memoryRepository: memoryRepo });

    const result = await def.execute({}, ctx('agent-a'));
    const output = text(result);

    expect(output).toContain('own private');
    expect(output).toContain('shared memory');
    expect(output).not.toContain('other private');
  });

  it('soft-deletes visible memory and invalidates cache', async () => {
    memoryRepo.create({ id: 'delete-me', scope: 'user', scope_key: '', kind: 'fact', content: 'delete me', agent_id: 'agent-a', visibility: 'private' });
    const onMemoryChanged = vi.fn();
    const def = createMemoryDeleteToolDefinition({
      memoryRepository: memoryRepo,
      embeddingRepository: embeddingRepo,
      memoryLinkRepository: linkRepo,
      onMemoryChanged,
    });

    const result = await def.execute({ id: 'delete-me' }, ctx('agent-a'));

    expect(text(result)).toContain('Memory soft-deleted');
    // Memory is soft-deleted: findById still returns the row (for governance tools)
    const deletedMemory = memoryRepo.findById('delete-me');
    expect(deletedMemory).toBeDefined();
    expect(deletedMemory!.status).toBe('deleted');
    // findActiveById should NOT return the memory (for retrieval paths)
    expect(memoryRepo.findActiveById('delete-me')).toBeUndefined();
    expect(onMemoryChanged).toHaveBeenCalledOnce();
    expect(onMemoryChanged).toHaveBeenCalledWith(expect.objectContaining({
      content: 'delete me',
      kind: 'fact',
      scope: 'user',
      scopeKey: '',
      action: 'delete',
    }));
  });

  it('does not delete another agent private memory', async () => {
    memoryRepo.create({ id: 'private-b', scope: 'user', scope_key: '', kind: 'fact', content: 'private b', agent_id: 'agent-b', visibility: 'private' });
    const def = createMemoryDeleteToolDefinition({
      memoryRepository: memoryRepo,
      embeddingRepository: embeddingRepo,
    });

    const result = await def.execute({ id: 'private-b' }, ctx('agent-a'));

    expect(result.isError).toBe(true);
    expect(memoryRepo.findById('private-b')).toBeDefined();
  });

  it('updates visible memory content and embedding', async () => {
    memoryRepo.create({ id: 'update-me', scope: 'user', scope_key: '', kind: 'fact', content: 'old content', agent_id: 'agent-a', visibility: 'private' });
    const onMemoryChanged = vi.fn();
    const embeddingClient = {
      embedOne: vi.fn(async () => new Float32Array([1, 0, 0])),
      model: 'test',
    };
    const def = createMemoryUpdateToolDefinition({
      memoryRepository: memoryRepo,
      embeddingRepository: embeddingRepo,
      embeddingClient: embeddingClient as any,
      onMemoryChanged,
    });

    const result = await def.execute({ id: 'update-me', content: 'new content', kind: 'preference' }, ctx('agent-a'));

    expect(text(result)).toContain('Memory updated');
    expect(memoryRepo.findById('update-me')!.content).toBe('new content');
    expect(memoryRepo.findById('update-me')!.kind).toBe('preference');
    expect(embeddingRepo.findByMemoryId('update-me')).toBeDefined();
    expect(onMemoryChanged).toHaveBeenCalledOnce();
    expect(onMemoryChanged).toHaveBeenCalledWith(expect.objectContaining({
      content: 'new content',
      kind: 'preference',
      scope: 'user',
      scopeKey: '',
      action: 'update',
    }));
  });

  it('marks updates from preference to non-preference as preference changes', async () => {
    memoryRepo.create({ id: 'pref-to-fact', scope: 'user', scope_key: '', kind: 'preference', content: 'old preference', agent_id: 'agent-a', visibility: 'private' });
    const onMemoryChanged = vi.fn();
    const embeddingClient = {
      embedOne: vi.fn(async () => new Float32Array([1, 0, 0])),
      model: 'test',
    };
    const def = createMemoryUpdateToolDefinition({
      memoryRepository: memoryRepo,
      embeddingRepository: embeddingRepo,
      embeddingClient: embeddingClient as any,
      onMemoryChanged,
    });

    const result = await def.execute({ id: 'pref-to-fact', content: 'new fact', kind: 'fact' }, ctx('agent-a'));

    expect(text(result)).toContain('Memory updated');
    expect(memoryRepo.findById('pref-to-fact')!.kind).toBe('fact');
    expect(onMemoryChanged).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'preference',
      action: 'update',
    }));
  });
});
