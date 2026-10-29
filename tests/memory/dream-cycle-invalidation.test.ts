// ---------------------------------------------------------------------------
// DreamCycle synthesize must not leave a knowledge page asserting a memory the
// merge just rewrote (plan §8 S1, gap recorded in §10.3).
//
// `synthesize` calls `memoryRepository.update()` directly rather than going
// through `MemoryWriter`, so it was the one write path the page invalidation
// missed: a nightly merge could rewrite a memory's text (or soft-delete it) while
// a page citing it stayed `active` and kept being injected as truth.
//
// The merge itself is mocked — its LLM call is not what this test is about; the
// wiring between "content changed" and "re-queue the citing pages" is.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { openDatabase } from '../../src/memory/db';
import { DreamCycle } from '../../src/memory/dream-cycle';
import { MaintenanceRunRepository } from '../../src/memory/maintenance/maintenance-run-repository';
import { MemoryRepository } from '../../src/memory/repositories/memory-repository';
import { EmbeddingRepository } from '../../src/memory/repositories/embedding-repository';

const MERGED = 'merged: the two memories now say one thing';

vi.mock('../../src/memory/memory-merge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/memory/memory-merge.js')>();
  return {
    ...actual,
    mergeMemory: vi.fn(async () => ({ mergedContent: MERGED, score: 0.99 })),
  };
});

const silentLogger = { warn() {}, info() {}, error() {}, debug() {} };

describe('DreamCycle synthesize — knowledge page invalidation', () => {
  let db: Database.Database;
  let repo: MemoryRepository;

  beforeEach(() => {
    db = openDatabase(':memory:');
    repo = new MemoryRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  function seedMemory(id: string, content: string, createdAt: number): void {
    db.prepare(
      `INSERT INTO memories (id, scope, scope_key, kind, content, confidence, status, created_at, updated_at)
       VALUES (?, 'user', 'session-1', 'fact', ?, 0.9, 'active', ?, ?)`,
    ).run(id, content, String(createdAt), String(createdAt));
    // Identical vectors → cosine 1.0, well above the merge threshold.
    new EmbeddingRepository(db).create({
      id: `emb-${id}`,
      memory_id: id,
      embedding: new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]),
      model: 'test',
      dimension: 8,
    });
  }

  function seedPage(id: string, cites: string): void {
    const now = Date.now();
    db.prepare(
      `INSERT INTO knowledge_pages (id, page_type, slug, title, content, version, status, created_at, updated_at, updated_by)
       VALUES (?, 'topic', ?, ?, 'a page body quoting the memory', 1, 'active', ?, ?, 'agent')`,
    ).run(id, id, id, now, now);
    db.prepare(
      `INSERT INTO knowledge_sources (page_id, source_kind, source_id, created_at)
       VALUES (?, 'memory', ?, ?)`,
    ).run(id, cites, now);
  }

  function pageStatus(id: string): string {
    return (
      db.prepare('SELECT status FROM knowledge_pages WHERE id = ?').get(id) as {
        status: string;
      }
    ).status;
  }

  function buildCycle(): DreamCycle {
    return new DreamCycle(
      {
        enabled: true,
        timezone: '',
        hour: 2,
        minute: 0,
        windowGraceMinutes: 120,
        phaseTimeoutMs: 60_000,
        synthesizeBatchSize: 50,
        catchUpOnStart: false,
      },
      db,
      new MaintenanceRunRepository(db),
      repo,
      {} as never,
      new EmbeddingRepository(db),
      {} as never,
      {} as never,
      undefined,
      {
        auxConfig: undefined,
        mergeThreshold: 0.85,
        logger: silentLogger as never,
      },
      silentLogger as never,
    );
  }

  function runSynthesize(cycle: DreamCycle): Promise<number> {
    return (cycle as unknown as { synthesize(signal: AbortSignal): Promise<number> }).synthesize(
      new AbortController().signal,
    );
  }

  it('re-queues the page that cites the memory whose text the merge rewrote', async () => {
    seedMemory('mem-older', 'Excel ETL uses Power Query', 1_000);
    seedMemory('mem-newer', 'Excel ETL is Power Query based', 2_000);
    seedPage('page-a', 'mem-older');
    seedPage('page-b', 'mem-newer');

    const merged = await runSynthesize(buildCycle());

    expect(merged).toBe(1);
    // The older row is the one that received the merged content.
    expect(repo.findById('mem-older')?.content).toBe(MERGED);
    // Both citations changed meaning: one quotes text that no longer exists,
    // the other points at a row that is no longer readable.
    expect(pageStatus('page-a')).toBe('pending');
    expect(pageStatus('page-b')).toBe('pending');
  });

  it('leaves pages alone when nothing cites the merged memories', async () => {
    seedMemory('mem-older', 'Excel ETL uses Power Query', 1_000);
    seedMemory('mem-newer', 'Excel ETL is Power Query based', 2_000);
    seedPage('page-unrelated', 'mem-not-merged');

    expect(await runSynthesize(buildCycle())).toBe(1);
    expect(pageStatus('page-unrelated')).toBe('active');
  });
});
