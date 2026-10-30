/**
 * Source gathering for curation (P9 in the 2026-10-30 knowledge review): the
 * subject scan runs over `memories_fts_jieba` with a literal verification of
 * every hit (FTS tokenization matches `oma` for `oma-run-9` — the needle is the
 * authority), and the old `content LIKE '%subject%'` path remains the fallback
 * when the index is missing or empty, so a curation never fails on retrieval.
 *
 * Asserted at the outcome the write sees: the aux-LLM page call's `MEMORIES`
 * block is the citation set the service write carries.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { Logger } from 'pino';
import { openDatabase } from '../../src/memory/db.js';
import { KnowledgeCurator, type KnowledgeCurateConfig } from '../../src/memory/knowledge/curate.js';
import { createKnowledgeService } from '../../src/memory/knowledge/service.js';
import type { KnowledgeService } from '../../src/memory/knowledge/service-contract.js';
import { rebuildJiebaFts } from '../../src/memory/fts.js';
import type { AuxLLMCallOptions } from '../../src/memory/aux-llm-client.js';

const SUBJECT = 'Power Query';
const MEMORY_IDS = ['memory-src-a', 'memory-src-b', 'memory-src-fake', 'memory-src-far'];
/** A token neighbour that is NOT the subject: passes FTS, fails the literal check. */
const FAKE_NEIGHBOUR = 'power and query alternates as a phrase in prose';

let db: Database.Database;
let service: KnowledgeService;
let responses: string[];
let llmCalls: AuxLLMCallOptions[];

const logger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;

const callLLM = async (options: AuxLLMCallOptions): Promise<string> => {
  llmCalls.push(options);
  const next = responses.shift();
  if (next === undefined) throw new Error('unscripted aux-LLM call');
  return next;
};

function curateConfig(overrides: Partial<KnowledgeCurateConfig> = {}): KnowledgeCurateConfig {
  return {
    enabled: true,
    mode: 'manual',
    shadow: false,
    maxPagesPerRun: 5,
    requireSources: 2,
    minMemoryConfidence: 0.6,
    ...overrides,
  };
}

function insertMemory(id: string, content: string, options: { confidence?: number } = {}): void {
  const now = Date.now() - 1000;
  db.prepare(
    `INSERT INTO memories (id, scope, scope_key, kind, content, confidence, status, created_at, updated_at)
     VALUES (?, 'user', ?, 'fact', ?, ?, 'active', ?, ?)`,
  ).run(id, `session-${id}`, content, options.confidence ?? 0.9, String(now), String(now));
}

function seedCorpus(): void {
  insertMemory(MEMORY_IDS[0], 'Power Query replaced the manual VLOOKUP ETL');
  insertMemory(MEMORY_IDS[1], 'Power Query is how the team runs the monthly ETL');
  insertMemory(MEMORY_IDS[2], FAKE_NEIGHBOUR);
  // Below the confidence floor: neither lane may return it.
  insertMemory(MEMORY_IDS[3], 'Power Query from an untrusted low-confidence row', {
    confidence: 0.2,
  });
  // A recent successful run fixes the window around the seeded memories.
  db.prepare(
    `INSERT INTO maintenance_runs (id, job_name, status, started_at, affected_rows)
     VALUES ('run-seed', 'dreamcycle_knowledge_curate', 'success', ?, 1)`,
  ).run(String(Date.now() - 2000));
}

function pageCallSourceIds(): string[] {
  const pageCall = llmCalls[1];
  if (!pageCall) throw new Error('no page call recorded');
  const block = pageCall.userPrompt.split('MEMORIES:')[1]?.split('EXISTING PAGES:')[0] ?? '';
  return MEMORY_IDS.filter((id) => block.includes(`[${id}]`));
}

describe('gatherSources (via the curator run)', () => {
  beforeEach(() => {
    db = openDatabase(':memory:');
    service = createKnowledgeService({ db });
    responses = [];
    llmCalls = [];
    seedCorpus();
  });

  afterEach(() => {
    db.close();
  });

  async function runCurator(subject = SUBJECT): Promise<void> {
    responses = [
      JSON.stringify([{ subject, memoryIds: [MEMORY_IDS[0], MEMORY_IDS[1]] }]),
      JSON.stringify({ title: subject, content: 'body', tags: [], aliases: [] }),
    ];
    const curator = new KnowledgeCurator({
      db,
      knowledgeService: service,
      logger,
      config: curateConfig(),
      callLLM,
    });
    const report = await curator.run({ trigger: 'manual' });
    expect(report.failed).toBe(0);
  }

  it('cites the memories that name the subject, once the index is populated', async () => {
    rebuildJiebaFts(db);
    await runCurator();

    const ids = pageCallSourceIds();
    expect(ids).toContain(MEMORY_IDS[0]);
    expect(ids).toContain(MEMORY_IDS[1]);
  });

  it('drops an FTS hit that does not contain the subject literally', async () => {
    rebuildJiebaFts(db);
    await runCurator();

    // Same tokens (`power`, `query`), never the subject itself: tokenization
    // matches, the needle disagrees, the citation is refused.
    expect(pageCallSourceIds()).not.toContain(MEMORY_IDS[2]);
  });

  it('never cites below the confidence floor, whatever the lane', async () => {
    rebuildJiebaFts(db);
    await runCurator();

    expect(pageCallSourceIds()).not.toContain(MEMORY_IDS[3]);
  });

  it('falls back to LIKE when the FTS index is absent, and still gathers sources', async () => {
    db.prepare('DROP TABLE memories_fts_jieba').run();
    await runCurator();

    const ids = pageCallSourceIds();
    expect(ids).toContain(MEMORY_IDS[0]);
    expect(ids).toContain(MEMORY_IDS[1]);
    // The fallback keeps the literal semantics of the old LIKE path.
    expect(ids).not.toContain(MEMORY_IDS[2]);
  });

  it('falls back to LIKE when the index is empty, instead of gathering nothing', async () => {
    // The table exists but has no rows: the FTS path verified nothing, and the
    // LIKE path must be what runs (an unindexed install is degraded, not mute).
    await runCurator();

    const ids = pageCallSourceIds();
    expect(ids).toContain(MEMORY_IDS[0]);
    expect(ids).toContain(MEMORY_IDS[1]);
  });

  it('the group\u2019s own citations join the source set even without a content match', async () => {
    rebuildJiebaFts(db);
    // 'PowerQuery' matches no memory literally, so both citations arrive only
    // because the grouping call named them.
    await runCurator('PowerQuery');

    expect(pageCallSourceIds()).toEqual([MEMORY_IDS[0], MEMORY_IDS[1]]);
  });
});
