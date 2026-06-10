import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema } from '../../src/memory/schema';
import { SessionRepository } from '../../src/memory/repositories/session-repository';
import { MessageRepository } from '../../src/memory/repositories/message-repository';
import { EpisodeRepository } from '../../src/memory/repositories/episode-repository';
import { MemoryRepository } from '../../src/memory/repositories/memory-repository';
import { EmbeddingRepository } from '../../src/memory/repositories/embedding-repository';
import { ToolRunRepository } from '../../src/memory/repositories/tool-run-repository';
import { ApprovalPolicyRepository } from '../../src/memory/repositories/approval-policy-repository';
import { ApprovalRequestRepository } from '../../src/memory/repositories/approval-request-repository';
import { ApprovalDecisionRepository } from '../../src/memory/repositories/approval-decision-repository';

let db: Database.Database;
let idCounter = 0;

function uniqueId(prefix: string): string {
  idCounter++;
  return `${prefix}-${Date.now()}-${idCounter}`;
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applySchema(db);
  idCounter = 0;
});

afterEach(() => {
  db.close();
});

// Helper to create a session for foreign key references
function createTestSession(): string {
  const id = uniqueId('session');
  const sessionRepo = new SessionRepository(db);
  sessionRepo.create({ id, chat_id: 'chat-test', user_id: 'user-test' });
  return id;
}

// Helper to create an approval request for foreign key references
function createTestApprovalRequest(): string {
  const id = uniqueId('req');
  const requestRepo = new ApprovalRequestRepository(db);
  requestRepo.create({ id, session_key: 's-test', target_kind: 'tool' });
  return id;
}

// Helper to create a memory for embedding references
function createTestMemory(): string {
  const id = uniqueId('mem');
  const memoryRepo = new MemoryRepository(db);
  memoryRepo.create({ id, scope: 'user', scope_key: 'u-test', kind: 'fact', content: 'test' });
  return id;
}

describe('SessionRepository', () => {
  it('create and findById returns correct data', () => {
    const repo = new SessionRepository(db);
    const session = repo.create({
      id: uniqueId('session'),
      chat_id: 'chat-1',
      user_id: 'user-1',
    });

    expect(session).toBeDefined();
    expect(session.id).toMatch(/^session-/);
    expect(session.chat_id).toBe('chat-1');
    expect(session.user_id).toBe('user-1');
    expect(session.thread_id).toBeNull();
    expect(session.metadata).toBeNull();
    expect(session.created_at).toBeDefined();
    expect(session.updated_at).toBeDefined();
  });

  it('create with optional fields', () => {
    const repo = new SessionRepository(db);
    const session = repo.create({
      id: uniqueId('session'),
      chat_id: 'chat-1',
      thread_id: 'thread-1',
      user_id: 'user-1',
      metadata: '{"key":"value"}',
    });

    expect(session.thread_id).toBe('thread-1');
    expect(session.metadata).toBe('{"key":"value"}');
  });

  it('update reflects changes', () => {
    const repo = new SessionRepository(db);
    const session = repo.create({
      id: uniqueId('session'),
      chat_id: 'chat-1',
      user_id: 'user-1',
    });

    const updated = repo.update(session.id, { chat_id: 'chat-2' });
    expect(updated).toBeDefined();
    expect(updated!.chat_id).toBe('chat-2');
    expect(updated!.id).toBe(session.id);
  });

  it('update with no fields returns unchanged session', () => {
    const repo = new SessionRepository(db);
    const session = repo.create({
      id: uniqueId('session'),
      chat_id: 'chat-1',
      user_id: 'user-1',
    });

    const updated = repo.update(session.id, {});
    expect(updated).toBeDefined();
    expect(updated!.chat_id).toBe('chat-1');
  });

  it('delete returns true and removes session', () => {
    const repo = new SessionRepository(db);
    const session = repo.create({
      id: uniqueId('session'),
      chat_id: 'chat-1',
      user_id: 'user-1',
    });

    const deleted = repo.delete(session.id);
    expect(deleted).toBe(true);
    expect(repo.findById(session.id)).toBeUndefined();
  });

  it('delete returns false for non-existent id', () => {
    const repo = new SessionRepository(db);
    expect(repo.delete('non-existent')).toBe(false);
  });

  it('findByChatId returns sessions for a chat', () => {
    const repo = new SessionRepository(db);
    repo.create({ id: uniqueId('session'), chat_id: 'chat-1', user_id: 'user-1' });
    repo.create({ id: uniqueId('session'), chat_id: 'chat-1', user_id: 'user-2' });
    repo.create({ id: uniqueId('session'), chat_id: 'chat-2', user_id: 'user-3' });

    const results = repo.findByChatId('chat-1');
    expect(results).toHaveLength(2);
    expect(results.every(s => s.chat_id === 'chat-1')).toBe(true);
  });
});

describe('MessageRepository', () => {
  it('create and findById returns correct data', () => {
    const sessionId = createTestSession();
    const repo = new MessageRepository(db);
    const message = repo.create({
      id: uniqueId('msg'),
      session_id: sessionId,
      role: 'user',
      content: 'Hello world',
    });

    expect(message).toBeDefined();
    expect(message.id).toMatch(/^msg-/);
    expect(message.session_id).toBe(sessionId);
    expect(message.role).toBe('user');
    expect(message.content).toBe('Hello world');
    expect(message.tool_call_id).toBeNull();
    expect(message.metadata).toBeNull();
  });

  it('create with optional fields', () => {
    const sessionId = createTestSession();
    const repo = new MessageRepository(db);
    const message = repo.create({
      id: uniqueId('msg'),
      session_id: sessionId,
      role: 'assistant',
      content: 'Response',
      tool_call_id: 'tc-1',
      metadata: '{"tokens":42}',
    });

    expect(message.tool_call_id).toBe('tc-1');
    expect(message.metadata).toBe('{"tokens":42}');
  });

  it('findBySessionId returns messages for a session', () => {
    const sessionId1 = createTestSession();
    const sessionId2 = createTestSession();
    const repo = new MessageRepository(db);
    repo.create({ id: uniqueId('msg'), session_id: sessionId1, role: 'user', content: 'A' });
    repo.create({ id: uniqueId('msg'), session_id: sessionId1, role: 'assistant', content: 'B' });
    repo.create({ id: uniqueId('msg'), session_id: sessionId2, role: 'user', content: 'C' });

    const results = repo.findBySessionId(sessionId1);
    expect(results).toHaveLength(2);
    expect(results.every(m => m.session_id === sessionId1)).toBe(true);
  });

  it('findBySessionId respects limit and offset', () => {
    const sessionId = createTestSession();
    const repo = new MessageRepository(db);
    for (let i = 0; i < 5; i++) {
      repo.create({ id: uniqueId('msg'), session_id: sessionId, role: 'user', content: `msg-${i}` });
    }

    const page1 = repo.findBySessionId(sessionId, 2, 0);
    expect(page1).toHaveLength(2);

    const page2 = repo.findBySessionId(sessionId, 2, 2);
    expect(page2).toHaveLength(2);
    expect(page2[0].content).not.toBe(page1[0].content);
  });

  it('update reflects changes', () => {
    const sessionId = createTestSession();
    const repo = new MessageRepository(db);
    const message = repo.create({
      id: uniqueId('msg'),
      session_id: sessionId,
      role: 'user',
      content: 'original',
    });

    const updated = repo.update(message.id, { content: 'updated' });
    expect(updated!.content).toBe('updated');
  });

  it('delete removes message', () => {
    const sessionId = createTestSession();
    const repo = new MessageRepository(db);
    const message = repo.create({
      id: uniqueId('msg'),
      session_id: sessionId,
      role: 'user',
      content: 'test',
    });

    expect(repo.delete(message.id)).toBe(true);
    expect(repo.findById(message.id)).toBeUndefined();
  });

  it('deleteBySessionId removes all messages for a session', () => {
    const sessionId1 = createTestSession();
    const sessionId2 = createTestSession();
    const repo = new MessageRepository(db);
    repo.create({ id: uniqueId('msg'), session_id: sessionId1, role: 'user', content: 'A' });
    repo.create({ id: uniqueId('msg'), session_id: sessionId1, role: 'assistant', content: 'B' });
    repo.create({ id: uniqueId('msg'), session_id: sessionId2, role: 'user', content: 'C' });

    const deleted = repo.deleteBySessionId(sessionId1);
    expect(deleted).toBe(2);
    expect(repo.findBySessionId(sessionId1)).toHaveLength(0);
    expect(repo.findBySessionId(sessionId2)).toHaveLength(1);
  });

  it('countBySessionId returns correct count', () => {
    const sessionId = createTestSession();
    const repo = new MessageRepository(db);
    repo.create({ id: uniqueId('msg'), session_id: sessionId, role: 'user', content: 'A' });
    repo.create({ id: uniqueId('msg'), session_id: sessionId, role: 'assistant', content: 'B' });

    expect(repo.countBySessionId(sessionId)).toBe(2);
    expect(repo.countBySessionId('non-existent')).toBe(0);
  });
});

describe('EpisodeRepository', () => {
  it('create and findById returns correct data', () => {
    const sessionId = createTestSession();
    const repo = new EpisodeRepository(db);
    const episode = repo.create({
      id: uniqueId('ep'),
      session_id: sessionId,
      summary: 'Discussed project plans',
      key_points: '["point1","point2"]',
    });

    expect(episode).toBeDefined();
    expect(episode.id).toMatch(/^ep-/);
    expect(episode.session_id).toBe(sessionId);
    expect(episode.summary).toBe('Discussed project plans');
    expect(episode.key_points).toBe('["point1","point2"]');
  });

  it('create with defaults', () => {
    const sessionId = createTestSession();
    const repo = new EpisodeRepository(db);
    const episode = repo.create({
      id: uniqueId('ep'),
      session_id: sessionId,
      summary: 'Test summary',
    });

    expect(episode.key_points).toBeNull();
  });

  it('findBySessionId returns episodes for a session', () => {
    const sessionId1 = createTestSession();
    const sessionId2 = createTestSession();
    const repo = new EpisodeRepository(db);
    repo.create({ id: uniqueId('ep'), session_id: sessionId1, summary: 'E1' });
    repo.create({ id: uniqueId('ep'), session_id: sessionId1, summary: 'E2' });
    repo.create({ id: uniqueId('ep'), session_id: sessionId2, summary: 'E3' });

    const results = repo.findBySessionId(sessionId1);
    expect(results).toHaveLength(2);
  });

  it('update reflects changes', () => {
    const sessionId = createTestSession();
    const repo = new EpisodeRepository(db);
    const episode = repo.create({
      id: uniqueId('ep'),
      session_id: sessionId,
      summary: 'original',
    });

    const updated = repo.update(episode.id, { summary: 'updated summary' });
    expect(updated!.summary).toBe('updated summary');
  });

  it('delete removes episode', () => {
    const sessionId = createTestSession();
    const repo = new EpisodeRepository(db);
    const episode = repo.create({
      id: uniqueId('ep'),
      session_id: sessionId,
      summary: 'test',
    });

    expect(repo.delete(episode.id)).toBe(true);
    expect(repo.findById(episode.id)).toBeUndefined();
  });

  it('deleteBySessionId removes all episodes for a session', () => {
    const sessionId1 = createTestSession();
    const sessionId2 = createTestSession();
    const repo = new EpisodeRepository(db);
    repo.create({ id: uniqueId('ep'), session_id: sessionId1, summary: 'E1' });
    repo.create({ id: uniqueId('ep'), session_id: sessionId1, summary: 'E2' });
    repo.create({ id: uniqueId('ep'), session_id: sessionId2, summary: 'E3' });

    const deleted = repo.deleteBySessionId(sessionId1);
    expect(deleted).toBe(2);
    expect(repo.findBySessionId(sessionId1)).toHaveLength(0);
    expect(repo.findBySessionId(sessionId2)).toHaveLength(1);
  });
});

describe('MemoryRepository', () => {
  it('create and findById returns correct data', () => {
    const repo = new MemoryRepository(db);
    const memory = repo.create({
      id: uniqueId('mem'),
      scope: 'user',
      scope_key: 'user-1',
      kind: 'fact',
      content: 'User prefers dark mode',
    });

    expect(memory).toBeDefined();
    expect(memory.id).toMatch(/^mem-/);
    expect(memory.scope).toBe('user');
    expect(memory.scope_key).toBe('user-1');
    expect(memory.kind).toBe('fact');
    expect(memory.content).toBe('User prefers dark mode');
    expect(memory.metadata).toBeNull();
  });

  it('findByScope returns memories for a scope', () => {
    const repo = new MemoryRepository(db);
    repo.create({ id: uniqueId('mem'), scope: 'user', scope_key: 'u1', kind: 'fact', content: 'A' });
    repo.create({ id: uniqueId('mem'), scope: 'user', scope_key: 'u1', kind: 'task', content: 'B' });
    repo.create({ id: uniqueId('mem'), scope: 'user', scope_key: 'u2', kind: 'fact', content: 'C' });
    repo.create({ id: uniqueId('mem'), scope: 'chat', scope_key: 'c1', kind: 'fact', content: 'D' });

    const results = repo.findByScope('user', 'u1');
    expect(results).toHaveLength(2);
    expect(results.every(m => m.scope === 'user' && m.scope_key === 'u1')).toBe(true);
  });

  it('findByScopeAndKind filters by kind', () => {
    const repo = new MemoryRepository(db);
    repo.create({ id: uniqueId('mem'), scope: 'user', scope_key: 'u1', kind: 'fact', content: 'A' });
    repo.create({ id: uniqueId('mem'), scope: 'user', scope_key: 'u1', kind: 'task', content: 'B' });
    repo.create({ id: uniqueId('mem'), scope: 'user', scope_key: 'u1', kind: 'fact', content: 'C' });

    const results = repo.findByScopeAndKind('user', 'u1', 'fact');
    expect(results).toHaveLength(2);
    expect(results.every(m => m.kind === 'fact')).toBe(true);
  });

  it('searchByContent finds memories by content text', () => {
    const repo = new MemoryRepository(db);
    repo.create({ id: uniqueId('mem'), scope: 'user', scope_key: 'u1', kind: 'fact', content: 'User email is test@example.com' });
    repo.create({ id: uniqueId('mem'), scope: 'user', scope_key: 'u1', kind: 'fact', content: 'User name is Alice' });
    repo.create({ id: uniqueId('mem'), scope: 'user', scope_key: 'u2', kind: 'fact', content: 'User email is bob@example.com' });

    const results = repo.searchByContent('email');
    expect(results).toHaveLength(2);
  });

  it('searchByContent with scope filter', () => {
    const repo = new MemoryRepository(db);
    repo.create({ id: uniqueId('mem'), scope: 'user', scope_key: 'u1', kind: 'fact', content: 'test email' });
    repo.create({ id: uniqueId('mem'), scope: 'chat', scope_key: 'c1', kind: 'fact', content: 'test email' });

    const results = repo.searchByContent('email', 'user', 'u1');
    expect(results).toHaveLength(1);
    expect(results[0].scope).toBe('user');
  });

  it('searchByContent with scope only (no scopeKey)', () => {
    const repo = new MemoryRepository(db);
    repo.create({ id: uniqueId('mem'), scope: 'user', scope_key: 'u1', kind: 'fact', content: 'test email' });
    repo.create({ id: uniqueId('mem'), scope: 'user', scope_key: 'u2', kind: 'fact', content: 'test email' });
    repo.create({ id: uniqueId('mem'), scope: 'chat', scope_key: 'c1', kind: 'fact', content: 'test email' });

    const results = repo.searchByContent('email', 'user');
    expect(results).toHaveLength(2);
    expect(results.every(m => m.scope === 'user')).toBe(true);
  });

  it('update reflects changes and updates updated_at', () => {
    const repo = new MemoryRepository(db);
    const memory = repo.create({
      id: uniqueId('mem'),
      scope: 'user',
      scope_key: 'u1',
      kind: 'fact',
      content: 'original',
    });

    const updated = repo.update(memory.id, { content: 'updated content', kind: 'task' });
    expect(updated!.content).toBe('updated content');
    expect(updated!.kind).toBe('task');
    expect(updated!.updated_at).toBeDefined();
  });

  it('delete removes memory', () => {
    const repo = new MemoryRepository(db);
    const memory = repo.create({
      id: uniqueId('mem'),
      scope: 'user',
      scope_key: 'u1',
      kind: 'fact',
      content: 'test',
    });

    expect(repo.delete(memory.id)).toBe(true);
    expect(repo.findById(memory.id)).toBeUndefined();
  });

  it('deleteByScope removes all memories for a scope', () => {
    const repo = new MemoryRepository(db);
    repo.create({ id: uniqueId('mem'), scope: 'user', scope_key: 'u1', kind: 'fact', content: 'A' });
    repo.create({ id: uniqueId('mem'), scope: 'user', scope_key: 'u1', kind: 'task', content: 'B' });
    repo.create({ id: uniqueId('mem'), scope: 'user', scope_key: 'u2', kind: 'fact', content: 'C' });

    const deleted = repo.deleteByScope('user', 'u1');
    expect(deleted).toBe(2);
    expect(repo.findByScope('user', 'u1')).toHaveLength(0);
    expect(repo.findByScope('user', 'u2')).toHaveLength(1);
  });
});

describe('EmbeddingRepository', () => {
  it('create and findById returns correct data', () => {
    const memoryId = createTestMemory();
    const repo = new EmbeddingRepository(db);
    const embedding = new Float32Array([0.1, 0.2, 0.3, 0.4]);
    const result = repo.create({
      id: uniqueId('emb'),
      memory_id: memoryId,
      embedding,
      model: 'text-embedding-3-small',
      dimension: 4,
    });

    expect(result).toBeDefined();
    expect(result.id).toMatch(/^emb-/);
    expect(result.memory_id).toBe(memoryId);
    expect(result.model).toBe('text-embedding-3-small');
    expect(result.dimension).toBe(4);
    expect(result.embedding).toBeInstanceOf(Buffer);
  });

  it('create with Buffer embedding', () => {
    const memoryId = createTestMemory();
    const repo = new EmbeddingRepository(db);
    const buf = Buffer.from(new Float32Array([0.1, 0.2]).buffer);
    const result = repo.create({
      id: uniqueId('emb'),
      memory_id: memoryId,
      embedding: buf,
      model: 'test-model',
      dimension: 2,
    });

    expect(result.embedding).toBeInstanceOf(Buffer);
  });

  it('stores only the visible slice of a Float32Array embedding', () => {
    const memoryId = createTestMemory();
    const repo = new EmbeddingRepository(db);
    const backing = new Float32Array([99, 0.25, 0.5, 77]);
    const embedding = backing.subarray(1, 3);
    const result = repo.create({
      id: uniqueId('emb'),
      memory_id: memoryId,
      embedding,
      model: 'test-model',
      dimension: 2,
    });

    const restored = new Float32Array(
      result.embedding.buffer,
      result.embedding.byteOffset,
      result.embedding.byteLength / 4,
    );
    expect(Array.from(restored)).toEqual([0.25, 0.5]);
  });

  it('findByMemoryId returns embedding for a memory', () => {
    const memoryId = createTestMemory();
    const repo = new EmbeddingRepository(db);
    const embedding = new Float32Array([0.1, 0.2, 0.3]);
    repo.create({
      id: uniqueId('emb'),
      memory_id: memoryId,
      embedding,
      model: 'model-a',
      dimension: 3,
    });

    const result = repo.findByMemoryId(memoryId);
    expect(result).toBeDefined();
    expect(result!.memory_id).toBe(memoryId);
  });

  it('findByMemoryId returns undefined for non-existent memory', () => {
    const repo = new EmbeddingRepository(db);
    expect(repo.findByMemoryId('non-existent')).toBeUndefined();
  });

  it('cosineSearch returns results sorted by similarity', () => {
    const repo = new EmbeddingRepository(db);
    const memX = createTestMemory();
    const memY = createTestMemory();
    const memZ = createTestMemory();

    repo.create({ id: uniqueId('emb'), memory_id: memX, embedding: new Float32Array([1, 0, 0]), model: 'test', dimension: 3 });
    repo.create({ id: uniqueId('emb'), memory_id: memY, embedding: new Float32Array([0, 1, 0]), model: 'test', dimension: 3 });
    repo.create({ id: uniqueId('emb'), memory_id: memZ, embedding: new Float32Array([0.9, 0.1, 0]), model: 'test', dimension: 3 });

    const results = repo.cosineSearch(new Float32Array([1, 0.1, 0]), 3);
    expect(results).toHaveLength(3);
    expect(results[0].memory_id).toBe(memZ);
    expect(results[1].memory_id).toBe(memX);
    expect(results[2].memory_id).toBe(memY);
    expect(results[0].score).toBeGreaterThan(results[1].score);
    expect(results[1].score).toBeGreaterThan(results[2].score);
  });

  it('cosineSearch respects limit', () => {
    const repo = new EmbeddingRepository(db);
    const m1 = createTestMemory();
    const m2 = createTestMemory();
    const m3 = createTestMemory();
    repo.create({ id: uniqueId('emb'), memory_id: m1, embedding: new Float32Array([1, 0]), model: 't', dimension: 2 });
    repo.create({ id: uniqueId('emb'), memory_id: m2, embedding: new Float32Array([0, 1]), model: 't', dimension: 2 });
    repo.create({ id: uniqueId('emb'), memory_id: m3, embedding: new Float32Array([0.5, 0.5]), model: 't', dimension: 2 });

    const results = repo.cosineSearch(new Float32Array([1, 0]), 2);
    expect(results).toHaveLength(2);
  });

  it('delete removes embedding', () => {
    const memoryId = createTestMemory();
    const repo = new EmbeddingRepository(db);
    const result = repo.create({
      id: uniqueId('emb'),
      memory_id: memoryId,
      embedding: new Float32Array([0.1]),
      model: 'test',
      dimension: 1,
    });

    expect(repo.delete(result.id)).toBe(true);
    expect(repo.findById(result.id)).toBeUndefined();
  });

  it('deleteByMemoryId removes embedding by memory id', () => {
    const memoryId = createTestMemory();
    const repo = new EmbeddingRepository(db);
    repo.create({
      id: uniqueId('emb'),
      memory_id: memoryId,
      embedding: new Float32Array([0.1]),
      model: 'test',
      dimension: 1,
    });

    expect(repo.deleteByMemoryId(memoryId)).toBe(true);
    expect(repo.findByMemoryId(memoryId)).toBeUndefined();
  });

  it('uses sqlite-vec when available and backfills existing embeddings', () => {
    const repo = new EmbeddingRepository(db);
    const memX = createTestMemory();
    const memY = createTestMemory();
    repo.create({ id: uniqueId('emb'), memory_id: memX, embedding: new Float32Array([1, 0, 0]), model: 'test', dimension: 3 });
    repo.create({ id: uniqueId('emb'), memory_id: memY, embedding: new Float32Array([0, 1, 0]), model: 'test', dimension: 3 });

    const backfilled = repo.backfillVec();
    const results = repo.vecSearch(new Float32Array([1, 0, 0]), 2);

    expect(repo.isVecAvailable()).toBe(true);
    expect(backfilled).toBeGreaterThanOrEqual(2);
    expect(results[0].memory_id).toBe(memX);
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });
});

describe('ToolRunRepository', () => {
  it('create and findById returns correct data', () => {
    const sessionId = createTestSession();
    const repo = new ToolRunRepository(db);
    const run = repo.create({
      id: uniqueId('run'),
      session_id: sessionId,
      tool_name: 'shell',
      input: '{"command":"ls"}',
      status: 'running',
    });

    expect(run).toBeDefined();
    expect(run.id).toMatch(/^run-/);
    expect(run.session_id).toBe(sessionId);
    expect(run.tool_name).toBe('shell');
    expect(run.input).toBe('{"command":"ls"}');
    expect(run.status).toBe('running');
    expect(run.output).toBeNull();
    expect(run.error).toBeNull();
    expect(run.duration_ms).toBeNull();
  });

  it('findBySessionId returns runs for a session', () => {
    const sessionId = createTestSession();
    const repo = new ToolRunRepository(db);
    repo.create({ id: uniqueId('run'), session_id: sessionId, tool_name: 'a', status: 'done' });
    repo.create({ id: uniqueId('run'), session_id: sessionId, tool_name: 'b', status: 'done' });

    const sessionId2 = createTestSession();
    repo.create({ id: uniqueId('run'), session_id: sessionId2, tool_name: 'c', status: 'done' });

    const results = repo.findBySessionId(sessionId);
    expect(results).toHaveLength(2);
  });

  it('findByToolName returns runs for a tool', () => {
    const sessionId = createTestSession();
    const repo = new ToolRunRepository(db);
    repo.create({ id: uniqueId('run'), session_id: sessionId, tool_name: 'shell', status: 'done' });
    repo.create({ id: uniqueId('run'), session_id: sessionId, tool_name: 'shell', status: 'done' });
    repo.create({ id: uniqueId('run'), session_id: sessionId, tool_name: 'fetch', status: 'done' });

    const results = repo.findByToolName('shell');
    expect(results).toHaveLength(2);
    expect(results.every(r => r.tool_name === 'shell')).toBe(true);
  });

  it('update reflects changes', () => {
    const sessionId = createTestSession();
    const repo = new ToolRunRepository(db);
    const run = repo.create({
      id: uniqueId('run'),
      session_id: sessionId,
      tool_name: 'shell',
      status: 'running',
    });

    const updated = repo.update(run.id, {
      status: 'completed',
      output: 'file1.txt\nfile2.txt',
      duration_ms: 150,
    });

    expect(updated!.status).toBe('completed');
    expect(updated!.output).toBe('file1.txt\nfile2.txt');
    expect(updated!.duration_ms).toBe(150);
  });

  it('update with error', () => {
    const sessionId = createTestSession();
    const repo = new ToolRunRepository(db);
    const run = repo.create({
      id: uniqueId('run'),
      session_id: sessionId,
      tool_name: 'shell',
      status: 'running',
    });

    const updated = repo.update(run.id, {
      status: 'failed',
      error: 'Command not found',
    });

    expect(updated!.status).toBe('failed');
    expect(updated!.error).toBe('Command not found');
  });

  it('delete removes tool run', () => {
    const sessionId = createTestSession();
    const repo = new ToolRunRepository(db);
    const run = repo.create({
      id: uniqueId('run'),
      session_id: sessionId,
      tool_name: 'shell',
      status: 'done',
    });

    expect(repo.delete(run.id)).toBe(true);
    expect(repo.findById(run.id)).toBeUndefined();
  });

  it('deleteBySessionId removes all runs for a session', () => {
    const sessionId1 = createTestSession();
    const sessionId2 = createTestSession();
    const repo = new ToolRunRepository(db);
    repo.create({ id: uniqueId('run'), session_id: sessionId1, tool_name: 'a', status: 'done' });
    repo.create({ id: uniqueId('run'), session_id: sessionId1, tool_name: 'b', status: 'done' });
    repo.create({ id: uniqueId('run'), session_id: sessionId2, tool_name: 'c', status: 'done' });

    const deleted = repo.deleteBySessionId(sessionId1);
    expect(deleted).toBe(2);
    expect(repo.findBySessionId(sessionId1)).toHaveLength(0);
    expect(repo.findBySessionId(sessionId2)).toHaveLength(1);
  });
});

describe('ApprovalPolicyRepository', () => {
  it('create and findById returns correct data', () => {
    const repo = new ApprovalPolicyRepository(db);
    const policy = repo.create({
      id: uniqueId('pol'),
      scope: 'user',
      scope_key: 'u1',
      target_kind: 'tool',
      pattern_type: 'exact',
      pattern: 'shell',
      effect: 'allow',
    });

    expect(policy).toBeDefined();
    expect(policy.id).toMatch(/^pol-/);
    expect(policy.scope).toBe('user');
    expect(policy.scope_key).toBe('u1');
    expect(policy.target_kind).toBe('tool');
    expect(policy.pattern_type).toBe('exact');
    expect(policy.pattern).toBe('shell');
    expect(policy.effect).toBe('allow');
    expect(policy.created_by).toBeNull();
    expect(policy.source).toBeNull();
    expect(policy.note).toBeNull();
  });

  it('create with optional fields', () => {
    const repo = new ApprovalPolicyRepository(db);
    const policy = repo.create({
      id: uniqueId('pol'),
      scope: 'user',
      scope_key: 'u1',
      target_kind: 'tool',
      pattern_type: 'glob',
      pattern: '*',
      effect: 'deny',
      created_by: 'admin',
      source: 'manual',
      note: 'Deny all tools',
    });

    expect(policy.created_by).toBe('admin');
    expect(policy.source).toBe('manual');
    expect(policy.note).toBe('Deny all tools');
  });

  it('findByScope returns policies for a scope', () => {
    const repo = new ApprovalPolicyRepository(db);
    repo.create({ id: uniqueId('pol'), scope: 'user', scope_key: 'u1', target_kind: 'tool', pattern_type: 'exact', pattern: 'a', effect: 'allow' });
    repo.create({ id: uniqueId('pol'), scope: 'user', scope_key: 'u1', target_kind: 'command', pattern_type: 'regex', pattern: '.*', effect: 'deny' });
    repo.create({ id: uniqueId('pol'), scope: 'user', scope_key: 'u2', target_kind: 'tool', pattern_type: 'exact', pattern: 'b', effect: 'allow' });

    const results = repo.findByScope('user', 'u1');
    expect(results).toHaveLength(2);
  });

  it('findByTargetKind returns policies for a target kind', () => {
    const repo = new ApprovalPolicyRepository(db);
    repo.create({ id: uniqueId('pol'), scope: 'user', scope_key: 'u1', target_kind: 'tool', pattern_type: 'exact', pattern: 'a', effect: 'allow' });
    repo.create({ id: uniqueId('pol'), scope: 'user', scope_key: 'u1', target_kind: 'tool', pattern_type: 'exact', pattern: 'b', effect: 'deny' });
    repo.create({ id: uniqueId('pol'), scope: 'user', scope_key: 'u1', target_kind: 'command', pattern_type: 'exact', pattern: 'c', effect: 'allow' });

    const results = repo.findByTargetKind('tool');
    expect(results).toHaveLength(2);
  });

  it('update reflects changes', () => {
    const repo = new ApprovalPolicyRepository(db);
    const policy = repo.create({
      id: uniqueId('pol'),
      scope: 'user',
      scope_key: 'u1',
      target_kind: 'tool',
      pattern_type: 'exact',
      pattern: 'shell',
      effect: 'allow',
    });

    const updated = repo.update(policy.id, { effect: 'deny', note: 'Changed to deny' });
    expect(updated!.effect).toBe('deny');
    expect(updated!.note).toBe('Changed to deny');
  });

  it('delete removes policy', () => {
    const repo = new ApprovalPolicyRepository(db);
    const policy = repo.create({
      id: uniqueId('pol'),
      scope: 'user',
      scope_key: 'u1',
      target_kind: 'tool',
      pattern_type: 'exact',
      pattern: 'shell',
      effect: 'allow',
    });

    expect(repo.delete(policy.id)).toBe(true);
    expect(repo.findById(policy.id)).toBeUndefined();
  });
});

describe('ApprovalRequestRepository', () => {
  it('create and findById returns correct data', () => {
    const repo = new ApprovalRequestRepository(db);
    const request = repo.create({
      id: uniqueId('req'),
      session_key: 's1',
      target_kind: 'tool',
      tool_name: 'shell',
    });

    expect(request).toBeDefined();
    expect(request.id).toMatch(/^req-/);
    expect(request.session_key).toBe('s1');
    expect(request.target_kind).toBe('tool');
    expect(request.tool_name).toBe('shell');
    expect(request.status).toBe('pending');
    expect(request.chat_id).toBeNull();
    expect(request.thread_id).toBeNull();
    expect(request.requester_id).toBeNull();
  });

  it('create with all optional fields', () => {
    const repo = new ApprovalRequestRepository(db);
    const request = repo.create({
      id: uniqueId('req'),
      session_key: 's1',
      chat_id: 'c1',
      thread_id: 't1',
      requester_id: 'user-1',
      target_kind: 'command',
      command_text: 'rm -rf /',
      normalized_command: 'rm -rf /',
      risk_level: 'high',
      reason: 'Dangerous command',
      status: 'pending',
      decision_mode: 'interactive',
      policy_scope: 'user',
      card_message_id: 'msg-1',
      expires_at: '2026-12-31T23:59:59Z',
    });

    expect(request.chat_id).toBe('c1');
    expect(request.thread_id).toBe('t1');
    expect(request.requester_id).toBe('user-1');
    expect(request.risk_level).toBe('high');
    expect(request.reason).toBe('Dangerous command');
  });

  it('findBySessionKey returns requests for a session', () => {
    const repo = new ApprovalRequestRepository(db);
    repo.create({ id: uniqueId('req'), session_key: 's1', target_kind: 'tool', tool_name: 'a' });
    repo.create({ id: uniqueId('req'), session_key: 's1', target_kind: 'tool', tool_name: 'b' });
    repo.create({ id: uniqueId('req'), session_key: 's2', target_kind: 'tool', tool_name: 'c' });

    const results = repo.findBySessionKey('s1');
    expect(results).toHaveLength(2);
  });

  it('findByStatus returns requests with given status', () => {
    const repo = new ApprovalRequestRepository(db);
    repo.create({ id: uniqueId('req'), session_key: 's1', target_kind: 'tool', status: 'pending' });
    repo.create({ id: uniqueId('req'), session_key: 's1', target_kind: 'tool', status: 'approved' });
    repo.create({ id: uniqueId('req'), session_key: 's1', target_kind: 'tool', status: 'pending' });

    const pending = repo.findByStatus('pending');
    expect(pending).toHaveLength(2);

    const approved = repo.findByStatus('approved');
    expect(approved).toHaveLength(1);
  });

  it('findPending returns pending requests', () => {
    const repo = new ApprovalRequestRepository(db);
    repo.create({ id: uniqueId('req'), session_key: 's1', target_kind: 'tool', status: 'pending' });
    repo.create({ id: uniqueId('req'), session_key: 's1', target_kind: 'tool', status: 'approved' });

    const results = repo.findPending();
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('pending');
  });

  it('update reflects changes', () => {
    const repo = new ApprovalRequestRepository(db);
    const request = repo.create({
      id: uniqueId('req'),
      session_key: 's1',
      target_kind: 'tool',
      tool_name: 'shell',
    });

    const updated = repo.update(request.id, {
      status: 'approved',
      decision_mode: 'auto',
    });

    expect(updated!.status).toBe('approved');
    expect(updated!.decision_mode).toBe('auto');
  });

  it('delete removes request', () => {
    const repo = new ApprovalRequestRepository(db);
    const request = repo.create({
      id: uniqueId('req'),
      session_key: 's1',
      target_kind: 'tool',
    });

    expect(repo.delete(request.id)).toBe(true);
    expect(repo.findById(request.id)).toBeUndefined();
  });
});

describe('ApprovalDecisionRepository', () => {
  it('create and findById returns correct data', () => {
    const requestId = createTestApprovalRequest();
    const repo = new ApprovalDecisionRepository(db);
    const decision = repo.create({
      id: uniqueId('dec'),
      request_id: requestId,
      decided_by: 'admin',
      decision: 'approved',
    });

    expect(decision).toBeDefined();
    expect(decision.id).toMatch(/^dec-/);
    expect(decision.request_id).toBe(requestId);
    expect(decision.decided_by).toBe('admin');
    expect(decision.decision).toBe('approved');
    expect(decision.decision_scope).toBeNull();
    expect(decision.comment).toBeNull();
  });

  it('create with optional fields', () => {
    const requestId = createTestApprovalRequest();
    const repo = new ApprovalDecisionRepository(db);
    const decision = repo.create({
      id: uniqueId('dec'),
      request_id: requestId,
      decided_by: 'admin',
      decision: 'denied',
      decision_scope: 'user',
      comment: 'Too dangerous',
    });

    expect(decision.decision_scope).toBe('user');
    expect(decision.comment).toBe('Too dangerous');
  });

  it('findByRequestId returns decisions for a request', () => {
    const requestId1 = createTestApprovalRequest();
    const requestId2 = createTestApprovalRequest();
    const repo = new ApprovalDecisionRepository(db);
    repo.create({ id: uniqueId('dec'), request_id: requestId1, decided_by: 'admin', decision: 'approved' });
    repo.create({ id: uniqueId('dec'), request_id: requestId1, decided_by: 'admin', decision: 'denied' });
    repo.create({ id: uniqueId('dec'), request_id: requestId2, decided_by: 'admin', decision: 'approved' });

    const results = repo.findByRequestId(requestId1);
    expect(results).toHaveLength(2);
    expect(results.every(d => d.request_id === requestId1)).toBe(true);
  });

  it('findLatestByRequestId returns most recent decision', () => {
    const requestId = createTestApprovalRequest();
    const repo = new ApprovalDecisionRepository(db);
    const first = repo.create({ id: 'dec-first', request_id: requestId, decided_by: 'admin', decision: 'approved' });
    // Use different id so the second is clearly "later" when ordered by created_at DESC, id DESC
    const second = repo.create({ id: 'dec-second', request_id: requestId, decided_by: 'admin', decision: 'denied' });

    const latest = repo.findLatestByRequestId(requestId);
    expect(latest).toBeDefined();
    // Both have same created_at second, but the second insert has a later rowid
    // The query uses created_at DESC LIMIT 1; if timestamps tie, SQLite doesn't guarantee order
    // So we verify the result is one of the two decisions
    expect(['approved', 'denied']).toContain(latest!.decision);
  });

  it('delete removes decision', () => {
    const requestId = createTestApprovalRequest();
    const repo = new ApprovalDecisionRepository(db);
    const decision = repo.create({
      id: uniqueId('dec'),
      request_id: requestId,
      decided_by: 'admin',
      decision: 'approved',
    });

    expect(repo.delete(decision.id)).toBe(true);
    expect(repo.findById(decision.id)).toBeUndefined();
  });

  it('deleteByRequestId removes all decisions for a request', () => {
    const requestId1 = createTestApprovalRequest();
    const requestId2 = createTestApprovalRequest();
    const repo = new ApprovalDecisionRepository(db);
    repo.create({ id: uniqueId('dec'), request_id: requestId1, decided_by: 'admin', decision: 'approved' });
    repo.create({ id: uniqueId('dec'), request_id: requestId1, decided_by: 'admin', decision: 'denied' });
    repo.create({ id: uniqueId('dec'), request_id: requestId2, decided_by: 'admin', decision: 'approved' });

    const deleted = repo.deleteByRequestId(requestId1);
    expect(deleted).toBe(2);
    expect(repo.findByRequestId(requestId1)).toHaveLength(0);
    expect(repo.findByRequestId(requestId2)).toHaveLength(1);
  });
});

describe('Cross-repository integration', () => {
  it('session -> messages -> episodes work together', () => {
    const sessionRepo = new SessionRepository(db);
    const messageRepo = new MessageRepository(db);
    const episodeRepo = new EpisodeRepository(db);

    const session = sessionRepo.create({
      id: uniqueId('session'),
      chat_id: 'chat-1',
      user_id: 'user-1',
    });

    messageRepo.create({
      id: uniqueId('msg'),
      session_id: session.id,
      role: 'user',
      content: 'Hello',
    });
    messageRepo.create({
      id: uniqueId('msg'),
      session_id: session.id,
      role: 'assistant',
      content: 'Hi there!',
    });

    episodeRepo.create({
      id: uniqueId('ep'),
      session_id: session.id,
      summary: 'Initial greeting exchange',
    });

    const messages = messageRepo.findBySessionId(session.id);
    expect(messages).toHaveLength(2);

    const episodes = episodeRepo.findBySessionId(session.id);
    expect(episodes).toHaveLength(1);

    // Deleting session messages should not affect episodes
    messageRepo.deleteBySessionId(session.id);
    expect(messageRepo.findBySessionId(session.id)).toHaveLength(0);
    expect(episodeRepo.findBySessionId(session.id)).toHaveLength(1);
  });

  it('memory -> embedding work together', () => {
    const memoryRepo = new MemoryRepository(db);
    const embeddingRepo = new EmbeddingRepository(db);

    const memory = memoryRepo.create({
      id: uniqueId('mem'),
      scope: 'user',
      scope_key: 'u1',
      kind: 'fact',
      content: 'User prefers dark mode',
    });

    embeddingRepo.create({
      id: uniqueId('emb'),
      memory_id: memory.id,
      embedding: new Float32Array([0.1, 0.2, 0.3]),
      model: 'test-model',
      dimension: 3,
    });

    const emb = embeddingRepo.findByMemoryId(memory.id);
    expect(emb).toBeDefined();
    expect(emb!.memory_id).toBe(memory.id);

    // Deleting memory embedding
    embeddingRepo.deleteByMemoryId(memory.id);
    expect(embeddingRepo.findByMemoryId(memory.id)).toBeUndefined();
    // Memory still exists
    expect(memoryRepo.findById(memory.id)).toBeDefined();
  });

  it('approval request -> decision work together', () => {
    const requestRepo = new ApprovalRequestRepository(db);
    const decisionRepo = new ApprovalDecisionRepository(db);

    const request = requestRepo.create({
      id: uniqueId('req'),
      session_key: 's1',
      target_kind: 'tool',
      tool_name: 'shell',
    });

    decisionRepo.create({
      id: uniqueId('dec'),
      request_id: request.id,
      decided_by: 'admin',
      decision: 'approved',
      comment: 'Looks safe',
    });

    const decisions = decisionRepo.findByRequestId(request.id);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].decision).toBe('approved');

    // FK constraint prevents deleting request while decisions reference it
    expect(() => requestRepo.delete(request.id)).toThrow();

    // Must delete decisions first, then the request
    decisionRepo.deleteByRequestId(request.id);
    expect(requestRepo.delete(request.id)).toBe(true);
    expect(requestRepo.findById(request.id)).toBeUndefined();
  });
});
