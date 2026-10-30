import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { Logger } from 'pino';
import { openDatabase } from '../../src/memory/db.js';
import {
  KnowledgeCurator,
  buildKnowledgeCurateConfig,
  countCurateCandidates,
  countIndependentSources,
  curateWindowStart,
  evaluateAdmission,
  parseGroupingResponse,
  parsePageResponse,
  type CurateRunReport,
  type CurateSource,
  type KnowledgeCurateConfig,
  mergeGroups,
} from '../../src/memory/knowledge/curate.js';
import type {
  KnowledgePageDetail,
  KnowledgeService,
  KnowledgeWriteOptions,
  KnowledgeWriteResult,
} from '../../src/memory/knowledge/service-contract.js';
import type {
  CreateKnowledgePageInput,
  KnowledgeBacklink,
  KnowledgeLink,
  KnowledgePage,
  KnowledgePageStatus,
  PageType,
  UpdateKnowledgePageInput,
} from '../../src/memory/knowledge/types.js';
import type { AuxLLMCallOptions } from '../../src/memory/aux-llm-client.js';
import { isVisibleInScope, normalizeScope } from '../../src/memory/knowledge/scope.js';

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

  /** `page_type:scope:slug` — the identity the real table's unique index has. */
  private key(pageType: string, slug: string, scope: string): string {
    return `${pageType}:${normalizeScope(scope)}:${slug}`;
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
      entity_id: null,
      tags: input.tags ? JSON.stringify(input.tags) : null,
      confidence: input.confidence ?? null,
      version: 1,
      status: input.status ?? 'active',
      scope: normalizeScope(options.scope),
      created_at: Date.now(),
      updated_at: Date.now(),
      updated_by: 'system',
    };
    this.pages.set(this.key(page.page_type, page.slug, page.scope), page);
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
    const existing = this.resolve(ref, options.scope);
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
    // The scope is the address, not part of the patch: an update rewrites the
    // page it found and never moves it to another conversation.
    this.pages.set(this.key(updated.page_type, updated.slug, updated.scope), updated);
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

  get(
    ref: { slug: string; pageType?: PageType } | { id: string },
    options?: { scope?: string },
  ): KnowledgePageDetail | null {
    const page = this.resolve(ref, options?.scope);
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

  backlinks(): KnowledgeBacklink[] {
    return [];
  }

  /** The read rule of `scope.ts`: own scope plus `global`, own scope first. */
  private resolve(
    ref: { slug: string; pageType?: PageType } | { id: string },
    scope?: string,
  ): KnowledgePage | undefined {
    const candidates = [...this.pages.values()].filter((page) => {
      if ('id' in ref) return page.id === ref.id;
      if (ref.pageType && page.page_type !== ref.pageType) return false;
      return page.slug === ref.slug;
    });
    const visible =
      scope === undefined
        ? candidates
        : candidates.filter((page) => isVisibleInScope(page.scope, scope));
    return visible.sort((a, b) => Number(a.scope === 'global') - Number(b.scope === 'global'))[0];
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
      // Each row defaults to its own conversation: admission counts conversations,
      // not rows, so a test that wants recurrence must share a `scopeKey` on
      // purpose instead of getting it from the helper by accident.
      row.scopeKey ?? `session-${row.id}`,
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

    // ── Window and backfill (`pnpm knowledge:curate`) ────────────────────

    it('cannot reach a historical window on its own: a first run looks back one night', async () => {
      // The reference install's shape: the newest memory is six weeks old, so the
      // 24h first-run window holds nothing and every run records a success with
      // zero candidates — which is why the page layer never started.
      const old = Date.now() - 60 * 24 * 60 * 60 * 1000;
      insertMemory({
        id: 'm-old',
        content: 'Power Query replaced the manual VLOOKUP ETL',
        createdAt: old,
      });

      const report = await curator().run();

      expect(report.candidates).toBe(0);
      expect(report.skipped).toBe('no_candidates');
      // No model call is spent on an empty window.
      expect(llmCalls).toHaveLength(0);
      expect(report.since).toBeGreaterThan(old);
      expect(countCurateCandidates(db, { since: report.since, minConfidence: 0.6 })).toBe(0);
    });

    it('curates that window when `since` overrides the nightly cursor', async () => {
      const old = Date.now() - 60 * 24 * 60 * 60 * 1000;
      insertMemory({
        id: 'm-old-1',
        content: 'Power Query replaced the manual VLOOKUP ETL',
        createdAt: old,
      });
      // A different conversation: admission rule 2 counts conversations, so two
      // rows in one chat would still be one source.
      insertMemory({
        id: 'm-old-2',
        content: 'Power Query is how the team does the monthly ETL',
        createdAt: old + 1000,
        scopeKey: 'session-other',
      });
      responses = [
        grouping([{ subject: 'Power Query', memoryIds: ['m-old-1', 'm-old-2'] }]),
        page(),
      ];

      const report = await curator().run({ trigger: 'manual', since: old - 1 });

      expect(report.since).toBe(old - 1);
      expect(report.candidates).toBe(2);
      expect(report.created).toBe(1);
      // The backfill door does not change what admission accepts.
      expect(service.writes[0].options.enforceAdmission).toBe(true);
    });

    it('reports the window the nightly cursor names, and a count that is not the batch', async () => {
      const since = Date.now() - 60 * 24 * 60 * 60 * 1000;
      recordSuccessfulRun(since);
      expect(curateWindowStart(db)).toBe(since);

      for (let index = 0; index < 3; index++) {
        insertMemory({
          id: `m-${index}`,
          content: 'Power Query ETL notes',
          createdAt: since + index,
        });
      }
      // Below the confidence floor the curator ignores it; the dry-run count is
      // built from the same predicate, so it must ignore it too.
      insertMemory({
        id: 'm-low',
        content: 'Power Query ETL notes',
        createdAt: since + 10,
        confidence: 0.1,
      });

      expect(countCurateCandidates(db, { since, minConfidence: 0.6 })).toBe(3);
      // A window is not a batch: one run reads at most `CANDIDATE_LIMIT` of them,
      // which is why `--rounds` exists instead of a silent "done".
      expect(countCurateCandidates(db, { since, minConfidence: 0.6 })).toBeGreaterThan(0);
    });

    it('sends the window in batches, so a reasoning model can finish its answer', async () => {
      // Measured: five memories give a clean JSON array, twenty exhaust the
      // completion on deliberation and answer with prose only. Sixty gave 12.7k
      // characters of reasoning and no JSON at all — the window must be chunked.
      for (let index = 0; index < 25; index++) {
        insertMemory({
          id: `m-${String(index).padStart(2, '0')}`,
          content: `Power Query ETL note number ${index}`,
        });
      }
      responses = ['[]', '[]', '[]'];

      const report = await curator().run();

      expect(report.candidates).toBe(25);
      // 25 candidates at a batch size of 10.
      expect(llmCalls).toHaveLength(3);
      expect(llmCalls.map((call) => call.userPrompt.split('\n').length)).toEqual([10, 10, 5]);
      expect(report.skipped).toBe('no_groups');
    });

    it('merges a subject named in two batches instead of buying two pages', async () => {
      for (let index = 0; index < 12; index++) {
        insertMemory({
          id: `m-${String(index).padStart(2, '0')}`,
          content: `Power Query ETL note number ${index}`,
        });
      }
      responses = [
        // Batch 1 names Power Query; batch 2 names it again (same slug).
        grouping([{ subject: 'Power Query', memoryIds: ['m-00', 'm-01'] }]),
        grouping([{ subject: 'Power Query ', memoryIds: ['m-10', 'm-11'] }]),
        page(),
      ];

      const report = await curator().run();

      expect(report.groups).toBe(1);
      expect(report.created).toBe(1);
      // Two grouping calls, one page call: the merge saved the second page.
      expect(llmCalls).toHaveLength(3);
      // Sources span the whole subject, not just the group's own ids (that is the
      // recurrence rule), so the merge is what these four prove: ids from both
      // batches reached one page.
      expect(service.writes[0].input.sources).toEqual(
        expect.arrayContaining([
          { kind: 'memory', id: 'm-00' },
          { kind: 'memory', id: 'm-01' },
          { kind: 'memory', id: 'm-10' },
          { kind: 'memory', id: 'm-11' },
        ]),
      );
    });

    it('mergeGroups unions ids under one slug and keeps first-seen subject spelling', () => {
      const merged = mergeGroups([
        { subject: 'Power Query', memoryIds: ['a', 'b'] },
        { subject: 'power-query', memoryIds: ['b', 'c'] },
        { subject: 'Termux', memoryIds: ['d'] },
      ]);

      expect(merged).toEqual([
        { subject: 'Power Query', memoryIds: ['a', 'b', 'c'] },
        { subject: 'Termux', memoryIds: ['d'] },
      ]);
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

  // ── Source independence (plan §8 S3) ────────────────────────────────

  /**
   * One conversation is one source, however many times it restated the subject.
   * The summary path writes a new `summary` memory every `summarize_interval`
   * messages, so counting rows let a single chat satisfy `require_sources: 2` with
   * its own paraphrase — recurrence degenerated into "the string appeared twice".
   */
  describe('source independence', () => {
    function twoSummariesOfOneSession(): void {
      const conversation = { scope: 'session', scopeKey: 'feishu:oc_chat' };
      insertMemory({
        id: 'm1',
        ...conversation,
        kind: 'summary',
        content: 'Power Query replaced the manual VLOOKUP ETL',
      });
      insertMemory({
        id: 'm2',
        ...conversation,
        kind: 'summary',
        content: 'Power Query also handles the weekly ETL',
      });
    }

    it('two summaries of one session are one source, so the group stays below the threshold', async () => {
      twoSummariesOfOneSession();
      responses = [grouping([{ subject: 'Power Query', memoryIds: ['m1', 'm2'] }])];

      const report = await curator().run();

      expect(report.rejected.not_recurrent).toBe(1);
      expect(service.writes).toHaveLength(0);
      // Only the grouping call was spent: the refusal happens before the page call.
      expect(llmCalls).toHaveLength(1);
    });

    it('two different sessions are two sources, so the page is admitted', async () => {
      insertMemory({
        id: 'm1',
        scope: 'session',
        scopeKey: 'feishu:oc_chat',
        kind: 'summary',
        content: 'Power Query replaced the manual VLOOKUP ETL',
      });
      insertMemory({
        id: 'm2',
        scope: 'user',
        scopeKey: 'telegram:42',
        kind: 'fact',
        content: 'Power Query is used for all ETL here',
      });
      responses = [grouping([{ subject: 'Power Query', memoryIds: ['m1', 'm2'] }]), page()];

      const report = await curator().run();

      expect(report.rejected).toEqual({});
      expect(report.created).toBe(1);
      // Both rows are still cited: dedupe changes the *count*, never the
      // provenance the page is written with.
      expect(service.writes[0].input.sources).toEqual([
        { kind: 'memory', id: 'm1' },
        { kind: 'memory', id: 'm2' },
      ]);
    });

    it('an explicit request still bypasses the source count', async () => {
      twoSummariesOfOneSession();
      responses = [grouping([{ subject: 'Power Query', memoryIds: ['m1', 'm2'] }]), page()];

      const report = await curator().run({ trigger: 'manual' });

      expect(report.rejected).toEqual({});
      expect(report.created).toBe(1);
      expect(service.writes[0].options.explicitRequest).toBe(true);
    });

    it('countIndependentSources keys on the conversation, not the citation', () => {
      const memory = (id: string, conversationKey: string | null): CurateSource => ({
        kind: 'memory',
        id,
        content: 'Power Query',
        scope: 'session',
        confidence: 0.9,
        conversationKey,
      });
      // One conversation restating itself twice — one source.
      expect(countIndependentSources([memory('m1', 'chat-a'), memory('m2', 'chat-a')])).toBe(1);
      // Two conversations — two sources.
      expect(countIndependentSources([memory('m1', 'chat-a'), memory('m2', 'chat-b')])).toBe(2);
      // A citation with no conversation is its own source rather than merging
      // with every other anonymous row.
      expect(countIndependentSources([memory('m1', null), memory('m2', 'chat-a')])).toBe(2);
      expect(countIndependentSources([])).toBe(0);
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
      expect(service.pages.get('topic:global:power-query')?.status).toBe('pending');

      // Re-running in shadow mode updates the same page without demoting or
      // promoting it.
      responses = [grouping([{ subject: 'Power Query', memoryIds: ['m1', 'm2'] }]), page()];
      await curator({ shadow: true }).run();
      const update = service.writes[1].input as UpdateKnowledgePageInput;
      expect(update.status).toBeUndefined();
      expect(service.pages.get('topic:global:power-query')?.status).toBe('pending');
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

  // ── Scope (migration-v22) ───────────────────────────────────────────

  /**
   * The curator is the main path pages arrive by, so it is the main way one
   * chat's knowledge could leak into another: a page written with no scope is
   * readable in every chat, and a lookup with no scope finds — and rewrites —
   * the page another chat wrote for the same subject.
   */
  describe('scope', () => {
    const CHAT_A = 'feishu:oc_a';
    const CHAT_B = 'telegram:42';

    function twoSources(): void {
      insertMemory({ id: 'm1', content: 'Power Query replaced the manual VLOOKUP ETL' });
      insertMemory({ id: 'm2', content: 'Power Query is used for all ETL here' });
    }

    it('writes the page into the conversation the run was given', async () => {
      twoSources();
      responses = [grouping([{ subject: 'Power Query', memoryIds: ['m1', 'm2'] }]), page()];

      await curator().run({ trigger: 'manual', scope: CHAT_A });

      expect(service.writes[0].options.scope).toBe(CHAT_A);
      expect(service.pages.get(`topic:${CHAT_A}:power-query`)?.scope).toBe(CHAT_A);
    });

    it('leaves the scope unset when there is no conversation (the nightly phase)', async () => {
      twoSources();
      responses = [grouping([{ subject: 'Power Query', memoryIds: ['m1', 'm2'] }]), page()];

      await curator().run();

      // Omitted, not invented: the service normalises it to `global`, and the
      // nightly pass has no chat to scope to.
      expect(service.writes[0].options.scope).toBeUndefined();
      expect(service.pages.get('topic:global:power-query')?.scope).toBe('global');
    });

    it('a re-run in one chat updates that chat’s page, not another chat’s', async () => {
      twoSources();
      responses = [grouping([{ subject: 'Power Query', memoryIds: ['m1', 'm2'] }]), page()];
      await curator().run({ trigger: 'manual', scope: CHAT_A });

      // The same subject curated from a second chat is a second page: the
      // lookup is addressed, so chat A's page is not even a candidate.
      responses = [
        grouping([{ subject: 'power query', memoryIds: ['m1'] }]),
        page({ content: 'Chat B’s own take on Power Query.' }),
      ];
      const fromB = await curator().run({ trigger: 'manual', scope: CHAT_B });

      expect(fromB.created).toBe(1);
      expect(fromB.updated).toBe(0);
      expect(service.pages.size).toBe(2);
      expect(service.pages.get(`topic:${CHAT_A}:power-query`)?.version).toBe(1);
      expect(service.pages.get(`topic:${CHAT_B}:power-query`)?.version).toBe(1);

      // ...and a re-run back in chat A updates chat A's page, with its version.
      responses = [grouping([{ subject: 'Power Query', memoryIds: ['m1'] }]), page()];
      const again = await curator().run({ trigger: 'manual', scope: CHAT_A });

      expect(again.updated).toBe(1);
      expect(service.pages.size).toBe(2);
      expect(service.pages.get(`topic:${CHAT_A}:power-query`)?.version).toBe(2);
      expect(service.pages.get(`topic:${CHAT_B}:power-query`)?.version).toBe(1);
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
