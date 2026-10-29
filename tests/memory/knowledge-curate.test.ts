import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { Logger } from 'pino';
import { openDatabase } from '../../src/memory/db.js';
import {
  KnowledgeCurator,
  evaluateAdmission,
  parseGroupingResponse,
  parsePageResponse,
  type CurateRunReport,
  type KnowledgeCurateConfig,
} from '../../src/memory/knowledge/curate.js';
import type {
  KnowledgePageDetail,
  KnowledgeService,
  KnowledgeWriteOptions,
  KnowledgeWriteResult,
} from '../../src/memory/knowledge/service-contract.js';
import type {
  CreateKnowledgePageInput,
  KnowledgeLink,
  KnowledgePage,
  KnowledgePageStatus,
  PageType,
  UpdateKnowledgePageInput,
} from '../../src/memory/knowledge/types.js';
import type { AuxLLMCallOptions } from '../../src/memory/aux-llm-client.js';

// ── Fakes ───────────────────────────────────────────────────────────────

/**
 * The real service lives in `knowledge/service.ts` (written against the same
 * contract by another task), so the curator is tested against a fake that keeps
 * pages in a Map. It records the write options and inputs verbatim: those are
 * what the assertions are about (actor/enforceAdmission, page identity, the
 * status shadow mode asks for).
 */
class FakeKnowledgeService implements KnowledgeService {
  readonly pages = new Map<string, KnowledgePage>();
  readonly writes: Array<{
    kind: 'create' | 'update';
    input: CreateKnowledgePageInput | UpdateKnowledgePageInput;
    options: KnowledgeWriteOptions;
  }> = [];
  /** When set, the next write is refused with this result. */
  refuse: (KnowledgeWriteResult & { ok: false }) | null = null;
  private seq = 0;

  private key(pageType: string, slug: string): string {
    return `${pageType}:${slug}`;
  }

  create(input: CreateKnowledgePageInput, options: KnowledgeWriteOptions): KnowledgeWriteResult {
    if (this.refuse) return this.refuse;
    this.writes.push({ kind: 'create', input, options });
    this.seq++;
    const page: KnowledgePage = {
      id: `page-${this.seq}`,
      page_type: input.pageType,
      slug: input.slug,
      title: input.title,
      content: input.content,
      aliases: input.aliases ? JSON.stringify(input.aliases) : null,
      tags: input.tags ? JSON.stringify(input.tags) : null,
      confidence: input.confidence ?? null,
      version: 1,
      status: input.status ?? 'active',
      created_at: Date.now(),
      updated_at: Date.now(),
      updated_by: 'system',
    };
    this.pages.set(this.key(page.page_type, page.slug), page);
    return {
      ok: true,
      id: page.id,
      slug: page.slug,
      pageType: page.page_type,
      version: page.version,
      status: page.status,
      created: true,
      danglingLinks: [],
    };
  }

  update(
    ref: { slug: string; pageType?: PageType } | { id: string },
    input: UpdateKnowledgePageInput,
    options: KnowledgeWriteOptions,
  ): KnowledgeWriteResult {
    if (this.refuse) return this.refuse;
    const existing = this.resolve(ref);
    if (!existing) return { ok: false, code: 'not_found', slug: 'slug' in ref ? ref.slug : ref.id };
    if (input.expectedVersion !== undefined && input.expectedVersion !== existing.version) {
      return {
        ok: false,
        code: 'version_conflict',
        currentVersion: existing.version,
        currentContent: existing.content,
      };
    }
    this.writes.push({ kind: 'update', input, options });
    const updated: KnowledgePage = {
      ...existing,
      title: input.title ?? existing.title,
      content: input.content ?? existing.content,
      aliases: input.aliases ? JSON.stringify(input.aliases) : existing.aliases,
      tags: input.tags ? JSON.stringify(input.tags) : existing.tags,
      confidence: input.confidence ?? existing.confidence,
      // `status` is only touched when the caller passes one — shadow mode must
      // not demote an already-approved page.
      status: input.status ?? existing.status,
      version: existing.version + 1,
      updated_at: Date.now(),
    };
    this.pages.set(this.key(updated.page_type, updated.slug), updated);
    return {
      ok: true,
      id: updated.id,
      slug: updated.slug,
      pageType: updated.page_type,
      version: updated.version,
      status: updated.status,
      created: false,
      danglingLinks: [],
    };
  }

  get(ref: { slug: string; pageType?: PageType } | { id: string }): KnowledgePageDetail | null {
    const page = this.resolve(ref);
    if (!page) return null;
    return { page, sources: [], links: [] };
  }

  search(): [] {
    return [];
  }

  list(): KnowledgePage[] {
    return [...this.pages.values()];
  }

  listPending(): KnowledgePage[] {
    return [...this.pages.values()].filter((page) => page.status === 'pending');
  }

  setStatus(id: string, status: KnowledgePageStatus): boolean {
    const page = [...this.pages.values()].find((candidate) => candidate.id === id);
    if (!page) return false;
    page.status = status;
    return true;
  }

  titlesForInjection(): Array<{ slug: string; title: string }> {
    return [];
  }

  linksOf(): KnowledgeLink[] {
    return [];
  }

  private resolve(
    ref: { slug: string; pageType?: PageType } | { id: string },
  ): KnowledgePage | undefined {
    if ('id' in ref) return [...this.pages.values()].find((page) => page.id === ref.id);
    if (ref.pageType) return this.pages.get(this.key(ref.pageType, ref.slug));
    return [...this.pages.values()].find((page) => page.slug === ref.slug);
  }
}

const logger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
} as unknown as Logger;

function config(overrides: Partial<KnowledgeCurateConfig> = {}): KnowledgeCurateConfig {
  return {
    enabled: true,
    mode: 'nightly',
    shadow: false,
    maxPagesPerRun: 5,
    requireSources: 2,
    minMemoryConfidence: 0.6,
    auxConfig: { modelRef: 'test-aux-model' },
    ...overrides,
  };
}

interface MemoryRow {
  id: string;
  content: string;
  kind?: string;
  scope?: string;
  scopeKey?: string;
  confidence?: number;
  createdAt?: number;
  status?: string;
}

describe('KnowledgeCurator', () => {
  let db: Database.Database;
  let service: FakeKnowledgeService;
  let llmCalls: AuxLLMCallOptions[];
  let responses: string[];
  const callLLM = async (options: AuxLLMCallOptions): Promise<string> => {
    llmCalls.push(options);
    const next = responses.shift();
    if (next === undefined) throw new Error('unscripted aux-LLM call');
    return next;
  };

  function insertMemory(row: MemoryRow): void {
    const createdAt = row.createdAt ?? Date.now();
    db.prepare(
      `INSERT INTO memories (id, scope, scope_key, kind, content, confidence, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      row.scope ?? 'user',
      row.scopeKey ?? 'u1',
      row.kind ?? 'fact',
      row.content,
      row.confidence ?? 0.9,
      row.status ?? 'active',
      String(createdAt),
      String(createdAt),
    );
  }

  /** A successful earlier run, so the window starts where the test wants it. */
  function recordSuccessfulRun(startedAt: number): void {
    db.prepare(
      `INSERT INTO maintenance_runs (id, job_name, status, started_at, affected_rows)
       VALUES (?, 'dreamcycle_knowledge_curate', 'success', ?, 1)`,
    ).run(`run-${startedAt}`, String(startedAt));
  }

  function grouping(groups: Array<{ subject: string; memoryIds: string[] }>): string {
    return JSON.stringify(groups);
  }

  function page(body: { title?: string; content?: string } = {}): string {
    return JSON.stringify({
      title: body.title ?? 'Power Query',
      content: body.content ?? 'Power Query replaced the manual VLOOKUP ETL.',
      tags: ['etl'],
      aliases: ['PQ'],
    });
  }

  function curator(
    overrides: Partial<KnowledgeCurateConfig> = {},
    withLLM = true,
  ): KnowledgeCurator {
    return new KnowledgeCurator({
      db,
      knowledgeService: service,
      logger,
      config: config(overrides),
      ...(withLLM ? { callLLM } : {}),
    });
  }

  beforeEach(() => {
    // The real migration chain, not `applySchema` alone: the curator reads
    // `knowledge_pages` for link targets, which migration v14 creates.
    db = openDatabase(':memory:');
    service = new FakeKnowledgeService();
    llmCalls = [];
    responses = [];
  });

  // ── Admission rules (§6 K2-3.2) ─────────────────────────────────────

  describe('admission', () => {
    it('rule 1: a group with no nameable subject is refused as no_subject', async () => {
      insertMemory({ id: 'm1', content: '用户偏好简洁的回答' });
      insertMemory({ id: 'm2', content: '用户偏好简洁的回答，不要长篇' });
      // A subject with nothing slugifiable cannot name a page.
      responses = [grouping([{ subject: '🙂', memoryIds: ['m1', 'm2'] }])];

      const report = await curator().run();

      expect(report.rejected.no_subject).toBe(1);
      expect(report.created + report.updated).toBe(0);
      // Only the grouping call was spent — no page call for a hopeless group.
      expect(llmCalls).toHaveLength(1);
      expect(service.writes).toHaveLength(0);
    });

    it('rule 2: a single source at night is refused as not_recurrent', async () => {
      insertMemory({ id: 'm1', content: 'Power Query replaced the manual VLOOKUP ETL' });
      responses = [grouping([{ subject: 'Power Query', memoryIds: ['m1'] }])];

      const report = await curator().run();

      expect(report.rejected.not_recurrent).toBe(1);
      expect(service.writes).toHaveLength(0);
      expect(llmCalls).toHaveLength(1);
    });

    it('rule 3: the same single source is admitted when the user asked for it', async () => {
      insertMemory({ id: 'm1', content: 'Power Query replaced the manual VLOOKUP ETL' });
      responses = [grouping([{ subject: 'Power Query', memoryIds: ['m1'] }]), page()];

      const report = await curator().run({ trigger: 'manual' });

      expect(report.rejected).toEqual({});
      expect(report.created).toBe(1);
      expect(service.writes[0].input.sources).toEqual([{ kind: 'memory', id: 'm1' }]);
    });

    it('counts recurrence across windows, not just the current one', async () => {
      // The night before: the same subject from a different memory.
      recordSuccessfulRun(Date.now() - 24 * 60 * 60 * 1000);
      insertMemory({
        id: 'm-old',
        content: 'Power Query is how the team does the monthly ETL',
        createdAt: Date.now() - 48 * 60 * 60 * 1000,
      });
      insertMemory({ id: 'm-new', content: 'Power Query replaced the manual VLOOKUP ETL' });
      responses = [grouping([{ subject: 'Power Query', memoryIds: ['m-new'] }]), page()];

      const report = await curator().run();

      // m-old is outside the window but is still a source: recurrence is a
      // property of the memory table, not of one night's slice.
      expect(report.candidates).toBe(1);
      expect(report.created).toBe(1);
      expect(service.writes[0].input.sources).toEqual(
        expect.arrayContaining([
          { kind: 'memory', id: 'm-new' },
          { kind: 'memory', id: 'm-old' },
        ]),
      );
    });

    it('passes the service refusal through by reason', async () => {
      insertMemory({ id: 'm1', content: 'Power Query replaced the manual VLOOKUP ETL' });
      insertMemory({ id: 'm2', content: 'Power Query is used for all ETL here' });
      responses = [grouping([{ subject: 'Power Query', memoryIds: ['m1', 'm2'] }]), page()];
      service.refuse = {
        ok: false,
        code: 'admission_rejected',
        reason: 'not_requested',
        detail: 'the user never asked for this page',
      };

      const report = await curator().run();

      expect(report.rejected.not_requested).toBe(1);
      expect(report.created).toBe(0);
    });

    it('evaluateAdmission implements at least 2 of 3 rules', () => {
      const subject = 'Power Query';
      // Rule 1 missing → refused regardless of the other two.
      expect(
        evaluateAdmission({ subject: '', sourceCount: 5, explicitRequest: true }, 2)?.reason,
      ).toBe('no_subject');
      // Rule 1 + 2.
      expect(evaluateAdmission({ subject, sourceCount: 2, explicitRequest: false }, 2)).toBeNull();
      // Rule 1 + 3.
      expect(evaluateAdmission({ subject, sourceCount: 1, explicitRequest: true }, 2)).toBeNull();
      // Rule 1 only.
      expect(
        evaluateAdmission({ subject, sourceCount: 1, explicitRequest: false }, 2)?.reason,
      ).toBe('not_recurrent');
      // A threshold of 0 still demands one source: a page with no source is the
      // anti-hallucination gate the whole layer exists for.
      expect(
        evaluateAdmission({ subject, sourceCount: 0, explicitRequest: false }, 0)?.reason,
      ).toBe('not_recurrent');
    });
  });

  // ── Write path ──────────────────────────────────────────────────────

  describe('writes', () => {
    it('creates an active page with actor=system and admission enforced', async () => {
      insertMemory({ id: 'm1', content: 'Power Query replaced the manual VLOOKUP ETL' });
      insertMemory({ id: 'm2', content: 'Power Query is used for all ETL here' });
      responses = [grouping([{ subject: 'Power Query', memoryIds: ['m1', 'm2'] }]), page()];

      const report = await curator().run();

      expect(report.created).toBe(1);
      expect(service.writes[0].kind).toBe('create');
      expect(service.writes[0].options).toEqual({
        actor: 'system',
        enforceAdmission: true,
        // The nightly pass is not a user request: admission rule 3 must not be
        // satisfied by it. `explicitRequest` states that without lying about
        // the actor, which is what the `manual`/`share` routes set to true.
        explicitRequest: false,
      });
      const input = service.writes[0].input as CreateKnowledgePageInput;
      expect(input.slug).toBe('power-query');
      expect(input.pageType).toBe('topic');
      expect(input.status).toBe('active');
      expect(input.title).toBe('Power Query');
      // Conservative: the page is only as trustworthy as its weakest source.
      expect(input.confidence).toBe(0.9);
    });

    it('a re-run on the same topic updates that page instead of creating a second one', async () => {
      insertMemory({ id: 'm1', content: 'Power Query replaced the manual VLOOKUP ETL' });
      insertMemory({ id: 'm2', content: 'Power Query is used for all ETL here' });
      responses = [grouping([{ subject: 'Power Query', memoryIds: ['m1', 'm2'] }]), page()];
      await curator().run();
      expect(service.pages.size).toBe(1);

      insertMemory({ id: 'm3', content: 'Power Query also handles the weekly ETL' });
      responses = [
        grouping([{ subject: 'power query', memoryIds: ['m3'] }]),
        page({ content: 'Power Query handles the monthly and weekly ETL.' }),
      ];
      const second = await curator().run();

      expect(second.updated).toBe(1);
      expect(second.created).toBe(0);
      expect(service.pages.size).toBe(1);
      const update = service.writes[1];
      expect(update.kind).toBe('update');
      expect((update.input as UpdateKnowledgePageInput).expectedVersion).toBe(1);
      expect((update.input as UpdateKnowledgePageInput).content).toContain('weekly ETL');
    });

    it('stops at max_pages_per_run', async () => {
      const subjects = ['Alpha Tool', 'Beta Tool', 'Gamma Tool'];
      subjects.forEach((subject, index) => {
        insertMemory({ id: `m${index}a`, content: `${subject} is used for reporting` });
        insertMemory({ id: `m${index}b`, content: `${subject} is the reporting standard` });
      });
      responses = [
        grouping(
          subjects.map((subject, index) => ({
            subject,
            memoryIds: [`m${index}a`, `m${index}b`],
          })),
        ),
        page(),
        page(),
        page(),
      ];

      const report = await curator({ maxPagesPerRun: 2 }).run();

      expect(report.groups).toBe(3);
      expect(report.created).toBe(2);
      expect(service.writes).toHaveLength(2);
      // The third group never reached the page call.
      expect(llmCalls).toHaveLength(3);
    });

    it('shadow mode writes pending pages and never flips an approved one', async () => {
      insertMemory({ id: 'm1', content: 'Power Query replaced the manual VLOOKUP ETL' });
      insertMemory({ id: 'm2', content: 'Power Query is used for all ETL here' });
      responses = [grouping([{ subject: 'Power Query', memoryIds: ['m1', 'm2'] }]), page()];

      await curator({ shadow: true }).run();

      const input = service.writes[0].input as CreateKnowledgePageInput;
      expect(input.status).toBe('pending');
      expect(service.listPending()).toHaveLength(1);
      // Nothing flips it afterwards: approval is `setStatus`, not the curator.
      expect(service.pages.get('topic:power-query')?.status).toBe('pending');

      // Re-running in shadow mode updates the same page without demoting or
      // promoting it.
      responses = [grouping([{ subject: 'Power Query', memoryIds: ['m1', 'm2'] }]), page()];
      await curator({ shadow: true }).run();
      const update = service.writes[1].input as UpdateKnowledgePageInput;
      expect(update.status).toBeUndefined();
      expect(service.pages.get('topic:power-query')?.status).toBe('pending');
    });

    it('aborts between pages when the signal fires', async () => {
      const controller = new AbortController();
      insertMemory({ id: 'm1', content: 'Alpha Tool is used for reporting' });
      insertMemory({ id: 'm2', content: 'Alpha Tool is the reporting standard' });
      insertMemory({ id: 'm3', content: 'Beta Tool is used for billing' });
      insertMemory({ id: 'm4', content: 'Beta Tool is the billing standard' });
      responses = [
        grouping([
          { subject: 'Alpha Tool', memoryIds: ['m1', 'm2'] },
          { subject: 'Beta Tool', memoryIds: ['m3', 'm4'] },
        ]),
        page(),
      ];

      // Abort while the first page call is in flight — the run must finish that
      // page and stop, never leave a half-written one.
      const abortingCall = async (options: AuxLLMCallOptions): Promise<string> => {
        const value = await callLLM(options);
        if (llmCalls.length === 2) controller.abort();
        return value;
      };
      const runReport: CurateRunReport = await new KnowledgeCurator({
        db,
        knowledgeService: service,
        logger,
        config: config(),
        callLLM: abortingCall,
      }).run({ signal: controller.signal });

      expect(runReport.aborted).toBe(true);
      expect(runReport.created).toBe(1);
      expect(service.writes).toHaveLength(1);
    });

    it('keeps pages already written when a later group fails', async () => {
      insertMemory({ id: 'm1', content: 'Alpha Tool is used for reporting' });
      insertMemory({ id: 'm2', content: 'Alpha Tool is the reporting standard' });
      insertMemory({ id: 'm3', content: 'Beta Tool is used for billing' });
      insertMemory({ id: 'm4', content: 'Beta Tool is the billing standard' });
      responses = [
        grouping([
          { subject: 'Alpha Tool', memoryIds: ['m1', 'm2'] },
          { subject: 'Beta Tool', memoryIds: ['m3', 'm4'] },
        ]),
        page(),
        'not json at all',
      ];

      const report = await curator().run();

      expect(report.created).toBe(1);
      expect(report.failed).toBe(1);
      expect(service.pages.size).toBe(1);
    });
  });

  // ── Catch-up (§9.4 rule 3) ──────────────────────────────────────────

  describe('catch-up', () => {
    it('curates memories from a night the device slept through', async () => {
      const threeDaysAgo = Date.now() - 3 * 24 * 60 * 60 * 1000;
      recordSuccessfulRun(threeDaysAgo);
      // Both memories are older than a nightly window but newer than the last
      // successful run — the missed nights are caught up, not lost.
      insertMemory({
        id: 'm1',
        content: 'Power Query replaced the manual VLOOKUP ETL',
        createdAt: threeDaysAgo + 60 * 60 * 1000,
      });
      insertMemory({
        id: 'm2',
        content: 'Power Query is used for all ETL here',
        createdAt: threeDaysAgo + 2 * 60 * 60 * 1000,
      });
      responses = [grouping([{ subject: 'Power Query', memoryIds: ['m1', 'm2'] }]), page()];

      const report = await curator().run();

      expect(report.since).toBe(threeDaysAgo);
      expect(report.candidates).toBe(2);
      expect(report.created).toBe(1);
    });

    it('ignores memories created before the last successful run', async () => {
      const lastRun = Date.now() - 24 * 60 * 60 * 1000;
      recordSuccessfulRun(lastRun);
      insertMemory({
        id: 'm-old',
        content: 'Power Query replaced the manual VLOOKUP ETL',
        createdAt: lastRun - 60 * 60 * 1000,
      });

      const report = await curator().run();

      expect(report.candidates).toBe(0);
      expect(report.skipped).toBe('no_candidates');
      expect(llmCalls).toHaveLength(0);
    });

    it('a failed previous run does not advance the window', async () => {
      const lastSuccess = Date.now() - 3 * 24 * 60 * 60 * 1000;
      recordSuccessfulRun(lastSuccess);
      db.prepare(
        `INSERT INTO maintenance_runs (id, job_name, status, started_at, error)
         VALUES ('failed-run', 'dreamcycle_knowledge_curate', 'failed', ?, 'aux model down')`,
      ).run(String(Date.now() - 60 * 60 * 1000));

      const report = await curator().run();

      expect(report.since).toBe(lastSuccess);
    });

    it('filters candidates by kind, status and confidence', async () => {
      insertMemory({ id: 'm-fact', content: 'Alpha Tool is used for reporting' });
      insertMemory({ id: 'm-pref', content: 'Alpha Tool is preferred', kind: 'preference' });
      insertMemory({ id: 'm-scene', content: 'Alpha Tool session digest', kind: 'scene' });
      insertMemory({ id: 'm-low', content: 'Alpha Tool is maybe used', confidence: 0.2 });
      insertMemory({ id: 'm-gone', content: 'Alpha Tool was dropped', status: 'deleted' });

      responses = [grouping([])];
      const report = await curator().run();

      expect(report.candidates).toBe(2);
      // The grouping prompt saw exactly the two eligible memories.
      expect(llmCalls[0].userPrompt).toContain('m-fact');
      expect(llmCalls[0].userPrompt).toContain('m-pref');
      expect(llmCalls[0].userPrompt).not.toContain('m-scene');
      expect(llmCalls[0].userPrompt).not.toContain('m-low');
      expect(llmCalls[0].userPrompt).not.toContain('m-gone');
    });
  });

  // ── Switches ────────────────────────────────────────────────────────

  describe('switches', () => {
    beforeEach(() => {
      insertMemory({ id: 'm1', content: 'Power Query replaced the manual VLOOKUP ETL' });
    });

    it('is inert when the knowledge layer is disabled', async () => {
      const report = await curator({ enabled: false }).run();
      expect(report.skipped).toBe('disabled');
      expect(llmCalls).toHaveLength(0);
    });

    it('is inert when curate.mode is off', async () => {
      const report = await curator({ mode: 'off' }).run();
      expect(report.skipped).toBe('disabled');
      expect(llmCalls).toHaveLength(0);
    });

    it('does not curate at night when curate.mode is manual', async () => {
      const report = await curator({ mode: 'manual' }).run({ trigger: 'nightly' });
      expect(report.skipped).toBe('mode_manual');
      expect(llmCalls).toHaveLength(0);
    });

    it('treats max_pages_per_run 0 as off', async () => {
      const report = await curator({ maxPagesPerRun: 0 }).run();
      expect(report.skipped).toBe('disabled');
    });

    it('skips when no aux model is configured', async () => {
      const report = await curator({ auxConfig: undefined }, false).run();
      expect(report.skipped).toBe('no_aux_model');
    });
  });

  // ── Prompt parsing ──────────────────────────────────────────────────

  describe('parsing', () => {
    it('drops hallucinated memory ids and duplicate subjects', () => {
      const groups = parseGroupingResponse(
        JSON.stringify([
          { subject: 'Power Query', memoryIds: ['m1', 'm-made-up'] },
          { subject: 'power query', memoryIds: ['m2'] },
          // Same page identity once slugified — a second group would spend an
          // aux call to overwrite the page the first one just wrote.
          { subject: 'Power-Query', memoryIds: ['m2'] },
          { subject: '   ', memoryIds: ['m3'] },
          { subject: 'Excel ETL', memoryIds: [] },
        ]),
        new Set(['m1', 'm2', 'm3']),
      );

      expect(groups).toEqual([{ subject: 'Power Query', memoryIds: ['m1'] }]);
    });

    it('accepts fenced JSON and a {groups: []} envelope', () => {
      const fenced = parseGroupingResponse(
        '```json\n{"groups":[{"subject":"Power Query","memory_ids":["m1"]}]}\n```',
        new Set(['m1']),
      );
      expect(fenced).toEqual([{ subject: 'Power Query', memoryIds: ['m1'] }]);
    });

    it('rejects a page response without a title or body', () => {
      expect(parsePageResponse('{"title":"x"}')).toBeNull();
      expect(parsePageResponse('no json here')).toBeNull();
      expect(
        parsePageResponse('{"title":"Power Query","content":"body","tags":["a","a","b"]}'),
      ).toEqual({ title: 'Power Query', content: 'body', tags: ['a', 'b'], aliases: [] });
    });
  });
});
