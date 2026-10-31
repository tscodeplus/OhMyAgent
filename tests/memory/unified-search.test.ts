/**
 * `unified-search.ts` — the fusion point for the message / memory lanes.
 *
 * Everything here runs against the real database (`openDatabase(':memory:')`,
 * i.e. the real migration chain) and the real `conversation-search.ts`, because
 * the property that matters most is that the two lanes are fused by rank and not
 * by their own arithmetic. A stubbed message lane would test the merge
 * arithmetic and nothing else.
 *
 * Covered:
 *   - fan-out: every configured lane contributes hits, each tagged with its
 *     lane, and each lane reports its own count;
 *   - ordering: fused score is non-increasing, equal-rank ties follow the
 *     documented lane order (`message` → `memory`);
 *   - empty result: no hits, no lane errors;
 *   - lane failure: one broken lane degrades to an error report instead of
 *     failing the search;
 *   - unconfigured lanes are absent, not empty-with-errors.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/memory/db.js';
import { MessageRepository } from '../../src/memory/repositories/message-repository.js';
import { unifiedSearch } from '../../src/memory/unified-search.js';
import type { RetrievedMemory } from '../../src/memory/memory-retriever.js';

const SESSION_ID = 's-unified';
const MESSAGE_HIT_ID = 'm-hit';
const MEMORY_A = 'mem-a';
const MEMORY_B = 'mem-b';

let db: Database.Database;

beforeEach(() => {
  db = openDatabase(':memory:');

  db.prepare(
    `INSERT INTO sessions (id, chat_id, user_id, project_id, channel, title, created_at, updated_at)
     VALUES (?, ?, 'user-1', NULL, 'feishu', '目录检查', '1700000000000', '1700000000000')`,
  ).run(SESSION_ID, SESSION_ID);

  const messages = new MessageRepository(db);
  messages.create({
    id: MESSAGE_HIT_ID,
    session_id: SESSION_ID,
    role: 'user',
    content: 'the excel batch replace script we discussed lives in scripts/replace.py',
    created_at: 1_700_000_000_000,
  });
  messages.create({
    id: 'm-neighbour',
    session_id: SESSION_ID,
    role: 'assistant',
    content: 'found it, that is the one from last week',
    created_at: 1_700_000_001_000,
  });

  const insertMemory = db.prepare(
    `INSERT INTO memories (id, scope, scope_key, kind, content, confidence, created_at, updated_at)
     VALUES (?, 'user', 'user-1', 'fact', ?, 0.9, '1700000000000', '1700000000000')`,
  );
  insertMemory.run(MEMORY_A, 'Excel ETL uses Power Query instead of manual VLOOKUP');
  insertMemory.run(MEMORY_B, 'another memory the retriever may return');
});

afterEach(() => {
  db.close();
});

/** The memory lane's retriever; scores are the lane's own, not cross-lane numbers. */
function memoryRetriever(memories: RetrievedMemory[]) {
  return { retrieve: async () => memories };
}

function seededMemories(): RetrievedMemory[] {
  return [
    {
      id: MEMORY_A,
      content: 'Excel ETL uses Power Query instead of manual VLOOKUP',
      scope: 'user',
      kind: 'fact',
      score: 0.92,
      createdAt: 1_700_000_000_000,
    },
    {
      id: MEMORY_B,
      content: 'another memory the retriever may return',
      scope: 'user',
      kind: 'fact',
      score: 0.41,
      createdAt: 1_700_000_000_000,
    },
  ];
}

describe('unifiedSearch: lane fan-out', () => {
  it('returns hits from both lanes, each attributed to its lane', async () => {
    const result = await unifiedSearch({
      query: 'excel',
      messages: { db },
      memories: { retriever: memoryRetriever(seededMemories()) },
      perLaneLimit: 5,
    });

    expect(result.hits.some((hit) => hit.lane === 'message')).toBe(true);
    expect(result.hits.some((hit) => hit.lane === 'memory')).toBe(true);
    expect(result.lanes.message.hits).toBeGreaterThan(0);
    expect(result.lanes.memory.hits).toBe(2);
    // The fusion key is lane-prefixed, so no id can appear twice.
    expect(new Set(result.hits.map((hit) => hit.key)).size).toBe(result.hits.length);
  });

  it('leaves an unconfigured lane out without reporting an error', async () => {
    const result = await unifiedSearch({ query: 'excel', messages: { db } });

    expect(result.hits.every((hit) => hit.lane === 'message')).toBe(true);
    expect(result.lanes.memory).toEqual({ hits: 0, dropped: 0 });
  });
});

describe('unifiedSearch: ordering', () => {
  it('orders by fused score and breaks equal-rank ties in lane order', async () => {
    const result = await unifiedSearch({
      query: 'excel',
      messages: { db },
      memories: { retriever: memoryRetriever(seededMemories()) },
      perLaneLimit: 5,
    });

    const scores = result.hits.map((hit) => hit.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));

    // Both lanes' best hits fuse to the same score, so the documented lane
    // order decides: raw text before memory.
    expect(result.hits.slice(0, 2).map((hit) => hit.lane)).toEqual(['message', 'memory']);
    expect(result.hits[0]!.laneRank).toBe(1);
  });

  it('ranks a neighbourhood row below the real hit it was quoted with', async () => {
    const result = await unifiedSearch({
      query: 'excel',
      messages: { db },
      perLaneLimit: 5,
    });

    const messageHits = result.hits.filter((hit) => hit.lane === 'message');
    // conversation-search returns hits chronologically; fusion re-ranks the
    // BM25 hit above the score-0 neighbour it was quoted with.
    const neighbour = messageHits.find((hit) => hit.lane === 'message' && hit.expanded)!;
    const real = messageHits.find((hit) => hit.lane === 'message' && !hit.expanded)!;
    expect(real.laneRank).toBe(1);
    expect(neighbour.laneRank).toBe(2);
  });
});

describe('unifiedSearch: empty and failing lanes', () => {
  it('returns an empty result when nothing matches', async () => {
    const result = await unifiedSearch({
      query: '完全无关的查询词 xyzzy',
      messages: { db },
      memories: { retriever: memoryRetriever([]) },
    });

    expect(result.hits).toEqual([]);
    expect(result.lanes).toEqual({
      message: { hits: 0, dropped: 0 },
      memory: { hits: 0, dropped: 0 },
    });
  });

  it('returns an empty result for an empty query without touching the lanes', async () => {
    let called = false;
    const retriever = {
      retrieve: async () => {
        called = true;
        return seededMemories();
      },
    };
    const result = await unifiedSearch({ query: '   ', memories: { retriever }, messages: { db } });

    expect(result.hits).toEqual([]);
    expect(called).toBe(false);
  });

  it('reports a broken lane and still answers with the others', async () => {
    const result = await unifiedSearch({
      query: 'excel',
      messages: { db },
      memories: {
        retriever: {
          retrieve: async () => {
            throw new Error('vector store down');
          },
        },
      },
    });

    expect(result.lanes.memory.error).toContain('vector store down');
    expect(result.lanes.message.hits).toBeGreaterThan(0);
    expect(result.hits.every((hit) => hit.lane === 'message')).toBe(true);
  });
});

describe('unifiedSearch: lane set', () => {
  it('fuses only the lanes asked for and reports the others as empty, not failed', async () => {
    const result = await unifiedSearch({
      query: 'excel',
      lanes: ['message'],
      messages: { db },
      memories: { retriever: memoryRetriever(seededMemories()) },
      perLaneLimit: 5,
    });

    expect(result.hits.every((hit) => hit.lane === 'message')).toBe(true);
    expect(result.lanes.message.hits).toBeGreaterThan(0);
    // A lane that was not asked for is indistinguishable from a lane that
    // matched nothing: `{ hits: 0, dropped: 0 }` and no `error`.
    expect(result.lanes.memory).toEqual({ hits: 0, dropped: 0 });
  });

  it('runs the memory lane alone when it is the only one asked for', async () => {
    const result = await unifiedSearch({
      query: 'excel',
      lanes: ['memory'],
      messages: { db },
      memories: { retriever: memoryRetriever(seededMemories()) },
      perLaneLimit: 5,
    });

    expect(new Set(result.hits.map((hit) => hit.lane))).toEqual(new Set(['memory']));
    expect(result.lanes.message).toEqual({ hits: 0, dropped: 0 });
  });

  it('does not run a lane that is named but has no options', async () => {
    const result = await unifiedSearch({
      query: 'excel',
      lanes: ['message', 'memory'],
      messages: { db },
      perLaneLimit: 5,
    });

    expect(result.hits.every((hit) => hit.lane === 'message')).toBe(true);
    // Named without a retriever to ask = not run, and not an error.
    expect(result.lanes.memory).toEqual({ hits: 0, dropped: 0 });
  });

  it('defaults to every configured lane when no set is given', async () => {
    const result = await unifiedSearch({
      query: 'excel',
      messages: { db },
      memories: { retriever: memoryRetriever(seededMemories()) },
      perLaneLimit: 5,
    });

    expect(new Set(result.hits.map((hit) => hit.lane))).toEqual(new Set(['message', 'memory']));
  });

  it('applies a per-lane allowance without lowering the shared per-lane limit', async () => {
    const asked: Array<number | undefined> = [];
    const result = await unifiedSearch({
      query: 'excel',
      messages: { db },
      memories: {
        retriever: {
          retrieve: async (options) => {
            asked.push(options.topK);
            return seededMemories();
          },
        },
      },
      limit: 10,
      perLaneLimit: 10,
      perLaneLimits: { memory: 1 },
    });

    // The allowance is what the lane is asked for, not a post-filter: the
    // retriever is the thing that spends the work.
    expect(asked).toEqual([1]);
    expect(result.lanes.memory.hits).toBe(2);
    expect(result.lanes.message.hits).toBeGreaterThan(0);
  });

  it('clamps the final list to `limit` while each lane keeps its own allowance', async () => {
    const result = await unifiedSearch({
      query: 'excel',
      messages: { db },
      memories: { retriever: memoryRetriever(seededMemories()) },
      limit: 1,
      perLaneLimit: 5,
    });

    expect(result.hits).toHaveLength(1);
    expect(result.lanes.memory.hits).toBe(2);
    expect(result.lanes.message.hits).toBeGreaterThan(0);
  });
});

describe('unifiedSearch: deterministic ordering', () => {
  it('orders equal lane ranks message-first and repeats identically', async () => {
    const run = () =>
      unifiedSearch({
        query: 'excel',
        messages: { db },
        memories: { retriever: memoryRetriever(seededMemories()) },
        perLaneLimit: 5,
      });

    const first = await run();
    const second = await run();

    expect(first.hits[0]!.lane).toBe('message');
    expect(first.hits.map((hit) => hit.key)).toEqual(second.hits.map((hit) => hit.key));
  });
});
