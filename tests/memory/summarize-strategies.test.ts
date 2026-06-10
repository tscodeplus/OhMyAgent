/**
 * Verify the two summarization strategies work correctly:
 *
 * Strategy 1: Batch trigger — summarize every N messages
 *   - 10 messages, 0 episodes → trigger (10/10 > 0)
 *   - 15 messages, 1 episode → skip   (15/10 = 1 = 1)
 *   - 20 messages, 1 episode → trigger (20/10 > 1)
 *
 * Strategy 2: LLM-driven summarize-session tool
 *   - LLM calls tool when conversation reaches a natural break
 *   - Tool checks message count and triggers summarizer
 */
import { i18n } from '../../src/i18n/index.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SessionRepository } from '../../src/memory/repositories/session-repository.js';
import { MessageRepository } from '../../src/memory/repositories/message-repository.js';
import { EpisodeRepository } from '../../src/memory/repositories/episode-repository.js';
import { MemoryRepository } from '../../src/memory/repositories/memory-repository.js';
import { createSessionSummarizeTool } from '../../src/tools/builtins/session-summarize-tool.js';
import { MemorySummarizer, parseSummaryLLMResponse, resolveSummaryModelConnection } from '../../src/memory/memory-summarizer.js';

// ---- Helpers ----

function createTestDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, chat_id TEXT, thread_id TEXT, user_id TEXT, created_at TEXT DEFAULT (cast(strftime('%s','now') as integer) * 1000), updated_at TEXT DEFAULT (cast(strftime('%s','now') as integer) * 1000), metadata TEXT);
    CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, tool_call_id TEXT, created_at TEXT DEFAULT (cast(strftime('%s','now') as integer) * 1000), metadata TEXT);
    CREATE TABLE IF NOT EXISTS episodes (id TEXT PRIMARY KEY, session_id TEXT, summary TEXT, key_points TEXT, created_at TEXT DEFAULT (cast(strftime('%s','now') as integer) * 1000));
    CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, scope TEXT, scope_key TEXT, kind TEXT, content TEXT, metadata TEXT, agent_id TEXT, visibility TEXT DEFAULT 'shared', created_at TEXT DEFAULT (cast(strftime('%s','now') as integer) * 1000), updated_at TEXT DEFAULT (cast(strftime('%s','now') as integer) * 1000));
  `);
  return db;
}

function insertMessages(msgRepo: MessageRepository, sessionId: string, count: number) {
  for (let i = 0; i < count; i++) {
    const role = i % 2 === 0 ? 'user' : 'assistant';
    msgRepo.create({
      id: `msg-${sessionId}-${i}`,
      session_id: sessionId,
      role,
      content: `${role} message ${i + 1}`,
    });
  }
}

// ---- Tests ----

describe('Strategy 1: Batch-triggered summarization (maybeSummarize logic)', () => {
  /** Replicate the maybeSummarize threshold logic. */
  function shouldTrigger(totalMessages: number, existingEpisodes: number, interval = 10): boolean {
    const expectedSummaries = Math.floor(totalMessages / interval);
    return expectedSummaries > existingEpisodes;
  }

  it('triggers when messages cross the interval boundary', () => {
    expect(shouldTrigger(10, 0)).toBe(true);   // 10/10 = 1 > 0 → trigger
    expect(shouldTrigger(20, 1)).toBe(true);   // 20/10 = 2 > 1 → trigger
    expect(shouldTrigger(30, 2)).toBe(true);   // 30/10 = 3 > 2 → trigger
  });

  it('skips when already summarized for this interval', () => {
    expect(shouldTrigger(15, 1)).toBe(false);  // 15/10 = 1 = 1 → skip
    expect(shouldTrigger(25, 2)).toBe(false);  // 25/10 = 2 = 2 → skip
    expect(shouldTrigger(9, 0)).toBe(false);   // 9/10 = 0 = 0 → skip
  });

  it('respects custom interval', () => {
    // Interval = 20
    expect(shouldTrigger(20, 0, 20)).toBe(true);   // 20/20 = 1 > 0
    expect(shouldTrigger(25, 1, 20)).toBe(false);  // 25/20 = 1 = 1
    expect(shouldTrigger(40, 1, 20)).toBe(true);   // 40/20 = 2 > 1
    expect(shouldTrigger(15, 0, 20)).toBe(false);  // 15/20 = 0 = 0
  });

  it('handles edge cases', () => {
    expect(shouldTrigger(0, 0)).toBe(false);
    expect(shouldTrigger(10, 2)).toBe(false);   // 10/10 = 1 < 2
    expect(shouldTrigger(10, 1)).toBe(false);   // 10/10 = 1 = 1
    expect(shouldTrigger(100, 0)).toBe(true);   // far behind
    expect(shouldTrigger(100, 10)).toBe(false); // caught up
  });
});

describe('parseSummaryLLMResponse', () => {
  it('parses strict JSON summary output', () => {
    const parsed = parseSummaryLLMResponse(JSON.stringify({
      summary: 'User discussed editor setup.',
      preferences: ['User prefers pnpm'],
    }));

    expect(parsed.usedFallback).toBe(false);
    expect(parsed.summary).toBe('User discussed editor setup.');
    expect(parsed.preferences).toEqual(['User prefers pnpm']);
  });

  it('parses JSON inside markdown code fences', () => {
    const parsed = parseSummaryLLMResponse('```json\n{"summary":"Done","preferences":["User likes concise replies"]}\n```');

    expect(parsed.usedFallback).toBe(false);
    expect(parsed.preferences).toEqual(['User likes concise replies']);
  });

  it('falls back to legacy SUMMARY/PREF format', () => {
    const parsed = parseSummaryLLMResponse('SUMMARY: Talked about memory.\nPREF: User prefers Chinese.');

    expect(parsed.usedFallback).toBe(true);
    expect(parsed.summary).toBe('Talked about memory.');
    expect(parsed.preferences).toEqual(['User prefers Chinese.']);
  });
});

describe('Strategy 2: LLM-driven summarize-session tool', () => {
  let db: Database.Database;
  let sessionRepo: SessionRepository;
  let messageRepo: MessageRepository;
  let episodeRepo: EpisodeRepository;
  let memoryRepo: MemoryRepository;

  beforeEach(() => {
    db = createTestDb();
    sessionRepo = new SessionRepository(db);
    messageRepo = new MessageRepository(db);
    episodeRepo = new EpisodeRepository(db);
    memoryRepo = new MemoryRepository(db);
  });

  it('summarizes session when enough messages exist', async () => {
    const sessionId = 'test-session-1';
    sessionRepo.create({ id: sessionId, chat_id: sessionId, user_id: 'u1' });

    // Insert 25 messages (enough for 1 summary at interval=20)
    insertMessages(messageRepo, sessionId, 25);

    const mockLogger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn() } as any;
    const mockMemoryWriter = {
      write: vi.fn().mockResolvedValue({ id: 'mem-1', isDuplicate: false }),
    } as any;
    const summarizer = new MemorySummarizer(messageRepo, episodeRepo, memoryRepo, mockMemoryWriter, mockLogger);

    const tool = createSessionSummarizeTool({
      memorySummarizer: summarizer,
      sessionRepository: sessionRepo,
      messageRepository: messageRepo,
      episodeRepository: episodeRepo,
    });

    // Before: 0 episodes
    expect(episodeRepo.findBySessionId(sessionId)).toHaveLength(0);

    const result = await tool.execute('call-1', { reason: 'topic concluded' });

    // After: 1 episode created (25/20 = 1 > 0)
    const episodes = episodeRepo.findBySessionId(sessionId);
    expect(episodes).toHaveLength(1);
    expect(episodes[0].summary).toContain('25 messages');

    // Memory should be created via memoryWriter
    expect(mockMemoryWriter.write).toHaveBeenCalled();

    // Result text should mention success
    const text = Array.isArray(result.content) ? result.content[0].text : result.content;
    expect(text).toContain(i18n.t('tools-session:summaryCreated', { id: 'test-session', index: 1, messageCount: 25, reason: 'topic concluded' }));
  });

  it('skips session when messages below threshold', async () => {
    const sessionId = 'test-session-2';
    sessionRepo.create({ id: sessionId, chat_id: sessionId, user_id: 'u1' });

    // Insert only 3 messages (below min threshold of 5)
    insertMessages(messageRepo, sessionId, 3);

    const mockLogger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn() } as any;
    const mockMemoryWriter = { write: vi.fn() } as any;
    const summarizer = new MemorySummarizer(messageRepo, episodeRepo, memoryRepo, mockMemoryWriter, mockLogger);

    const tool = createSessionSummarizeTool({
      memorySummarizer: summarizer,
      sessionRepository: sessionRepo,
      messageRepository: messageRepo,
      episodeRepository: episodeRepo,
    });

    const result = await tool.execute('call-1', {});
    const text = Array.isArray(result.content) ? result.content[0].text : result.content;
    expect(text).toContain(i18n.t('tools-session:tooFewMessages', { id: 'test-session', count: 3 }));

    // No episodes created
    expect(episodeRepo.findBySessionId(sessionId)).toHaveLength(0);
  });

  it('skips when already up-to-date on summaries', async () => {
    const sessionId = 'test-session-3';
    sessionRepo.create({ id: sessionId, chat_id: sessionId, user_id: 'u1' });

    // Insert 10 messages
    insertMessages(messageRepo, sessionId, 10);

    // Already has 1 episode (10/20 = 0 < 1, so no new summary needed)
    episodeRepo.create({ id: 'ep-1', session_id: sessionId, summary: 'old summary', key_points: '[]' });

    const mockLogger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn() } as any;
    const mockMemoryWriter = { write: vi.fn() } as any;
    const summarizer = new MemorySummarizer(messageRepo, episodeRepo, memoryRepo, mockMemoryWriter, mockLogger);

    const tool = createSessionSummarizeTool({
      memorySummarizer: summarizer,
      sessionRepository: sessionRepo,
      messageRepository: messageRepo,
      episodeRepository: episodeRepo,
    });

    const result = await tool.execute('call-1', {});
    const text = Array.isArray(result.content) ? result.content[0].text : result.content;
    expect(text).toContain(i18n.t('tools-session:thresholdNotReached', { id: 'test-session', summaryCount: 1, messageCount: 10 }));

    // Still only 1 episode
    expect(episodeRepo.findBySessionId(sessionId)).toHaveLength(1);
  });

  it('ignores toolResult messages during summarization', async () => {
    const sessionId = 'test-session-4';
    sessionRepo.create({ id: sessionId, chat_id: sessionId, user_id: 'u1' });

    messageRepo.create({ id: 'msg-1', session_id: sessionId, role: 'user', content: '我喜欢乒乓球' });
    messageRepo.create({ id: 'msg-2', session_id: sessionId, role: 'toolResult', content: 'ls output should be ignored' });
    messageRepo.create({ id: 'msg-3', session_id: sessionId, role: 'assistant', content: '你喜欢乒乓球。' });

    const mockLogger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn() } as any;
    const mockMemoryWriter = {
      write: vi.fn().mockResolvedValue({ id: 'mem-1', isDuplicate: false }),
    } as any;
    const summarizer = new MemorySummarizer(messageRepo, episodeRepo, memoryRepo, mockMemoryWriter, mockLogger);

    await summarizer.summarizeSession(sessionId, { maxMessages: 10 });

    const episodes = episodeRepo.findBySessionId(sessionId);
    expect(episodes).toHaveLength(1);
    expect(episodes[0].summary).toContain('2 messages');
    expect(episodes[0].summary).not.toContain('ls output should be ignored');
  });

  it('uses MEMORY_OUTPUT_LANGUAGE when building LLM summary prompts', async () => {
    const sessionId = 'test-session-5';
    sessionRepo.create({ id: sessionId, chat_id: sessionId, user_id: 'u1' });

    messageRepo.create({ id: 'msg-1', session_id: sessionId, role: 'user', content: 'I like dragon fruit soda' });
    messageRepo.create({ id: 'msg-2', session_id: sessionId, role: 'assistant', content: 'Noted.' });

    const mockLogger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn() } as any;
    const mockMemoryWriter = {
      writeSummary: vi.fn().mockResolvedValue({ id: 'mem-summary', isDuplicate: false }),
      writePreference: vi.fn().mockResolvedValue({ id: 'mem-pref', isDuplicate: false }),
    } as any;
    const summarizer = new MemorySummarizer(
      messageRepo,
      episodeRepo,
      memoryRepo,
      mockMemoryWriter,
      mockLogger,
      { modelRef: 'test/model', outputLanguage: 'Spanish' },
    ) as any;

    let capturedPrompt = '';
    summarizer.callLLM = vi.fn(async (prompt: string) => {
      capturedPrompt = prompt;
      return 'SUMMARY: Resumen corto\nPREF: Al usuario le gusta la soda de fruta del dragón';
    });

    await summarizer.summarizeSession(sessionId, { maxMessages: 10 });

    expect(capturedPrompt).toContain('Write the summary and extracted preferences in Spanish.');
    expect(mockMemoryWriter.writeSummary).toHaveBeenCalledWith(sessionId, 'Resumen corto', undefined, null);
    expect(mockMemoryWriter.writePreference).toHaveBeenCalledWith(
      sessionId,
      'Al usuario le gusta la soda de fruta del dragón',
      undefined,
      null,
    );
  });

  it('does not auto-capture name preferences inferred only from assistant replies', async () => {
    const sessionId = 'test-session-6';
    sessionRepo.create({ id: sessionId, chat_id: sessionId, user_id: 'u1' });

    messageRepo.create({ id: 'msg-1', session_id: sessionId, role: 'user', content: '哈喽' });
    messageRepo.create({ id: 'msg-2', session_id: sessionId, role: 'assistant', content: '哈喽，大Boss！' });

    const mockLogger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn() } as any;
    const mockMemoryWriter = {
      writeSummary: vi.fn().mockResolvedValue({ id: 'mem-summary', isDuplicate: false }),
      writePreference: vi.fn().mockResolvedValue({ id: 'mem-pref', isDuplicate: false }),
    } as any;
    const summarizer = new MemorySummarizer(
      messageRepo,
      episodeRepo,
      memoryRepo,
      mockMemoryWriter,
      mockLogger,
      { modelRef: 'test/model' },
    ) as any;

    summarizer.callLLM = vi.fn(async () => [
      'SUMMARY: 用户打招呼，助手回复问候。',
      'PREF: 用户偏好被称呼为“大Boss”',
    ].join('\n'));

    await summarizer.summarizeSession(sessionId, { maxMessages: 10 });

    expect(mockMemoryWriter.writeSummary).toHaveBeenCalled();
    expect(mockMemoryWriter.writePreference).not.toHaveBeenCalled();
    const episodes = episodeRepo.findBySessionId(sessionId);
    expect(episodes[0].key_points).toBe('[]');
  });

  it('auto-captures name preferences explicitly stated by the user', async () => {
    const sessionId = 'test-session-7';
    sessionRepo.create({ id: sessionId, chat_id: sessionId, user_id: 'u1' });

    messageRepo.create({ id: 'msg-1', session_id: sessionId, role: 'user', content: '以后称呼我为老板' });
    messageRepo.create({ id: 'msg-2', session_id: sessionId, role: 'assistant', content: '好的，老板。' });

    const mockLogger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn() } as any;
    const mockMemoryWriter = {
      writeSummary: vi.fn().mockResolvedValue({ id: 'mem-summary', isDuplicate: false }),
      writePreference: vi.fn().mockResolvedValue({ id: 'mem-pref', isDuplicate: false }),
    } as any;
    const summarizer = new MemorySummarizer(
      messageRepo,
      episodeRepo,
      memoryRepo,
      mockMemoryWriter,
      mockLogger,
      { modelRef: 'test/model' },
    ) as any;

    summarizer.callLLM = vi.fn(async () => [
      'SUMMARY: 用户更新称呼偏好。',
      'PREF: 用户希望被称呼为"老板"',
    ].join('\n'));

    await summarizer.summarizeSession(sessionId, { maxMessages: 10 });

    expect(mockMemoryWriter.writePreference).toHaveBeenCalledWith(
      sessionId,
      '用户希望被称呼为"老板"',
      undefined,
      null,
    );
  });

  it('resolves summary API key and base URL from provider maps', async () => {
    const resolved = await resolveSummaryModelConnection({
      modelRef: 'nvidia/minimaxai/minimax-m2.7',
      apiKeys: { nvidia: 'provider-key' },
      baseUrls: { nvidia: 'https://integrate.api.nvidia.com/v1' },
    }, 'nvidia/minimaxai/minimax-m2.7');

    expect(resolved).toEqual({
      provider: 'nvidia',
      modelId: 'minimaxai/minimax-m2.7',
      apiKey: 'provider-key',
      baseUrl: 'https://integrate.api.nvidia.com/v1',
    });
  });
});
