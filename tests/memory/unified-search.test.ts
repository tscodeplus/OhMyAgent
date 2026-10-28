/**
 * `unified-search.ts` — the K5 fusion point for the message / memory /
 * knowledge lanes.
 *
 * Everything here runs against the real database (`openDatabase(':memory:')`,
 * i.e. the real migration chain) and the real `conversation-search.ts` +
 * `KnowledgeService`, because the property that matters most is provenance:
 * the page→memory dedupe only exists if `knowledge_sources` rows are readable
 * through the service. A stubbed lane would test the merge arithmetic and
 * nothing else.
 *
 * Covered:
 *   - fan-out: every configured lane contributes hits, each tagged with its
 *     lane, and each lane reports its own count;
 *   - provenance dedupe (plan §6 K2-3.1 same-source rule): a memory cited by a
 *     returned page is dropped from the memory lane and recorded;
 *   - ordering: fused score is non-increasing, equal-rank ties follow the
 *     documented lane order (`message` → `memory` → `knowledge`);
 *   - empty result: no hits, no lane errors, nothing deduped;
 *   - lane failure: one broken lane degrades to an error report instead of
 *     failing the search;
 *   - unconfigured lanes are absent, not empty-with-errors.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/memory/db.js';
import { MessageRepository } from '../../src/memory/repositories/message-repository.js';
import { createKnowledgeService } from '../../src/memory/knowledge/service.js';
import type { KnowledgeService } from '../../src/memory/knowledge/service-contract.js';
import { unifiedSearch } from '../../src/memory/unified-search.js';
import type { RetrievedMemory } from '../../src/memory/memory-retriever.js';

const SESSION_ID = 's-unified';
const MESSAGE_HIT_ID = 'm-hit';
const MEMORY_CITED = 'mem-cited-by-page';
const MEMORY_FREE = 'mem-not-on-any-page';

let db: Database.Database;
let knowledge: KnowledgeService;

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

  // Citation targets: a page may only cite rows that exist (the anonymous
  // anti-hallucination gate), so the memories are seeded before the page.
  const insertMemory = db.prepare(
    `INSERT INTO memories (id, scope, scope_key, kind, content, confidence, created_at, updated_at)
     VALUES (?, 'user', 'user-1', 'fact', ?, 0.9, '1700000000000', '1700000000000')`,
  );
  insertMemory.run(MEMORY_CITED, 'Excel ETL uses Power Query instead of manual VLOOKUP');
  insertMemory.run(MEMORY_FREE, 'unrelated memory that no page cites');

  knowledge = createKnowledgeService({ db });
  const created = knowledge.create(
    {
      pageType: 'topic',
      slug: 'excel-etl',
      title: 'Excel ETL',
      content: 'Excel ETL 用 Power Query 替代手工 VLOOKUP。',
      sources: [{ kind: 'memory', id: MEMORY_CITED }],
    },
    { actor: 'agent' },
  );
  expect(created.ok).toBe(true);
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
      id: MEMORY_CITED,
      content: 'Excel ETL uses Power Query instead of manual VLOOKUP',
      scope: 'user',
      kind: 'fact',
      score: 0.92,
      createdAt: 1_700_000_000_000,
    },
    {
      id: MEMORY_FREE,
      content: 'unrelated memory that no page cites',
      scope: 'user',
      kind: 'fact',
      score: 0.41,
      createdAt: 1_700_000_000_000,
    },
  ];
}

describe('unifiedSearch: lane fan-out', () => {
  it('returns hits from all three lanes, each attributed to its lane', async () => {
    const result = await unifiedSearch({
      query: 'excel',
      messages: { db },
      memories: { retriever: memoryRetriever(seededMemories()) },
      knowledge: { service: knowledge },
      perLaneLimit: 5,
    });

    expect(result.lanes.message.hits).toBeGreaterThan(0);
    expect(result.lanes.memory.hits).toBeGreaterThan(0);
    expect(result.lanes.knowledge.hits).toBeGreaterThan(0);

    const lanes = new Set(result.hits.map((hit) => hit.lane));
    expect(lanes).toEqual(new Set(['message', 'memory', 'knowledge']));

    for (const hit of result.hits) {
      expect(hit.key).toBe(`${hit.lane}:${hit.ref}`);
      expect(hit.laneRank).toBeGreaterThanOrEqual(1);
      expect(hit.laneScore).toBeGreaterThanOrEqual(0);
      expect(hit.laneScore).toBeLessThanOrEqual(1);
      expect(hit.score).toBeGreaterThan(0);
    }

    const messageHit = result.hits.find((hit) => hit.lane === 'message');
    expect(messageHit).toMatchObject({ ref: MESSAGE_HIT_ID, sessionId: SESSION_ID });
    const knowledgeHit = result.hits.find((hit) => hit.lane === 'knowledge');
    expect(knowledgeHit).toMatchObject({ slug: 'excel-etl', pageType: 'topic' });
  });

  it('leaves an unconfigured lane out without reporting an error', async () => {
    const result = await unifiedSearch({
      query: 'excel',
      messages: { db },
      perLaneLimit: 5,
    });

    expect(result.hits.every((hit) => hit.lane === 'message')).toBe(true);
    expect(result.lanes.memory).toEqual({ hits: 0, dropped: 0 });
    expect(result.lanes.knowledge).toEqual({ hits: 0, dropped: 0 });
  });
});

describe('unifiedSearch: provenance dedupe', () => {
  it('drops a memory the returned page cites, and says which page covers it', async () => {
    const result = await unifiedSearch({
      query: 'excel',
      messages: { db },
      memories: { retriever: memoryRetriever(seededMemories()) },
      knowledge: { service: knowledge },
      perLaneLimit: 5,
    });

    const memoryRefs = result.hits.filter((hit) => hit.lane === 'memory').map((hit) => hit.ref);
    expect(memoryRefs).not.toContain(MEMORY_CITED);
    expect(memoryRefs).toContain(MEMORY_FREE);

    expect(result.deduped).toEqual([
      {
        lane: 'memory',
        ref: MEMORY_CITED,
        reason: 'cited_by_knowledge_page',
        pageSlug: 'excel-etl',
      },
    ]);
    expect(result.lanes.memory).toMatchObject({ hits: 2, dropped: 1 });

    // The page keeps its provenance, so the drop is explainable from the result.
    const page = result.hits.find((hit) => hit.lane === 'knowledge');
    expect(page && page.lane === 'knowledge' && page.memoryIds).toEqual([MEMORY_CITED]);
  });

  it('drops nothing when no page covers the memories', async () => {
    const result = await unifiedSearch({
      query: 'excel',
      memories: { retriever: memoryRetriever(seededMemories()) },
      perLaneLimit: 5,
    });

    expect(result.deduped).toEqual([]);
    expect(result.lanes.memory).toEqual({ hits: 2, dropped: 0 });
  });
});

describe('unifiedSearch: ordering', () => {
  it('orders by fused score and breaks equal-rank ties in lane order', async () => {
    const result = await unifiedSearch({
      query: 'excel',
      messages: { db },
      memories: { retriever: memoryRetriever(seededMemories()) },
      knowledge: { service: knowledge },
      perLaneLimit: 5,
    });

    const scores = result.hits.map((hit) => hit.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));

    // Every lane's best hit fuses to the same score, so the documented lane
    // order decides: raw text, then memory, then page.
    expect(result.hits.slice(0, 3).map((hit) => hit.lane)).toEqual([
      'message',
      'memory',
      'knowledge',
    ]);
    expect(result.hits[0]!.laneRank).toBe(1);
  });

  it('ranks a neighbourhood row below every real hit of the other lanes', async () => {
    const result = await unifiedSearch({
      query: 'excel',
      messages: { db },
      knowledge: { service: knowledge },
      perLaneLimit: 5,
    });

    const messageHits = result.hits.filter((hit) => hit.lane === 'message');
    expect(messageHits).toHaveLength(2);
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
      knowledge: { service: knowledge },
    });

    expect(result.hits).toEqual([]);
    expect(result.deduped).toEqual([]);
    expect(result.lanes).toEqual({
      message: { hits: 0, dropped: 0 },
      memory: { hits: 0, dropped: 0 },
      knowledge: { hits: 0, dropped: 0 },
    });
  });

  it('returns an empty result for an empty query without touching the lanes', async () => {
    const retriever = { retrieve: async () => seededMemories() };
    const result = await unifiedSearch({ query: '   ', memories: { retriever }, messages: { db } });

    expect(result.hits).toEqual([]);
    expect(result.lanes.message.hits).toBe(0);
  });

  it('reports a broken lane and still answers with the others', async () => {
    const broken: Pick<KnowledgeService, 'search' | 'get'> = {
      search: () => {
        throw new Error('no such table: knowledge_fts_jieba');
      },
      get: () => null,
    };

    const result = await unifiedSearch({
      query: 'excel',
      messages: { db },
      memories: { retriever: memoryRetriever(seededMemories()) },
      knowledge: { service: broken },
      perLaneLimit: 5,
    });

    expect(result.lanes.knowledge.error).toContain('knowledge_fts_jieba');
    expect(result.lanes.knowledge.hits).toBe(0);
    expect(result.hits.some((hit) => hit.lane === 'message')).toBe(true);
    expect(result.hits.some((hit) => hit.lane === 'memory')).toBe(true);
  });
});
