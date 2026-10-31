/**
 * `session_search` — the tool the model actually calls.
 *
 * The tool asks `unifiedSearch()` for the message lane, so the agent and the
 * WebUI rank the same corpus with one code path. These tests pin the properties
 * the fusion is allowed to touch:
 *
 *   - the lane set: messages run, the memory lane does not (this tool answers
 *     "when did we say that", not "what do I know");
 *   - the hard cap: `limit` is the TOTAL entries returned, neighbourhood rows
 *     included;
 *   - the legacy shape: the section headers, the `+context` marker and the
 *     chronological display order are what the tool has always rendered.
 *
 * Everything runs against the real database (`openDatabase(':memory:')`, the
 * real migration chain) and the real `conversation-search.ts`, because the cap
 * is a property of the fusion of real lanes, not of a stub's arithmetic.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../../src/memory/db.js';
import { MessageRepository } from '../../../src/memory/repositories/message-repository.js';
import { searchMessages } from '../../../src/memory/conversation-search.js';
import type { ConversationSearchHit } from '../../../src/memory/conversation-search.js';
import { runSessionSearch } from '../../../src/tools/builtins/session/session-search-tool.js';
import type {
  SessionSearchArgs,
  SessionSearchToolOptions,
} from '../../../src/tools/builtins/session/session-search-tool.js';
import type { ToolExecutionResult } from '../../../src/tools/platform/tool-result.js';
import type { UnifiedMessageHit } from '../../../src/memory/unified-search.js';

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

function run(args: SessionSearchArgs, options?: Partial<SessionSearchToolOptions>) {
  return runSessionSearch(args, { db, ...options });
}

describe('session_search: the message lane', () => {
  it('returns the matching messages with context, from one fused search', async () => {
    const result = await run({ query: 'excel', limit: 8 });
    const text = textOf(result);

    expect(messageHits(result).length).toBeGreaterThan(0);
    expect(text).toContain('message(s) for "excel"');
    expect(text).toContain('message m-2');
    // Only one labelled section now: there is no second lane to confuse the
    // model about where an entry came from.
    expect(text).not.toContain('knowledge page(s)');
    expect(result.metadata?.pages).toBeUndefined();
  });

  it('keeps the section header and per-entry layout unchanged', async () => {
    const result = await run({ query: 'excel', limit: 8 });
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
  it('counts neighbourhood rows inside `limit`', async () => {
    const limit = 4;
    const result = await run({ query: 'excel', limit });

    // The invariant the tool documents: `limit` is the total, not a per-lane
    // allowance. It is what keeps 8 × 3 fragments out of the 400-token budget.
    expect(messageHits(result).length).toBeLessThanOrEqual(limit);
    expect(messageHits(result).length).toBeGreaterThan(0);
  });

  it('caps a single-entry request at one entry', async () => {
    const result = await run({ query: 'excel', limit: 1 });

    expect(messageHits(result)).toHaveLength(1);
  });

  it('applies the documented default of 8 when the caller passes no limit', async () => {
    const result = await run({ query: 'excel' });

    expect(messageHits(result).length).toBeLessThanOrEqual(8);
  });
});

describe('session_search: no second ranker', () => {
  it('returns exactly the message-only result, in the old order and shape', async () => {
    const result = await run({ query: 'excel', limit: 8 });
    const legacy: ConversationSearchHit[] = searchMessages({ db, query: 'excel', limit: 8 });

    // Same entries, same order (chronological), same fields — the fusion is an
    // identity transform on a single lane, and nothing else changed.
    expect(messageHits(result).map((hit) => hit.ref)).toEqual(legacy.map((hit) => hit.message_id));
    expect(messageHits(result).map((hit) => [hit.role, hit.snippet, hit.expanded])).toEqual(
      legacy.map((hit) => [hit.role, hit.snippet, hit.expanded]),
    );
    expect(textOf(result)).not.toMatch(/^\s*Found 0 /m);
  });

  it('still reports provenance (memories) on a message hit', async () => {
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
    expect(textOf(result)).toContain('memories mem-1');
  });

  it('says so when nothing matches instead of inventing an answer', async () => {
    const result = await run({ query: '完全无关的词 xyzzy' });

    expect(messageHits(result)).toEqual([]);
    expect(textOf(result)).toContain('No conversation messages matched');
  });
});

describe('session_search: deterministic ordering', () => {
  it('renders identical text for identical input', async () => {
    const first = await run({ query: 'excel', limit: 6 });
    const second = await run({ query: 'excel', limit: 6 });

    expect(textOf(second)).toBe(textOf(first));
    expect(messageHits(second).map((hit) => hit.ref)).toEqual(
      messageHits(first).map((hit) => hit.ref),
    );
  });

  it('lists messages oldest first regardless of fused rank', async () => {
    const result = await run({ query: 'excel', limit: 8 });
    const createdAt = messageHits(result).map((hit) => hit.createdAt);

    expect(createdAt).toEqual([...createdAt].sort((a, b) => a - b));
  });
});
