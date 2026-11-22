/**
 * Preference arbitration runs on write time, unless the caller states when the
 * preference happened.
 *
 * `MemoryWriter` dedupes preferences by superseding the losers of a topic, and
 * the winner was picked by `updated_at` — write time. That is right for a live
 * conversation and wrong for an import: a preference from six months ago,
 * written today, would outrank every conclusion reached since simply by being
 * inserted later. `WriteOptions.createdAt` already carried the source event
 * time (it becomes `memories.created_at`), so arbitration now uses it when it is
 * present.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema } from '../../src/memory/schema';
import { MemoryRepository } from '../../src/memory/repositories/memory-repository';
import { EmbeddingRepository } from '../../src/memory/repositories/embedding-repository';
import { MemoryWriter } from '../../src/memory/memory-writer';
import { PreferenceConflictResolver } from '../../src/memory/write/preference-conflict-resolver';

const DAY_MS = 24 * 60 * 60 * 1000;

let db: Database.Database;
let memoryRepo: MemoryRepository;
let idCounter = 0;

function uniqueId(prefix: string): string {
  idCounter++;
  return `${prefix}-${Date.now()}-${idCounter}`;
}

function createWriter(): MemoryWriter {
  return new MemoryWriter({
    memoryRepository: memoryRepo,
    embeddingRepository: new EmbeddingRepository(db),
    embeddingClient: { isConfigured: () => false, embedOne: vi.fn() } as never,
    embeddingCacheRepo: { get: () => undefined, set: () => undefined } as never,
  });
}

/** Write a preference and pin its `updated_at` (write time) explicitly. */
function writePreferenceAt(content: string, updatedAtMs: number): string {
  const id = uniqueId('pref');
  memoryRepo.create({ id, scope: 'user', scope_key: 'u1', kind: 'preference', content });
  db.prepare('UPDATE memories SET updated_at = ? WHERE id = ?').run(String(updatedAtMs), id);
  return id;
}

function status(id: string): string {
  return memoryRepo.findById(id)?.status ?? 'missing';
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

describe('preference arbitration time basis', () => {
  it('keeps write-time arbitration when no event time is supplied', () => {
    const now = Date.now();
    const recent = writePreferenceAt('叫我小明', now - 10 * DAY_MS);
    const incoming = writePreferenceAt('叫我小强', now);

    const resolution = new PreferenceConflictResolver(memoryRepo).resolve(incoming, '叫我小强', {
      scope: 'user',
      scopeKey: 'u1',
    });

    // The row written last wins — the live-conversation behaviour.
    expect(resolution.winnerId).toBe(incoming);
    expect(resolution.supersededIds).toContain(recent);
    expect(status(recent)).not.toBe('active');
    expect(status(incoming)).toBe('active');
  });

  it('ranks an imported preference by its event time, so it loses to newer ones', () => {
    const now = Date.now();
    const recent = writePreferenceAt('叫我小明', now - 10 * DAY_MS);
    // Written now, but the preference itself is six months old.
    const imported = writePreferenceAt('叫我小强', now);

    const resolution = new PreferenceConflictResolver(memoryRepo).resolve(imported, '叫我小强', {
      scope: 'user',
      scopeKey: 'u1',
      eventAt: now - 180 * DAY_MS,
    });

    expect(resolution.winnerId).toBe(recent);
    expect(resolution.supersededIds).toEqual([imported]);
    expect(status(recent)).toBe('active');
    expect(status(imported)).not.toBe('active');
  });

  it('ranks a recent import ahead of an older conclusion', () => {
    const now = Date.now();
    const stale = writePreferenceAt('叫我小明', now - 180 * DAY_MS);
    const imported = writePreferenceAt('叫我小强', now);

    const resolution = new PreferenceConflictResolver(memoryRepo).resolve(imported, '叫我小强', {
      scope: 'user',
      scopeKey: 'u1',
      eventAt: now - 10 * DAY_MS,
    });

    // Event time (10 days ago) beats the row last written six months ago.
    expect(resolution.winnerId).toBe(imported);
    expect(resolution.supersededIds).toEqual([stale]);
    expect(status(stale)).not.toBe('active');
    expect(status(imported)).toBe('active');
  });

  it('passes WriteOptions.createdAt through to arbitration', async () => {
    const now = Date.now();
    const recent = writePreferenceAt('叫我小明', now - 10 * DAY_MS);

    const result = await createWriter().write({
      content: '叫我小强',
      scope: 'user',
      scopeKey: 'u1',
      kind: 'preference',
      generateEmbedding: false,
      createdAt: now - 180 * DAY_MS,
    });

    // The imported row lost: arbitration used its event time, not the write.
    expect(status(result.id)).not.toBe('active');
    expect(status(recent)).toBe('active');
  });
});
