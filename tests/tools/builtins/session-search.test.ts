/**
 * `session_search` — the tool the model actually calls (K5, "one fusion point,
 * three callers").
 *
 * The tool used to rank messages itself (`conversation-search.ts` directly),
 * so the agent and the WebUI ranked the same corpus with two code paths. It now
 * asks `unifiedSearch()` for the message lane plus the knowledge lane. These
 * tests pin the three properties that change is allowed to touch:
 *
 *   - the lane set: message + knowledge run, the memory lane does not;
 *   - the hard cap: `limit` is the TOTAL entries returned, fused knowledge hits
 *     and neighbourhood rows included, and pages may only spend a supplement's
 *     worth of it (`KNOWLEDGE_SUPPLEMENT_LIMIT`);
 *   - the off path: with no knowledge service the output is exactly the
 *     message-only result `conversation-search.ts` returns, rendered the way
 *     this tool has always rendered it.
 *
 * Everything runs against the real database (`openDatabase(':memory:')`, the
 * real migration chain) and the real `KnowledgeService`, because the cap is a
 * property of the fusion of real lanes, not of a stub's arithmetic.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../../src/memory/db.js';
import { MessageRepository } from '../../../src/memory/repositories/message-repository.js';
import { createKnowledgeService } from '../../../src/memory/knowledge/service.js';
import type { KnowledgeService } from '../../../src/memory/knowledge/service-contract.js';
import { searchMessages } from '../../../src/memory/conversation-search.js';
import type { ConversationSearchHit } from '../../../src/memory/conversation-search.js';
import { runSessionSearch } from '../../../src/tools/builtins/session/session-search-tool.js';
import type {
  SessionSearchArgs,
  SessionSearchToolOptions,
} from '../../../src/tools/builtins/session/session-search-tool.js';
import type { ToolExecutionResult } from '../../../src/tools/platform/tool-result.js';
import type { UnifiedKnowledgeHit, UnifiedMessageHit } from '../../../src/memory/unified-search.js';

const SESSION_ID = 's-session-search';
/** Three of these match "excel"; the rest exist to be neighbours and noise. */
const EXCHANGE: Array<{ id: string; role: 'user' | 'assistant'; content: string }> = [
  { id: 'm-1', role: 'user', content: '开场寒暄，雨下得很大' },
  {
    id: 'm-2',
    role: 'user',
    content: 'the excel batch replace script lives in scripts/replace.py',
  },
  { id: 'm-3', role: 'assistant', content: 'found it, that is the one from last week' },
  { id: 'm-4', role: 'user', content: '天气不错，适合出门散步' },
  { id: 'm-5', role: 'user', content: 'excel 那边还是用 Power Query 清洗比较稳' },
  { id: 'm-6', role: 'assistant', content: 'agree, python is only for the join step' },
  { id: 'm-7', role: 'user', content: 'remember to back up the excel files first' },
  { id: 'm-8', role: 'assistant', content: 'backed up to the usual folder' },
];

let db: Database.Database;
let knowledge: KnowledgeService;

beforeEach(() => {
  db = openDatabase(':memory:');

  db.prepare(
    `INSERT INTO sessions (id, chat_id, user_id, project_id, channel, title, created_at, updated_at)
     VALUES (?, ?, 'user-1', NULL, 'feishu', '目录检查', '1700000000000', '1700000000000')`,
  ).run(SESSION_ID, SESSION_ID);

  const messages = new MessageRepository(db);
  EXCHANGE.forEach((message, index) => {
    messages.create({
      id: message.id,
      session_id: SESSION_ID,
      role: message.role,
      content: message.content,
      created_at: 1_700_000_000_000 + index * 1_000,
    });
  });

  knowledge = createKnowledgeService({ db });
  // Four matching pages: more than the supplement allowance, so the ceiling is
  // observable rather than coincidental.
  for (let index = 1; index <= 4; index++) {
    const created = knowledge.create(
      {
        pageType: 'topic',
        slug: `excel-page-${index}`,
        title: `Excel 约定 ${index}`,
        content: `Excel ETL 第 ${index} 条约定：Power Query 清洗，Python 只做 join。`,
        sources: [{ kind: 'message', id: 'm-2' }],
      },
      { actor: 'agent' },
    );
    expect(created.ok).toBe(true);
  }
});

afterEach(() => {
  db.close();
});

function textOf(result: ToolExecutionResult): string {
  return result.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

function messageHits(result: ToolExecutionResult): UnifiedMessageHit[] {
  return (result.metadata?.hits ?? []) as UnifiedMessageHit[];
}

function pageHits(result: ToolExecutionResult): UnifiedKnowledgeHit[] {
  return (result.metadata?.pages ?? []) as UnifiedKnowledgeHit[];
}

function run(args: SessionSearchArgs, options?: Partial<SessionSearchToolOptions>) {
  return runSessionSearch(args, { db, ...options });
}

describe('session_search: lane set (K5)', () => {
  it('returns messages and curated pages from one fused search', async () => {
    const result = await run({ query: 'excel', limit: 8 }, { knowledge });
    const text = textOf(result);

    expect(messageHits(result).length).toBeGreaterThan(0);
    expect(pageHits(result).length).toBeGreaterThan(0);
    // Two labelled sections, so the model can tell a past message from a page.
    expect(text).toContain('message(s) for "excel"');
    expect(text).toContain('knowledge page(s) for "excel"');
    expect(text).toContain('page excel-page-1');
    expect(text).toContain('message m-2');
  });

  it('keeps the message section the same shape as before, +context marker included', async () => {
    const result = await run({ query: 'excel', limit: 8 }, { knowledge });
    const text = textOf(result);

    // Legacy header, legacy per-entry layout (time · channel · session · role).
    expect(text).toContain('(oldest first; entries marked "+context" are the neighbouring message');
    expect(text).toMatch(
      /1\. \d{4}-\d{2}-\d{2} \d{2}:\d{2}Z · feishu · 目录检查 · (user|assistant)/,
    );
    expect(text).toContain('+context');
    expect(text).toContain('session s-session-search');
  });
});

describe('session_search: the hard total cap', () => {
  it('counts fused knowledge hits inside `limit` — never 8 messages plus 2 pages', async () => {
    const limit = 4;
    const result = await run({ query: 'excel', limit }, { knowledge });

    // The invariant the tool documents: `limit` is the total, not a per-lane
    // allowance. It is what keeps 8 × 3 fragments out of the 400-token budget.
    expect(messageHits(result).length + pageHits(result).length).toBeLessThanOrEqual(limit);
    expect(messageHits(result).length).toBeGreaterThan(0);
    expect(pageHits(result).length).toBeGreaterThan(0);
  });

  it('never lets the page lane take more than the supplement allowance', async () => {
    const result = await run({ query: 'excel', limit: 20 }, { knowledge });

    // Four pages match; two are the ceiling (same ceiling as the injected
    // `<knowledge_available>` block), so the message lane keeps the budget.
    expect(pageHits(result)).toHaveLength(2);
    expect(messageHits(result).length + pageHits(result).length).toBeLessThanOrEqual(20);
  });

  it('caps a single-entry request at one entry', async () => {
    const result = await run({ query: 'excel', limit: 1 }, { knowledge });

    expect(messageHits(result).length + pageHits(result).length).toBe(1);
    expect(textOf(result)).not.toContain('knowledge page(s)');
  });

  it('applies the documented default of 8 when the caller passes no limit', async () => {
    const result = await run({ query: 'excel' }, { knowledge });

    expect(messageHits(result).length + pageHits(result).length).toBeLessThanOrEqual(8);
  });
});

describe('session_search: knowledge layer absent', () => {
  it('returns exactly the message-only result, in the old order and shape', async () => {
    const result = await run({ query: 'excel', limit: 8 });
    const legacy: ConversationSearchHit[] = searchMessages({ db, query: 'excel', limit: 8 });

    // Same entries, same order (chronological), same fields — the fusion is an
    // identity transform on a single lane, and nothing else changed.
    expect(messageHits(result).map((hit) => hit.ref)).toEqual(legacy.map((hit) => hit.message_id));
    expect(messageHits(result).map((hit) => [hit.role, hit.snippet, hit.expanded])).toEqual(
      legacy.map((hit) => [hit.role, hit.snippet, hit.expanded]),
    );
    expect(pageHits(result)).toEqual([]);
    expect(textOf(result)).not.toContain('knowledge page(s)');
  });

  it('still reports provenance (memories / knowledge slugs) on a message hit', async () => {
    db.prepare(
      `INSERT INTO memories (id, scope, scope_key, kind, content, confidence, created_at, updated_at)
       VALUES ('mem-1', 'user', 'user-1', 'fact', 'excel script path', 0.9, '1700000000000', '1700000000000')`,
    ).run();
    db.prepare(
      `INSERT INTO memory_sources (memory_id, message_id, session_id, source)
       VALUES ('mem-1', 'm-2', ?, 'pipeline')`,
    ).run(SESSION_ID);

    const result = await run({ query: 'excel', limit: 8 });
    const hit = messageHits(result).find((entry) => entry.ref === 'm-2');

    expect(hit?.memoryIds).toEqual(['mem-1']);
    expect(hit?.knowledgeSlugs).toEqual([
      'excel-page-1',
      'excel-page-2',
      'excel-page-3',
      'excel-page-4',
    ]);
  });

  it('says so when nothing matches instead of inventing an answer', async () => {
    const result = await run({ query: '完全无关的词 xyzzy' }, { knowledge });

    expect(messageHits(result)).toEqual([]);
    expect(pageHits(result)).toEqual([]);
    expect(textOf(result)).toContain('No conversation messages matched');
  });
});

describe('session_search: deterministic ordering', () => {
  it('renders identical text for identical input, pages and messages alike', async () => {
    const first = await run({ query: 'excel', limit: 6 }, { knowledge });
    const second = await run({ query: 'excel', limit: 6 }, { knowledge });

    // Equal lane ranks fuse to equal RRF scores, so the tie-break (lane order,
    // then hit key) has to be stable — two calls, one answer.
    expect(textOf(second)).toBe(textOf(first));
    expect(pageHits(second).map((hit) => hit.ref)).toEqual(pageHits(first).map((hit) => hit.ref));
  });

  it('lists messages oldest first regardless of fused rank', async () => {
    const result = await run({ query: 'excel', limit: 8 }, { knowledge });
    const createdAt = messageHits(result).map((hit) => hit.createdAt);

    expect(createdAt).toEqual([...createdAt].sort((a, b) => a - b));
  });
});
