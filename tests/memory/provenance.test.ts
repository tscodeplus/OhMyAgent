/**
 * Provenance: `memory_sources` written by the writer, and the `memory:relink`
 * backfill for memories that predate it.
 *
 * Measured on the live database before K1: `memories.source_message_id` was
 * 0/28 and `memory_sources` did not exist, so "hit a memory → read the sentences
 * it came from" was not physically possible. Two things fix that, and both are
 * asserted here: the write path (same transaction as the memory row) and the
 * backfill (conservative matching, and no row when the match is weak — a wrong
 * provenance edge is worse than a missing one).
 *
 * `memories.embedding_status` is covered too: `skipped` (no provider
 * configured) and `failed` (provider call failed) used to be the same silent
 * `return`, which is why vector-leg coverage was invisible.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/memory/db';
import { MessageRepository } from '../../src/memory/repositories/message-repository';
import { MemoryRepository } from '../../src/memory/repositories/memory-repository';
import { EmbeddingRepository } from '../../src/memory/repositories/embedding-repository';
import { EmbeddingCacheRepo } from '../../src/memory/repositories/embedding-cache-repository';
import { MemoryWriter } from '../../src/memory/memory-writer';
import type { EmbeddingStatus } from '../../src/memory/memory-writer';
import { matchSourceMessages, relinkMemorySources } from '../../scripts/memory-relink';

let db: Database.Database;
let messages: MessageRepository;
let memoryRepository: MemoryRepository;

beforeEach(() => {
  db = openDatabase(':memory:');
  messages = new MessageRepository(db);
  memoryRepository = new MemoryRepository(db);
});

afterEach(() => {
  db.close();
});

function seedSession(id: string, channel = 'feishu'): void {
  db.prepare(
    `INSERT INTO sessions (id, chat_id, user_id, project_id, channel, external_chat_id, title, metadata, created_at, updated_at)
     VALUES (?, ?, 'user-1', NULL, ?, NULL, NULL, NULL, '1700000000000', '1700000000000')`,
  ).run(id, id, channel);
}

function seedMessage(input: {
  id: string;
  sessionId: string;
  content: string;
  role?: string;
  createdAt?: number;
}): void {
  messages.create({
    id: input.id,
    session_id: input.sessionId,
    role: input.role ?? 'user',
    content: input.content,
    created_at: input.createdAt ?? 1_700_000_000_000,
  });
}

/** Embedding client whose behaviour the status tests switch on. */
function createEmbeddingClient(mode: 'ok' | 'unconfigured' | 'throws') {
  return {
    model: 'stub',
    isConfigured: () => mode !== 'unconfigured',
    embedOne: async (): Promise<Float32Array> => {
      if (mode === 'throws') throw new Error('provider down');
      return new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]);
    },
    embedBatch: async (texts: string[]): Promise<Float32Array[]> =>
      texts.map(() => new Float32Array([1, 0, 0, 0, 0, 0, 0, 0])),
  };
}

function createWriter(mode: 'ok' | 'unconfigured' | 'throws' = 'unconfigured'): MemoryWriter {
  return new MemoryWriter({
    db,
    memoryRepository,
    embeddingRepository: new EmbeddingRepository(db),
    embeddingCacheRepo: new EmbeddingCacheRepo(db),
    embeddingClient: createEmbeddingClient(mode),
  });
}

function sourceRows(memoryId: string): Array<{
  message_id: string;
  session_id: string;
  role: string;
  source: string;
  created_at: number;
}> {
  return db
    .prepare(
      `SELECT message_id, session_id, role, source, created_at
       FROM memory_sources WHERE memory_id = ? ORDER BY message_id`,
    )
    .all(memoryId) as Array<{
    message_id: string;
    session_id: string;
    role: string;
    source: string;
    created_at: number;
  }>;
}

function embeddingStatus(memoryId: string): EmbeddingStatus | null {
  const row = db.prepare('SELECT embedding_status FROM memories WHERE id = ?').get(memoryId) as
    { embedding_status: EmbeddingStatus | null } | undefined;
  return row?.embedding_status ?? null;
}

describe('MemoryWriter: memory_sources in the memory transaction', () => {
  beforeEach(() => {
    seedSession('s-1');
    seedMessage({ id: 'm-1', sessionId: 's-1', role: 'user', content: 'the plan is K1' });
    seedMessage({
      id: 'm-2',
      sessionId: 's-1',
      role: 'assistant',
      content: 'K1 is session search',
    });
  });

  it('writes one row per source message, with session and role read from messages', async () => {
    const writer = createWriter();
    const result = await writer.write({
      content: 'the plan is K1 and session search',
      scope: 'session',
      scopeKey: 's-1',
      kind: 'summary',
      generateEmbedding: false,
      sourceMessageIds: ['m-1', 'm-2'],
    });

    expect(result.action).toBe('created');
    const rows = sourceRows(result.id);
    expect(rows.map((row) => row.message_id)).toEqual(['m-1', 'm-2']);
    expect(rows.map((row) => row.role)).toEqual(['user', 'assistant']);
    expect(rows.every((row) => row.session_id === 's-1')).toBe(true);
    expect(rows.every((row) => row.source === 'pipeline')).toBe(true);
    // epoch ms as INTEGER, not a TEXT digit string (migration-v13's rule).
    expect(rows.every((row) => Number.isInteger(row.created_at) && row.created_at > 0)).toBe(true);

    // The convenience column mirrors the first source.
    expect(
      db.prepare('SELECT source_message_id FROM memories WHERE id = ?').get(result.id),
    ).toEqual({ source_message_id: 'm-1' });
  });

  it('skips a source message that no longer exists instead of inventing one', async () => {
    const writer = createWriter();
    const result = await writer.write({
      content: 'only one real source',
      scope: 'session',
      scopeKey: 's-1',
      kind: 'summary',
      generateEmbedding: false,
      sourceMessageIds: ['m-1', 'ghost-message'],
    });

    expect(sourceRows(result.id).map((row) => row.message_id)).toEqual(['m-1']);
  });

  it('writes no provenance when the caller passes none', async () => {
    const writer = createWriter();
    const result = await writer.write({
      content: 'no provenance here',
      scope: 'user',
      scopeKey: 's-1',
      kind: 'fact',
      generateEmbedding: false,
    });

    expect(sourceRows(result.id)).toEqual([]);
  });

  it('still stores the memory when no db handle was given', async () => {
    const writer = new MemoryWriter({
      memoryRepository,
      embeddingRepository: new EmbeddingRepository(db),
      embeddingCacheRepo: new EmbeddingCacheRepo(db),
      embeddingClient: createEmbeddingClient('unconfigured'),
    });

    const result = await writer.write({
      content: 'a memory without a connection handle',
      scope: 'user',
      scopeKey: 's-1',
      kind: 'fact',
      generateEmbedding: false,
      sourceMessageIds: ['m-1'],
    });

    expect(memoryRepository.findById(result.id)).toBeDefined();
    expect(sourceRows(result.id)).toEqual([]);
  });
});

describe('MemoryWriter: embedding_status', () => {
  beforeEach(() => {
    seedSession('s-1');
  });

  it('records ok when a vector is stored', async () => {
    const result = await createWriter('ok').write({
      content: 'vector stored for this one',
      scope: 'user',
      scopeKey: 's-1',
      kind: 'fact',
    });

    expect(embeddingStatus(result.id)).toBe('ok');
  });

  it('records skipped — not failed — when no embedding provider is configured', async () => {
    const result = await createWriter('unconfigured').write({
      content: 'no provider configured here',
      scope: 'user',
      scopeKey: 's-1',
      kind: 'fact',
    });

    expect(embeddingStatus(result.id)).toBe('skipped');
    expect(result.warnings).toContain('embedding_unavailable');
  });

  it('records failed when the configured provider throws', async () => {
    const result = await createWriter('throws').write({
      content: 'the provider is having a bad day',
      scope: 'user',
      scopeKey: 's-1',
      kind: 'fact',
    });

    expect(embeddingStatus(result.id)).toBe('failed');
  });

  it('records skipped when the caller turned embedding off', async () => {
    const result = await createWriter('ok').write({
      content: 'embedding explicitly disabled',
      scope: 'user',
      scopeKey: 's-1',
      kind: 'fact',
      generateEmbedding: false,
    });

    expect(embeddingStatus(result.id)).toBe('skipped');
  });
});

describe('matchSourceMessages', () => {
  const sessionMessages = [
    { id: 'm-1', role: 'user', content: 'excel batch replace script with python' },
    { id: 'm-2', role: 'user', content: 'weather forecast for shenzhen tomorrow' },
  ];

  it('takes the messages whose union covers the memory content', () => {
    const matched = matchSourceMessages(
      'excel batch replace script and weather forecast for shenzhen',
      sessionMessages,
    );

    expect(matched.map((entry) => entry.message.id)).toEqual(['m-1', 'm-2']);
  });

  it('returns [] when no message covers enough of the memory', () => {
    const matched = matchSourceMessages(
      'completely unrelated quantum topic about gardening',
      sessionMessages,
    );

    expect(matched).toEqual([]);
  });

  it('returns [] for a memory with no usable tokens', () => {
    expect(matchSourceMessages('...', sessionMessages)).toEqual([]);
  });
});

describe('memory:relink', () => {
  beforeEach(() => {
    seedSession('s-1');
    seedMessage({ id: 'm-1', sessionId: 's-1', content: 'excel batch replace script with python' });
    seedMessage({
      id: 'm-2',
      sessionId: 's-1',
      content: 'weather forecast for shenzhen tomorrow',
    });
  });

  /** Raw insert: these rows stand in for memories written before provenance. */
  function seedMemory(input: {
    id: string;
    content: string;
    scopeKey?: string;
    kind?: string;
    status?: string;
  }): void {
    db.prepare(
      `INSERT INTO memories (id, scope, scope_key, kind, content, status, created_at, updated_at)
       VALUES (?, 'session', ?, ?, ?, ?, '1700000000000', '1700000000000')`,
    ).run(
      input.id,
      input.scopeKey ?? 's-1',
      input.kind ?? 'summary',
      input.content,
      input.status ?? 'active',
    );
  }

  it('links a memory to the messages it was compressed from', () => {
    seedMemory({
      id: 'mem-summary',
      content: 'excel batch replace script and weather forecast for shenzhen',
    });

    const summary = relinkMemorySources(db, { limit: 100, dryRun: false });

    expect(summary).toMatchObject({ scanned: 1, linked: 1, refused: 0, sourcesWritten: 2 });
    const rows = sourceRows('mem-summary');
    expect(rows.map((row) => row.message_id)).toEqual(['m-1', 'm-2']);
    expect(rows.every((row) => row.source === 'backfill')).toBe(true);
    expect(rows.every((row) => row.session_id === 's-1')).toBe(true);
  });

  it('refuses to guess when the match is weak, and writes nothing', () => {
    seedMemory({ id: 'mem-weak', content: 'completely unrelated quantum topic about gardening' });

    const summary = relinkMemorySources(db, { limit: 100, dryRun: false });

    expect(summary).toMatchObject({ scanned: 1, linked: 0, refused: 1, sourcesWritten: 0 });
    expect(sourceRows('mem-weak')).toEqual([]);
  });

  it('refuses when the scope key is not a session', () => {
    seedMemory({ id: 'mem-noSession', content: 'excel batch replace script', scopeKey: 'default' });

    const summary = relinkMemorySources(db, { limit: 100, dryRun: false });

    expect(summary).toMatchObject({ scanned: 1, linked: 0, refused: 1, sourcesWritten: 0 });
    expect(sourceRows('mem-noSession')).toEqual([]);
  });

  it('writes nothing on --dry-run but still reports what it would link', () => {
    seedMemory({ id: 'mem-dry', content: 'excel batch replace script with python' });

    const summary = relinkMemorySources(db, { limit: 100, dryRun: true });

    expect(summary).toMatchObject({ linked: 1, sourcesWritten: 1, dryRun: true });
    expect(sourceRows('mem-dry')).toEqual([]);
  });

  it('honours --limit', () => {
    seedMemory({ id: 'mem-a', content: 'excel batch replace script with python' });
    seedMemory({ id: 'mem-b', content: 'weather forecast for shenzhen tomorrow' });

    const summary = relinkMemorySources(db, { limit: 1, dryRun: false });

    expect(summary.scanned).toBe(1);
    expect(summary.linked).toBe(1);
  });

  it('skips memories that already have provenance', () => {
    seedMemory({ id: 'mem-linked', content: 'excel batch replace script with python' });
    db.prepare(
      `INSERT INTO memory_sources (memory_id, message_id, session_id, role, source, created_at)
       VALUES ('mem-linked', 'm-1', 's-1', 'user', 'pipeline', ?)`,
    ).run(Date.now());

    const summary = relinkMemorySources(db, { limit: 100, dryRun: false });

    expect(summary.scanned).toBe(0);
    expect(sourceRows('mem-linked')).toHaveLength(1);
  });

  it('ignores inactive memories', () => {
    seedMemory({
      id: 'mem-deleted',
      content: 'excel batch replace script with python',
      status: 'deleted',
    });

    expect(relinkMemorySources(db, { limit: 100, dryRun: false }).scanned).toBe(0);
  });

  it('commits in batches and links every memory across the batch boundary', () => {
    // BATCH_SIZE is 25: 30 memories proves the final partial batch is committed
    // too, not dropped.
    for (let index = 0; index < 30; index++) {
      seedMemory({ id: `mem-${index}`, content: 'excel batch replace script with python' });
    }

    const summary = relinkMemorySources(db, { limit: 100, dryRun: false });

    expect(summary).toMatchObject({ scanned: 30, linked: 30, refused: 0 });
    expect(db.prepare('SELECT COUNT(DISTINCT memory_id) AS cnt FROM memory_sources').get()).toEqual(
      { cnt: 30 },
    );
  });

  it('refuses to run on a database without memory_sources', () => {
    db.exec('DROP TABLE memory_sources');

    expect(() => relinkMemorySources(db, { limit: 10, dryRun: true })).toThrow(
      /memory_sources is missing/,
    );
  });
});
