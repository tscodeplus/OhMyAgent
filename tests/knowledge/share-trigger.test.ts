/**
 * Share curation trigger — a link in a chat message becomes a page without
 * anyone typing `/knowledge share` (plan §6 K2-5, third entry point).
 *
 * These tests are about the wiring, not the curation: `curateMessage` already has
 * its own suite (`tests/knowledge/share.test.ts`). What is pinned down here is
 * every way an automatic trigger is worse than a command —
 *
 *   - it runs while a reply is streaming, so it must not run inside
 *     `MessageRepository.create` and must never throw into it;
 *   - a re-delivered message must not cost a second aux-LLM call;
 *   - `knowledge.enabled: false` / `curate.mode: off` must stay the off switches,
 *     with no new config key;
 *   - a message without a link must spend nothing;
 *   - a pasted list of links must not out-write one curation run.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { Logger } from 'pino';
import { KnowledgeCurator, type KnowledgeCurateConfig } from '../../src/memory/knowledge/curate.js';
import { createKnowledgeService } from '../../src/memory/knowledge/service.js';
import type { KnowledgeService } from '../../src/memory/knowledge/service-contract.js';
import type { AuxLLMCallOptions } from '../../src/memory/aux-llm-client.js';
import { ShareCurationTrigger, findSharedUrl } from '../../src/memory/knowledge/share-trigger.js';
import { MessageRepository } from '../../src/memory/repositories/message-repository.js';
import { SESSION_ID, openSeededDatabase } from './fixtures.js';

const LINK = 'https://example.com/power-query';
const SHARE_CONTENT = `Excel 清洗用 Power Query，看这个 ${LINK} 讲得挺清楚`;
const PLAIN_CONTENT = 'Excel 里我们用 Power Query 清洗数据';

interface LogRecord {
  level: 'debug' | 'info' | 'warn' | 'error';
  fields: Record<string, unknown>;
  msg: string;
}

/** A pino-shaped logger that keeps its records, so a failure can be proven logged. */
function recordingLogger(logs: LogRecord[]): Logger {
  const at =
    (level: LogRecord['level']) =>
    (fields: unknown, msg?: string): void => {
      if (typeof fields === 'string') {
        logs.push({ level, fields: {}, msg: fields });
        return;
      }
      logs.push({ level, fields: (fields ?? {}) as Record<string, unknown>, msg: msg ?? '' });
    };
  return {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
  } as unknown as Logger;
}

function pageSources(db: Database.Database, pageId: string): string[] {
  return (
    db
      .prepare(
        'SELECT source_kind, source_id FROM knowledge_sources WHERE page_id = ? ORDER BY source_kind, source_id',
      )
      .all(pageId) as Array<{ source_kind: string; source_id: string }>
  ).map((row) => `${row.source_kind}:${row.source_id}`);
}

interface Harness {
  db: Database.Database;
  service: KnowledgeService;
  messages: MessageRepository;
  trigger: ShareCurationTrigger;
  curator: KnowledgeCurator;
  logs: LogRecord[];
  llmCalls: AuxLLMCallOptions[];
  /** Queue the next aux-LLM answers, in call order. */
  script(...answers: string[]): void;
  /** Only the log lines the trigger itself wrote. */
  triggerLogs(level?: LogRecord['level']): LogRecord[];
}

function harness(
  config: {
    shadow?: boolean;
    curator?: Partial<KnowledgeCurateConfig>;
    defer?: (task: () => void) => void;
  } = {},
): Harness {
  const logs: LogRecord[] = [];
  const logger = recordingLogger(logs);
  const db = openSeededDatabase();
  const service = createKnowledgeService({ db, config: { shadow: config.shadow ?? true } });
  const responses: string[] = [];
  const llmCalls: AuxLLMCallOptions[] = [];

  const callLLM = async (options: AuxLLMCallOptions): Promise<string> => {
    llmCalls.push(options);
    const next = responses.shift();
    // An unexpected call is a test failure, not a silent empty answer.
    if (next === undefined) throw new Error('unscripted aux-LLM call');
    return next;
  };

  const curator = new KnowledgeCurator({
    db,
    knowledgeService: service,
    logger,
    config: {
      enabled: true,
      mode: 'manual',
      shadow: config.shadow ?? true,
      maxPagesPerRun: 5,
      requireSources: 2,
      minMemoryConfidence: 0.6,
      ...config.curator,
    },
    callLLM,
  });

  const messages = new MessageRepository(db);
  const trigger = new ShareCurationTrigger({
    logger,
    getCurator: () => curator,
    // Default: run the deferred task on demand instead of on a timer, so
    // `idle()` is the only wait. "Deferred" is still proven — `observe` pushes to
    // the queue and the drain yields before the first curation call.
    defer: config.defer ?? ((task) => task()),
  });
  messages.onUserMessage((message) => trigger.observeUserMessage(message));

  return {
    db,
    service,
    messages,
    trigger,
    curator,
    logs,
    llmCalls,
    script(...answers: string[]) {
      responses.push(...answers);
    },
    triggerLogs(level) {
      return logs.filter(
        (log) => log.msg.startsWith('share curation') && (!level || log.level === level),
      );
    },
  };
}

/** One grouping answer and one page answer: the shape of a single-page run. */
function onePageAnswers(messageId: string): string[] {
  return [
    JSON.stringify([{ subject: 'Power Query', memoryIds: [messageId] }]),
    JSON.stringify({
      title: 'Power Query',
      content: 'Power Query 替代了手工 VLOOKUP。',
      tags: ['excel'],
      aliases: [],
    }),
  ];
}

describe('findSharedUrl', () => {
  it('finds the link and stops at the sentence', () => {
    expect(findSharedUrl(`看这个 ${LINK} 讲得挺清楚`)).toBe(LINK);
    // CJK full stop is punctuation, not part of the URL.
    expect(findSharedUrl('参考 https://example.com/a。')).toBe('https://example.com/a');
    expect(findSharedUrl('参考（https://example.com/a）')).toBe('https://example.com/a');
  });

  it('ignores text without a scheme', () => {
    // A bare host in prose is a mention, not a share — no model call for it.
    expect(findSharedUrl('example.com/power-query')).toBeUndefined();
    expect(findSharedUrl('Excel 里我们用 Power Query 清洗数据')).toBeUndefined();
  });
});

describe('share curation trigger', () => {
  let h: Harness;

  beforeEach(() => {
    h = harness();
  });

  afterEach(() => {
    h.db.close();
  });

  it('curates a user message that carries a link, once, by message id', async () => {
    h.script(...onePageAnswers('message-share-1'));
    const curate = vi.spyOn(h.curator, 'curateMessage');

    const message = h.messages.create({
      id: 'message-share-1',
      session_id: SESSION_ID,
      role: 'user',
      content: SHARE_CONTENT,
    });

    // The caller's stack is untouched: nothing has been curated yet.
    expect(curate).not.toHaveBeenCalled();

    await h.trigger.idle();

    expect(curate).toHaveBeenCalledTimes(1);
    expect(curate).toHaveBeenCalledWith(message.id, { trigger: 'share' });

    // shadow mode: the page exists, and it waits for review.
    const pending = h.service.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ slug: 'power-query', status: 'pending' });
    // Provenance points back at the message that shared the link.
    expect(pageSources(h.db, pending[0].id)).toContain(`message:${message.id}`);
  });

  it('curates a re-delivered message only once', async () => {
    h.script(...onePageAnswers('message-share-2'));
    const curate = vi.spyOn(h.curator, 'curateMessage');

    const message = h.messages.create({
      id: 'message-share-2',
      session_id: SESSION_ID,
      role: 'user',
      content: SHARE_CONTENT,
    });
    await h.trigger.idle();

    // A retry / re-delivery of the same message id: the seen-set must answer
    // without a second aux-LLM call (the scripted answers are already spent).
    h.trigger.observeUserMessage(message);
    await h.trigger.idle();

    expect(curate).toHaveBeenCalledTimes(1);
    expect(h.service.listPending()).toHaveLength(1);
  });

  it('spends nothing on a user message without a link', async () => {
    const curate = vi.spyOn(h.curator, 'curateMessage');

    h.messages.create({
      id: 'message-plain',
      session_id: SESSION_ID,
      role: 'user',
      content: PLAIN_CONTENT,
    });
    await h.trigger.idle();

    expect(curate).not.toHaveBeenCalled();
    expect(h.llmCalls).toHaveLength(0);
    expect(h.service.listPending()).toEqual([]);
    // Not even a log line: an ordinary message is not an event.
    expect(h.triggerLogs()).toEqual([]);
  });

  it('ignores a link in an assistant message', async () => {
    const curate = vi.spyOn(h.curator, 'curateMessage');

    h.messages.create({
      id: 'message-assistant',
      session_id: SESSION_ID,
      role: 'assistant',
      content: `你可以看 ${LINK}`,
    });
    await h.trigger.idle();

    expect(curate).not.toHaveBeenCalled();
  });

  it('does nothing while knowledge.enabled is false', async () => {
    h.db.close();
    h = harness({ curator: { enabled: false } });
    const curate = vi.spyOn(h.curator, 'curateMessage');

    h.messages.create({
      id: 'message-disabled',
      session_id: SESSION_ID,
      role: 'user',
      content: SHARE_CONTENT,
    });
    await expect(h.trigger.idle()).resolves.toBeUndefined();

    expect(curate).not.toHaveBeenCalled();
    expect(h.llmCalls).toHaveLength(0);
    expect(h.service.listPending()).toEqual([]);
    expect(h.triggerLogs('debug').some((log) => log.msg.includes('curation is off'))).toBe(true);
  });

  it('does nothing while curate.mode is off', async () => {
    h.db.close();
    h = harness({ curator: { mode: 'off' } });
    const curate = vi.spyOn(h.curator, 'curateMessage');

    h.messages.create({
      id: 'message-mode-off',
      session_id: SESSION_ID,
      role: 'user',
      content: SHARE_CONTENT,
    });
    await expect(h.trigger.idle()).resolves.toBeUndefined();

    expect(curate).not.toHaveBeenCalled();
    expect(h.llmCalls).toHaveLength(0);
    expect(h.service.listPending()).toEqual([]);
  });

  it('writes at most max_pages_per_run pages for a burst of links', async () => {
    h.db.close();
    h = harness({ curator: { maxPagesPerRun: 1 } });
    const curate = vi.spyOn(h.curator, 'curateMessage');
    h.script(...onePageAnswers('message-burst-1'));

    h.messages.create({
      id: 'message-burst-1',
      session_id: SESSION_ID,
      role: 'user',
      content: SHARE_CONTENT,
    });
    h.messages.create({
      id: 'message-burst-2',
      session_id: SESSION_ID,
      role: 'user',
      content: SHARE_CONTENT,
    });
    await h.trigger.idle();

    // The second link is a page the burst budget refuses, not a second page.
    expect(curate).toHaveBeenCalledTimes(1);
    expect(h.service.listPending()).toHaveLength(1);
    expect(h.triggerLogs('debug').some((log) => log.msg.includes('burst budget spent'))).toBe(true);
  });

  it('logs a failed curation instead of throwing it at the message write', async () => {
    // No scripted answer: the aux-LLM call rejects, so `curateMessage` rejects.
    const curate = vi.spyOn(h.curator, 'curateMessage');

    expect(() =>
      h.messages.create({
        id: 'message-failing',
        session_id: SESSION_ID,
        role: 'user',
        content: SHARE_CONTENT,
      }),
    ).not.toThrow();
    await expect(h.trigger.idle()).resolves.toBeUndefined();

    expect(curate).toHaveBeenCalledTimes(1);
    const warns = h.triggerLogs('warn');
    expect(warns).toHaveLength(1);
    expect(warns[0].msg).toContain('curation failed');
    expect(warns[0].fields.messageId).toBe('message-failing');
    expect(h.service.listPending()).toEqual([]);
  });

  it('returns the stored message unchanged, whatever the trigger does', async () => {
    h.script(...onePageAnswers('message-row'));

    const withTrigger = h.messages.create({
      id: 'message-row',
      session_id: SESSION_ID,
      role: 'user',
      content: SHARE_CONTENT,
    });
    // A repository with no listener at all: the same write, the same row. The
    // trigger may not alter the reply path's result, including its created_at.
    const bare = new MessageRepository(h.db).create({
      id: 'message-row-bare',
      session_id: SESSION_ID,
      role: 'user',
      content: SHARE_CONTENT,
      created_at: Number(withTrigger.created_at),
    });

    expect(Object.keys(withTrigger).sort()).toEqual(Object.keys(bare).sort());
    expect(withTrigger).toMatchObject({
      id: 'message-row',
      session_id: SESSION_ID,
      role: 'user',
      content: SHARE_CONTENT,
      tool_call_id: null,
      metadata: null,
    });
    expect(withTrigger.created_at).toBe(bare.created_at);
  });

  it('a listener that throws cannot fail the message write', () => {
    const repository = new MessageRepository(h.db);
    repository.onUserMessage(() => {
      throw new Error('listener exploded');
    });

    const stored = repository.create({
      id: 'message-listener-throws',
      session_id: SESSION_ID,
      role: 'user',
      content: SHARE_CONTENT,
    });

    expect(stored.id).toBe('message-listener-throws');
  });
});
