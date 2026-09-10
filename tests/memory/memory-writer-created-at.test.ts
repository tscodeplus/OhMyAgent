import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema } from '../../src/memory/schema';
import { MemoryRepository } from '../../src/memory/repositories/memory-repository';
import { EmbeddingRepository } from '../../src/memory/repositories/embedding-repository';
import { MemoryWriter } from '../../src/memory/memory-writer';

let db: Database.Database;
let memoryRepo: MemoryRepository;
let idCounter = 0;

function uniqueId(prefix: string): string {
  idCounter++;
  return `${prefix}-${Date.now()}-${idCounter}`;
}

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
  memoryRepo = new MemoryRepository(db);
  idCounter = 0;
});

afterEach(() => {
  db.close();
});

function createWriter(): MemoryWriter {
  return new MemoryWriter({
    memoryRepository: memoryRepo,
    embeddingRepository: new EmbeddingRepository(db),
    embeddingClient: { isConfigured: () => false, embedOne: vi.fn() } as any,
    embeddingCacheRepo: { get: () => undefined, set: () => undefined } as any,
  });
}

describe('MemoryWriter createdAt override (TDAM import-timestamp lesson)', () => {
  it('defaults to the DB epoch-ms timestamp when createdAt is omitted', async () => {
    const writer = createWriter();
    const result = await writer.write({
      id: uniqueId('m'),
      content: 'default timestamp memory',
      scope: 'user',
      kind: 'fact',
      generateEmbedding: false,
    });
    const row = memoryRepo.findById(result.id)!;
    // DB default is an epoch-ms digit string
    expect(row.created_at).toMatch(/^\d{10,}$/);
  });

  it('persists the explicitly provided original timestamp', async () => {
    const writer = createWriter();
    const original = 1700000000000; // 2023-11-14 epoch ms
    const result = await writer.write({
      id: uniqueId('m'),
      content: 'imported historical memory',
      scope: 'user',
      kind: 'fact',
      generateEmbedding: false,
      createdAt: original,
    });
    const row = memoryRepo.findById(result.id);
    expect(row!.created_at).toBe(String(original));
    // Timeline ordering stays truthful: imported memory sorts before "now".
    const newer = await writer.write({
      id: uniqueId('m'),
      content: 'fresh memory written after import',
      scope: 'user',
      kind: 'fact',
      generateEmbedding: false,
    });
    const newerRow = memoryRepo.findById(newer.id)!;
    expect(Number(newerRow.created_at)).toBeGreaterThan(Number(row!.created_at));
  });

  it('repository create() accepts a raw created_at string directly', () => {
    const created = memoryRepo.create({
      id: uniqueId('repo'),
      scope: 'user',
      scope_key: 'u',
      kind: 'fact',
      content: 'repo-level import',
      created_at: '2024-06-01T00:00:00.000Z',
    });
    expect(created.created_at).toBe('2024-06-01T00:00:00.000Z');
  });

  it('repository create() without created_at still gets the DB default', () => {
    const created = memoryRepo.create({
      id: uniqueId('repo'),
      scope: 'user',
      scope_key: 'u',
      kind: 'fact',
      content: 'no explicit timestamp',
    });
    expect(created.created_at).toMatch(/^\d{10,}$/);
  });
});
