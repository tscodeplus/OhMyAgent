/**
 * Curation recovery (P1 + P3 from the 2026-10-30 knowledge review) — the
 * vitest acceptance suite for the mechanism that lets the curator address a
 * row `service.get` cannot see.
 *
 * Two rows previously owned their `(page_type, slug, scope)` address while
 * being invisible to the read the curator looked up:
 *
 *   - an **invalidated** page — `invalidatePagesCitingMemory` re-queues a page
 *     whose cited memory changed as `pending` — so the nightly run spent a
 *     page-body LLM call, hit the `(page_type, slug)` conflict on insert and
 *     re-logged the same refusal forever, while the stale body sat in the
 *     review queue;
 *   - a **merged-away** page — `applyMergePlan` archives the loser, which kept
 *     the address, so a re-curation of that subject was also a permanent
 *     `version_conflict`.
 *
 * Both are acceptance-tested here over the whole stack (real migration chain,
 * real service, real curator with a scripted aux-LLM): the next run writes an
 * UPDATE, the recovered page takes the status the shadow config dictates for a
 * fresh write, and the approval endpoint warns when a still-stale page is being
 * published.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import type Database from 'better-sqlite3';
import type { Logger } from 'pino';
import { openDatabase } from '../../src/memory/db.js';
import { KnowledgeCurator, type KnowledgeCurateConfig } from '../../src/memory/knowledge/curate.js';
import { createKnowledgeService } from '../../src/memory/knowledge/service.js';
import type { KnowledgeService } from '../../src/memory/knowledge/service-contract.js';
import { invalidatePagesCitingMemory } from '../../src/memory/knowledge/memory-page-invalidation.js';
import { applyMergePlan, findMergeCandidates } from '../../src/memory/knowledge/merge.js';
import { registerKnowledgeRoutes } from '../../src/app/webui/knowledge-routes.js';
import type { KnowledgePageStatus } from '../../src/memory/knowledge/types.js';
import type { AuxLLMCallOptions } from '../../src/memory/aux-llm-client.js';

const SUBJECT = 'Power Query';
const MEMORY_IDS = ['memory-recovery-a', 'memory-recovery-b'];

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

function scriptOnePage(body: string, subject = SUBJECT): void {
  responses = [
    JSON.stringify([{ subject, memoryIds: MEMORY_IDS }]),
    JSON.stringify({ title: subject, content: body, tags: ['etl'], aliases: [] }),
  ];
}

function curateConfig(overrides: Partial<KnowledgeCurateConfig> = {}): KnowledgeCurateConfig {
  return {
    enabled: true,
    // `manual` stands in for a user-triggered run; admission rule 3 needs it
    // when the seeded memories share one conversation.
    mode: 'manual',
    shadow: false,
    maxPagesPerRun: 5,
    requireSources: 2,
    minMemoryConfidence: 0.6,
    ...overrides,
  };
}

function curator(overrides: Partial<KnowledgeCurateConfig> = {}): KnowledgeCurator {
  return new KnowledgeCurator({
    db,
    knowledgeService: service,
    logger,
    config: curateConfig(overrides),
    callLLM,
  });
}

/** Two memories about the subject inside the window, each scope_key its own. */
function seedMemories(scopeKeys: [string, string] = ['feishu:oc_a', 'telegram:42']): void {
  const now = Date.now() - 1000;
  const insert = db.prepare(
    `INSERT INTO memories (id, scope, scope_key, kind, content, confidence, created_at, updated_at)
     VALUES (?, 'user', ?, 'fact', ?, 0.9, ?, ?)`,
  );
  insert.run(
    MEMORY_IDS[0],
    scopeKeys[0],
    'Power Query replaced the manual VLOOKUP ETL',
    String(now),
    String(now),
  );
  insert.run(
    MEMORY_IDS[1],
    scopeKeys[1],
    'Power Query is how the team runs the monthly ETL',
    String(now),
    String(now),
  );

  // A recent *successful* run fixes the window around the seeded memories.
  db.prepare(
    `INSERT INTO maintenance_runs (id, job_name, status, started_at, affected_rows)
     VALUES ('run-seed', 'dreamcycle_knowledge_curate', 'success', ?, 1)`,
  ).run(String(now - 500));
}

interface PageRow {
  id: string;
  slug: string;
  status: KnowledgePageStatus;
  version: number;
  content: string;
}

function pageBySlug(slug: string, pageType = 'topic'): PageRow {
  const row = db
    .prepare(
      'SELECT id, slug, status, version, content FROM knowledge_pages WHERE slug = ? AND page_type = ?',
    )
    .get(slug, pageType) as PageRow | undefined;
  if (!row) throw new Error(`no page ${slug}`);
  return row;
}

describe('curate recovery: an invalidated page', () => {
  beforeEach(() => {
    db = openDatabase(':memory:');
    service = createKnowledgeService({ db });
    responses = [];
    llmCalls = [];
    seedMemories();
  });

  afterEach(() => {
    db.close();
  });

  it('is UPDATED (not blocked in version_conflict) on the next run, and its body refreshes', async () => {
    scriptOnePage('Power Query replaced the manual VLOOKUP ETL.');
    const first = await curator().run({ trigger: 'manual' });
    expect(first.created).toBe(1);
    const before = pageBySlug('power-query');
    expect(before.status).toBe('active');

    // The memory a page cites gets corrected: the page flips `pending`.
    const flipped = await invalidatePagesCitingMemory(db, MEMORY_IDS[0], 'write', logger);
    expect(flipped).toBe(1);
    expect(pageBySlug('power-query').status).toBe('pending');

    // The re-curation routes around the active-only read: an update, not the
    // refusal loop the conflict branch produced.
    scriptOnePage('Power Query replaced the manual VLOOKUP ETL; verified against the June run.');
    const second = await curator().run({ trigger: 'manual' });

    expect(second.updated).toBe(1);
    expect(second.created).toBe(0);
    expect(second.rejected.version_conflict).toBeUndefined();
    expect(second.failed).toBe(0);

    const after = pageBySlug('power-query');
    expect(after.status).toBe('active');
    // The invalidation bump plus the recovery write: two versions of progress.
    expect(after.version).toBe(before.version + 2);
    expect(after.content).toContain('June run');

    // Exactly one page call each run — the old loop burned one per night for
    // nothing, and this is the regression that must never come back.
    expect(llmCalls).toHaveLength(4);
  });

  it('stays pending under shadow:true, with the fresh body waiting for review', async () => {
    scriptOnePage('Power Query replaced the manual VLOOKUP ETL.');
    await curator({ shadow: false }).run({ trigger: 'manual' });
    const before = pageBySlug('power-query');
    expect(before.status).toBe('active');

    await invalidatePagesCitingMemory(db, MEMORY_IDS[1], 'update', logger);
    expect(pageBySlug('power-query').status).toBe('pending');

    // Shadow on: a fresh write would land pending, so recovery defers to the
    // review queue as well — with the new body, not the frozen stale one.
    scriptOnePage('Power Query ETL, verified; the stale copy is gone.');
    const report = await curator({ shadow: true }).run({ trigger: 'manual' });

    expect(report.updated).toBe(1);
    expect(report.rejected.version_conflict).toBeUndefined();
    const after = pageBySlug('power-query');
    expect(after.status).toBe('pending');
    expect(after.content).toContain('stale copy is gone');
    expect(after.version).toBe(before.version + 2);
  });

  it('approval carries a stale warning only for a re-queued page', async () => {
    scriptOnePage('Power Query replaced the manual VLOOKUP ETL.');
    await curator().run({ trigger: 'manual' });
    await invalidatePagesCitingMemory(db, MEMORY_IDS[0], 'write', logger);
    const invalidated = pageBySlug('power-query');

    // A control page: pending by plain creation, no invalidation behind it.
    const control = service.create(
      {
        pageType: 'topic',
        slug: 'fresh-draft',
        title: 'Fresh draft',
        content: 'Written and queued for review.',
        sources: [{ kind: 'memory', id: MEMORY_IDS[1] }],
        status: 'pending',
      },
      { actor: 'user' },
    );
    if (!control.ok) throw new Error(`control seed failed: ${control.code}`);

    const app = Fastify({ logger: false });
    registerKnowledgeRoutes(app, { db, service });
    await app.ready();
    try {
      const stale = await app.inject({
        method: 'POST',
        url: `/api/knowledge/page/${invalidated.id}/approve`,
      });
      expect(stale.statusCode).toBe(200);
      const staleBody = stale.json() as { warning?: string };
      // Not blocked — but the reviewer is told the body predates the citation.
      expect(staleBody.warning).toContain('cites');
      expect(staleBody.warning).toContain('may still');

      const controlRes = await app.inject({
        method: 'POST',
        url: `/api/knowledge/page/${control.id}/approve`,
      });
      expect(controlRes.statusCode).toBe(200);
      const controlBody = controlRes.json() as { warning?: string };
      expect(controlBody.warning).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});

describe('curate recovery: a merged-away page', () => {
  beforeEach(() => {
    db = openDatabase(':memory:');
    service = createKnowledgeService({ db });
    responses = [];
    llmCalls = [];
    seedMemories();
  });

  afterEach(() => {
    db.close();
  });

  /** Hand-seeded memory rows the merge pages can cite. */
  function seedMergeMemories(): void {
    const now = String(Date.now() - 2000);
    for (const id of ['merge-src-a', 'merge-src-b']) {
      db.prepare(
        `INSERT OR IGNORE INTO memories (id, scope, scope_key, kind, content, confidence, created_at, updated_at)
         VALUES (?, 'user', 'merge-session', 'fact', 'seed row', 0.9, ?, ?)`,
      ).run(id, now, now);
    }
  }

  function createPage(slug: string, title: string, content: string, sources: number): PageRow {
    const result = service.create(
      {
        pageType: 'topic',
        slug,
        title,
        content,
        sources: Array.from({ length: sources }, (_, index) => ({
          kind: 'memory' as const,
          id: index === 0 ? 'merge-src-a' : 'merge-src-b',
        })),
      },
      { actor: 'user' },
    );
    if (!result.ok) throw new Error(`seed ${slug} failed: ${result.code}`);
    return pageBySlug(slug);
  }

  it('the same subject curates again after the merge — an update, not a version_conflict', async () => {
    seedMergeMemories();
    // One of `powerquery`'s names folds onto the survivor's (`normalized_name`
    // evidence); the survivor keeps the page with more citations.
    createPage('power-query', 'Power Query', 'Power Query replaced manual VLOOKUP.', 2);
    createPage('powerquery', 'PowerQuery', 'PowerQuery ETL notes.', 1);

    const plan = findMergeCandidates(db);
    expect(plan.candidates).toHaveLength(1);
    const [outcome] = applyMergePlan(db, plan);
    expect(outcome.status).toBe('merged');

    // The loser still owns its address, archived.
    const loser = pageBySlug('powerquery');
    expect(loser.status).toBe('archived');
    expect(pageBySlug('power-query').status).toBe('active');

    // The subject is being re-established: the curator's deterministic slug for
    // `PowerQuery` is exactly the archived row — the run must write an update.
    scriptOnePage('PowerQuery ETL, re-established after the merge.', 'PowerQuery');
    const report = await curator().run({ trigger: 'manual' });

    expect(report.updated).toBe(1);
    expect(report.rejected.version_conflict).toBeUndefined();
    const reestablished = pageBySlug('powerquery');
    expect(reestablished.status).toBe('active');
    expect(reestablished.content).toContain('re-established');
  });
});
