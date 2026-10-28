/**
 * `conversation-search.ts` — raw message retrieval over `messages_fts_jieba`.
 *
 * The three contract points that decide whether this is usable as a retrieval
 * leg, all covered below:
 *   - `limit` is the TOTAL cap: neighbourhood expansion eats into it, so a
 *     `limit: 8` search can never inject 24 entries;
 *   - an `unknown` channel must stay searchable under the default policy;
 *   - every hit carries provenance (`memory_ids`, `knowledge_slugs`) even when
 *     there is none, so a consumer never has to test for the field's presence.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/memory/db';
import { MessageRepository } from '../../src/memory/repositories/message-repository';
import {
  CONVERSATION_SNIPPET_MAX_CHARS,
  searchMessages,
} from '../../src/memory/conversation-search';

let db: Database.Database;
let messages: MessageRepository;

beforeEach(() => {
  db = openDatabase(':memory:');
  messages = new MessageRepository(db);
});

afterEach(() => {
  db.close();
});

function seedSession(input: {
  id: string;
  channel?: string | null;
  projectId?: string | null;
  title?: string | null;
  metadata?: string | null;
}): void {
  db.prepare(
    `INSERT INTO sessions (id, chat_id, user_id, project_id, channel, external_chat_id, title, metadata, created_at, updated_at)
     VALUES (?, ?, 'user-1', ?, ?, NULL, ?, ?, '1700000000000', '1700000000000')`,
  ).run(
    input.id,
    input.id,
    input.projectId ?? null,
    input.channel ?? null,
    input.title ?? null,
    input.metadata ?? null,
  );
}

/**
 * One message, indexed the way production indexes one: through
 * `MessageRepository.create`, so the FTS row is written by the same code path
 * as a live message rather than by a test-only insert.
 */
function seedMessage(input: {
  id: string;
  sessionId: string;
  content: string;
  role?: string;
  createdAt: number;
}): void {
  messages.create({
    id: input.id,
    session_id: input.sessionId,
    role: input.role ?? 'user',
    content: input.content,
    created_at: input.createdAt,
  });
}

/** A session with `count` messages, only `matchId` containing the term. */
function seedConversation(input: {
  sessionId: string;
  start: number;
  count: number;
  matchIndex: number;
  term?: string;
  channel?: string | null;
  projectId?: string | null;
  title?: string | null;
}): void {
  const term = input.term ?? 'excel';
  for (let index = 0; index < input.count; index++) {
    seedMessage({
      id: `${input.sessionId}-m${index}`,
      sessionId: input.sessionId,
      content:
        index === input.matchIndex
          ? `the ${term} batch replace script we discussed`
          : `filler message number ${index} with no keyword`,
      createdAt: input.start + index * 1000,
    });
  }
}

describe('searchMessages: neighbourhood inside the total cap', () => {
  beforeEach(() => {
    seedSession({ id: 's-main', channel: 'feishu', title: 'Batch replace plan' });
    seedConversation({ sessionId: 's-main', start: 1_700_000_000_000, count: 7, matchIndex: 3 });
  });

  it('returns the hit plus exactly one neighbour on each side when limit allows', () => {
    const hits = searchMessages({ db, query: 'excel', limit: 3 });

    expect(hits.map((hit) => hit.message_id)).toEqual(['s-main-m2', 's-main-m3', 's-main-m4']);
    expect(hits.map((hit) => hit.expanded)).toEqual([true, false, true]);
    // Only the keyword match has a score; context rows are not ranked.
    expect(hits[1].score).toBeGreaterThan(0);
    expect(hits[0].score).toBe(0);
    expect(hits[2].score).toBe(0);
  });

  it('never exceeds limit and truncates the neighbourhood, not the hit', () => {
    for (const limit of [1, 2, 3]) {
      const hits = searchMessages({ db, query: 'excel', limit });
      expect(hits, `limit=${limit}`).toHaveLength(limit);
      // The hit itself is always kept; the +1 neighbour is what gets cut.
      expect(hits.map((hit) => hit.message_id)).toContain('s-main-m3');
    }

    expect(searchMessages({ db, query: 'excel', limit: 1 }).map((hit) => hit.expanded)).toEqual([
      false,
    ]);
  });

  it('does not multiply the cap across several hits', () => {
    seedSession({ id: 's-other', channel: 'webui', title: 'Second conversation' });
    seedConversation({ sessionId: 's-other', start: 1_700_000_100_000, count: 5, matchIndex: 2 });

    const hits = searchMessages({ db, query: 'excel', limit: 4 });

    // Two hits × (1 hit + 2 neighbours) would be 6 without the cap.
    expect(hits).toHaveLength(4);
    expect(hits.filter((hit) => !hit.expanded)).toHaveLength(2);
  });

  it('returns the entries oldest-first, not in BM25 order', () => {
    const hits = searchMessages({ db, query: 'excel', limit: 3 });
    const timestamps = hits.map((hit) => hit.created_at);

    expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b));
    expect(timestamps).toEqual([1_700_000_002_000, 1_700_000_003_000, 1_700_000_004_000]);
  });
});

describe('searchMessages: snippet', () => {
  it('stays within the snippet budget and keeps the match in view', () => {
    seedSession({ id: 's-long', channel: 'webui' });
    const padding = 'this sentence exists only to push the match far from the head. ';
    seedMessage({
      id: 'long-1',
      sessionId: 's-long',
      content: `${padding.repeat(5)}the excel replacement script lives in scripts/.`,
      createdAt: 1_700_000_000_000,
    });

    const [hit] = searchMessages({ db, query: 'excel' });

    // 120 characters plus the ellipsis on each side when both are cut.
    expect(hit.snippet.length).toBeLessThanOrEqual(CONVERSATION_SNIPPET_MAX_CHARS + 2);
    expect(hit.snippet.toLowerCase()).toContain('excel');
    expect(hit.snippet.startsWith('…')).toBe(true);
  });

  it('collapses whitespace and newlines so a snippet is one line', () => {
    seedSession({ id: 's-multiline', channel: 'webui' });
    seedMessage({
      id: 'multi-1',
      sessionId: 's-multiline',
      content: '\n\n\n## Excel\n\n|项目|详情|\n|\n\n',
      createdAt: 1_700_000_000_000,
    });

    const [hit] = searchMessages({ db, query: 'excel' });

    expect(hit.snippet).not.toMatch(/[\n\r]/);
    expect(hit.snippet).not.toMatch(/\s{2,}/);
    expect(hit.snippet).toContain('Excel');
  });

  it('reports the session title and channel with every hit', () => {
    seedSession({ id: 's-title', channel: 'qq', title: 'MCP excel 写入验证' });
    seedMessage({
      id: 'title-1',
      sessionId: 's-title',
      content: 'excel write check',
      createdAt: 1_700_000_000_000,
    });

    const [hit] = searchMessages({ db, query: 'excel' });

    expect(hit.session_title).toBe('MCP excel 写入验证');
    expect(hit.channel).toBe('qq');
  });
});

describe('searchMessages: channel handling', () => {
  it('keeps the unknown channel searchable under the default policy', () => {
    // The exact shape of the live seed session: a NULL channel column whose id
    // inferChannel classifies as `unknown`.
    seedSession({ id: 'shadow-seed-1007', channel: null, title: '查看项目根目录文件' });
    seedMessage({
      id: 'seed-1',
      sessionId: 'shadow-seed-1007',
      content: 'excel directory listing please',
      createdAt: 1_700_000_000_000,
    });

    const [hit] = searchMessages({ db, query: 'excel' });

    expect(hit.channel).toBe('unknown');
    expect(hit.session_title).toBe('查看项目根目录文件');
  });

  it('filters to one channel only when the caller asks for it', () => {
    seedSession({ id: 'oc_feishu', channel: 'feishu' });
    seedMessage({
      id: 'feishu-1',
      sessionId: 'oc_feishu',
      content: 'excel via feishu',
      createdAt: 1_700_000_000_000,
    });
    seedSession({ id: 'shadow-seed-1007', channel: 'unknown' });
    seedMessage({
      id: 'seed-1',
      sessionId: 'shadow-seed-1007',
      content: 'excel via the seed session',
      createdAt: 1_700_000_100_000,
    });

    expect(searchMessages({ db, query: 'excel' })).toHaveLength(2);
    expect(
      searchMessages({ db, query: 'excel', channel: 'feishu' }).map((h) => h.message_id),
    ).toEqual(['feishu-1']);
  });
});

describe('searchMessages: policy and time filters', () => {
  beforeEach(() => {
    seedSession({ id: 's-proj-a', channel: 'webui', projectId: 'proj-a' });
    seedMessage({
      id: 'a-1',
      sessionId: 's-proj-a',
      content: 'excel in project a',
      createdAt: 1_700_000_000_000,
    });
    seedSession({ id: 's-proj-b', channel: 'webui', projectId: 'proj-b' });
    seedMessage({
      id: 'b-1',
      sessionId: 's-proj-b',
      content: 'excel in project b',
      createdAt: 1_700_000_100_000,
    });
    seedSession({ id: 'oc_im', channel: 'feishu' });
    seedMessage({
      id: 'im-1',
      sessionId: 'oc_im',
      content: 'excel via the inbox',
      createdAt: 1_700_000_200_000,
    });
  });

  it('narrows to one project without hiding the inbox', () => {
    const ids = searchMessages({ db, query: 'excel', policy: { projectId: 'proj-a' } }).map(
      (hit) => hit.message_id,
    );

    expect(ids).toContain('a-1');
    expect(ids).toContain('im-1');
    expect(ids).not.toContain('b-1');
  });

  it('hides project-less sessions when the inbox is excluded', () => {
    const ids = searchMessages({ db, query: 'excel', policy: { includeInbox: false } }).map(
      (hit) => hit.message_id,
    );

    expect(ids).toEqual(['a-1', 'b-1']);
  });

  it('applies since / until as an inclusive window on the hit', () => {
    const sinceOnly = searchMessages({
      db,
      query: 'excel',
      since: 1_700_000_100_000,
    }).map((hit) => hit.message_id);
    expect(sinceOnly).not.toContain('a-1');

    const window = searchMessages({
      db,
      query: 'excel',
      since: 1_700_000_050_000,
      until: 1_700_000_150_000,
    }).map((hit) => hit.message_id);
    expect(window).toEqual(['b-1']);
  });

  it('accepts an ISO date for since / until', () => {
    const since = new Date(1_700_000_050_000).toISOString();
    const ids = searchMessages({ db, query: 'excel', since }).map((hit) => hit.message_id);

    expect(ids).not.toContain('a-1');
    expect(ids).toEqual(expect.arrayContaining(['b-1', 'im-1']));
  });

  it('restricts to one session when asked', () => {
    const ids = searchMessages({ db, query: 'excel', sessionId: 's-proj-b' }).map(
      (hit) => hit.message_id,
    );

    expect(ids).toEqual(['b-1']);
  });
});

describe('searchMessages: provenance', () => {
  beforeEach(() => {
    seedSession({ id: 's-prov', channel: 'feishu', title: 'Provenance' });
    seedMessage({
      id: 'prov-1',
      sessionId: 's-prov',
      content: 'excel batch replace script',
      createdAt: 1_700_000_000_000,
    });
  });

  it('returns empty provenance arrays when nothing was recorded', () => {
    const [hit] = searchMessages({ db, query: 'excel' });

    expect(hit.memory_ids).toEqual([]);
    expect(hit.knowledge_slugs).toEqual([]);
  });

  it('attaches every memory that cites the message', () => {
    db.prepare(
      `INSERT INTO memories (id, scope, scope_key, kind, content, created_at, updated_at)
       VALUES ('mem-1', 'user', 's-prov', 'fact', 'excel script exists', '1000', '1000'),
              ('mem-2', 'session', 's-prov', 'summary', 'talked about excel', '1000', '1000')`,
    ).run();
    for (const memoryId of ['mem-2', 'mem-1']) {
      db.prepare(
        `INSERT INTO memory_sources (memory_id, message_id, session_id, role, source, created_at)
         VALUES (?, 'prov-1', 's-prov', 'user', 'backfill', ?)`,
      ).run(memoryId, Date.now());
    }

    const [hit] = searchMessages({ db, query: 'excel' });

    expect(hit.memory_ids).toEqual(['mem-1', 'mem-2']);
  });

  it('attaches active knowledge slugs and drops non-active pages', () => {
    db.prepare(
      `INSERT INTO knowledge_pages (id, page_type, slug, title, content, status, created_at, updated_at)
       VALUES ('page-1', 'topic', 'excel-scripts', 'Excel scripts', 'body', 'active', 1, 1),
              ('page-2', 'topic', 'excel-draft', 'Excel draft', 'body', 'pending', 1, 1)`,
    ).run();
    for (const [pageId, sourceId] of [
      ['page-1', 'prov-1'],
      ['page-2', 'prov-1'],
    ]) {
      db.prepare(
        `INSERT INTO knowledge_sources (page_id, source_kind, source_id, created_at)
         VALUES (?, 'message', ?, 1)`,
      ).run(pageId, sourceId);
    }

    const [hit] = searchMessages({ db, query: 'excel' });

    expect(hit.knowledge_slugs).toEqual(['excel-scripts']);
  });
});

describe('searchMessages: degenerate input', () => {
  it('returns [] for an empty or unsearchable query', () => {
    seedSession({ id: 's-empty', channel: 'webui' });

    expect(searchMessages({ db, query: '' })).toEqual([]);
    expect(searchMessages({ db, query: '   ' })).toEqual([]);
    expect(searchMessages({ db, query: '!!!' })).toEqual([]);
  });

  it('returns [] when nothing matches', () => {
    seedSession({ id: 's-nothing', channel: 'webui' });
    seedMessage({
      id: 'nothing-1',
      sessionId: 's-nothing',
      content: 'unrelated words only',
      createdAt: 1_700_000_000_000,
    });

    expect(searchMessages({ db, query: 'excel' })).toEqual([]);
  });

  it('returns [] instead of throwing when the FTS table is gone', () => {
    db.exec('DROP TABLE messages_fts_jieba');

    expect(searchMessages({ db, query: 'excel' })).toEqual([]);
  });
});
