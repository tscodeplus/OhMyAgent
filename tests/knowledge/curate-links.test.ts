/**
 * Curation has to *produce* the page graph, not just be able to store one.
 *
 * `knowledge_links` is a projection of the body (`repository.writeLinks`), so
 * before the page call was told which pages already exist, a model had no slug to
 * write and no curated page could ever carry a link: the table was a mechanism
 * with no producer. These tests pin the two halves of that fix against the real
 * service and the real database — the prompt now offers addresses, and the link
 * that comes back is stored.
 *
 * The dangling case is the other half of the same rule: a link to a page nobody
 * wrote yet is *reported*, not refused (`knowledge_log` + a `missing` entry on
 * read), while a citation that does not resolve still refuses the whole write.
 * Those two gates must not be confused with each other.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { Logger } from 'pino';
import {
  KnowledgeCurator,
  type CurateRunReport,
  type KnowledgeCurateConfig,
} from '../../src/memory/knowledge/curate.js';
import type { KnowledgeService } from '../../src/memory/knowledge/service-contract.js';
import type { CreateKnowledgePageInput, KnowledgePage } from '../../src/memory/knowledge/types.js';
import type { AuxLLMCallOptions } from '../../src/memory/aux-llm-client.js';
import { MEMORY_C, openSeededDatabase, knowledgeService } from './fixtures.js';

const logger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
} as unknown as Logger;

/** Fixture memories are five months old; the curation window is one night. */
const NOW = Date.now();
const GROUP_MEMORY = 'memory-links-excel-etl';
const TOPIC_MEMORY = 'memory-links-power-query';

const TARGET_SLUG = 'power-query-etl';
const TARGET_TITLE = 'Power Query ETL';
const PENDING_SLUG = 'not-yet-approved';
const CURATED_SLUG = 'excel-etl';
const MISSING_TARGET = 'topic/not-written-yet';

const BODY = [
  'Excel ETL is the weekly Power Query pipeline.',
  `It replaced the process described in [[topic/${TARGET_SLUG}]].`,
  `The [[${MISSING_TARGET}]] page does not exist yet.`,
].join('\n');

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

describe('curation writes the page graph', () => {
  let db: Database.Database;
  let service: KnowledgeService;
  let llmCalls: AuxLLMCallOptions[];
  let responses: string[];
  /** Runs once, before the page call answers — i.e. after the sources are gathered. */
  let beforePageCall: (() => void) | null;
  let targetPageId: string;
  let pendingPageId: string;

  const callLLM = async (options: AuxLLMCallOptions): Promise<string> => {
    llmCalls.push(options);
    if (llmCalls.length % 2 === 0 && beforePageCall) {
      const hook = beforePageCall;
      beforePageCall = null;
      hook();
    }
    const next = responses.shift();
    if (next === undefined) throw new Error('unscripted aux-LLM call');
    return next;
  };

  function insertMemory(id: string, content: string): void {
    db.prepare(
      `INSERT INTO memories (id, scope, scope_key, kind, content, confidence, status, created_at, updated_at)
       VALUES (?, 'user', 'u1', 'fact', ?, 0.9, 'active', ?, ?)`,
    ).run(id, content, String(NOW), String(NOW));
  }

  /** A page written the way a user writes one: admission is not enforced. */
  function createPage(input: CreateKnowledgePageInput): KnowledgePage {
    const result = service.create(input, { actor: 'user' });
    if (!result.ok) throw new Error(`fixture page refused: ${result.code}`);
    const detail = service.get({ id: result.id });
    if (!detail) throw new Error('fixture page is not readable');
    return detail.page;
  }

  function curate(): Promise<CurateRunReport> {
    return new KnowledgeCurator({
      db,
      knowledgeService: service,
      logger,
      config: config(),
      callLLM,
    }).run({ trigger: 'manual' });
  }

  function script(groupSubject: string, body: string): void {
    responses = [
      JSON.stringify([{ subject: groupSubject, memoryIds: [GROUP_MEMORY] }]),
      JSON.stringify({
        title: 'Excel ETL',
        content: body,
        tags: ['etl'],
        aliases: [],
      }),
    ];
  }

  function linkRows(pageId: string): string[] {
    return (
      db.prepare('SELECT to_page_id FROM knowledge_links WHERE from_page_id = ?').all(pageId) as {
        to_page_id: string;
      }[]
    ).map((row) => row.to_page_id);
  }

  function linkLogReasons(pageId: string): string[] {
    return (
      db
        .prepare("SELECT reason FROM knowledge_log WHERE page_id = ? AND action = 'link'")
        .all(pageId) as { reason: string | null }[]
    ).map((row) => row.reason ?? '');
  }

  beforeEach(() => {
    db = openSeededDatabase();
    service = knowledgeService(db);
    llmCalls = [];
    responses = [];
    beforePageCall = null;

    targetPageId = createPage({
      pageType: 'topic',
      slug: TARGET_SLUG,
      title: TARGET_TITLE,
      content: 'Power Query replaced the manual VLOOKUP.',
      sources: [{ kind: 'memory', id: MEMORY_C }],
    }).id;

    // Shadow-mode output: a page nobody approved yet must not be offered as a
    // link target, because it is not readable either.
    pendingPageId = createPage({
      pageType: 'topic',
      slug: PENDING_SLUG,
      title: 'Not yet approved',
      content: 'Draft curation.',
      sources: [{ kind: 'memory', id: MEMORY_C }],
    }).id;
    service.setStatus(pendingPageId, 'pending', 'system');

    insertMemory(GROUP_MEMORY, 'Excel ETL 走 Power Query + Python 清洗');
    insertMemory(TOPIC_MEMORY, 'Power Query replaced the manual VLOOKUP ETL');
  });

  afterEach(() => {
    db.close();
  });

  it('offers the existing pages as link targets and stores the link it got back', async () => {
    script('Excel ETL', BODY);

    const report = await curate();

    expect(report.created).toBe(1);
    expect(report.failed).toBe(0);

    // The prompt is the producer: without an address, no wikilink is ever written.
    const pageCall = llmCalls[1];
    expect(llmCalls).toHaveLength(2);
    expect(pageCall.systemPrompt).toContain('EXISTING PAGES');
    expect(pageCall.userPrompt).toContain('EXISTING PAGES:');
    expect(pageCall.userPrompt).toContain(`[[topic/${TARGET_SLUG}]] — ${TARGET_TITLE}`);
    // Titles and slugs only — another page's body would be an uncited source.
    expect(pageCall.userPrompt).not.toContain('Power Query replaced the manual VLOOKUP.');
    // A pending page is invisible to search, injection and link resolution, so it
    // is not a legal target either.
    expect(pageCall.userPrompt).not.toContain(PENDING_SLUG);

    const detail = service.get({ slug: CURATED_SLUG });
    expect(detail).not.toBeNull();
    expect(detail?.page.status).toBe('active');
    expect(detail?.page.content).toBe(BODY);
    expect(linkRows(detail!.page.id)).toEqual([targetPageId]);
  });

  it('saves a page whose link points at nothing and reports the target as dangling', async () => {
    script('Excel ETL', BODY);

    const report = await curate();

    // A citation graph is allowed to be incomplete: the write is not refused.
    expect(report.created).toBe(1);
    expect(report.rejected).toEqual({});

    const page = service.get({ slug: CURATED_SLUG })!.page;
    expect(linkLogReasons(page.id).join(' ')).toContain(MISSING_TARGET);
    expect(linkRows(page.id)).toEqual([targetPageId]);

    // Link resolution neither throws nor hides the missing target.
    const resolved = () => service.get({ slug: CURATED_SLUG });
    expect(resolved).not.toThrow();
    expect(resolved()!.links).toEqual([
      { slug: `topic/${TARGET_SLUG}`, label: null, missing: false },
      { slug: MISSING_TARGET, label: null, missing: true },
    ]);
  });

  it('never offers the page being written as one of its own link targets', async () => {
    script('Excel ETL', BODY);
    const first = await curate();
    expect(first.created).toBe(1);

    script('Excel ETL', `${BODY}\nUpdated with the June numbers.`);
    const second = await curate();

    expect(second.updated).toBe(1);
    // Calls 1-2 are the first run; the second run's page call is #4.
    const rerunPageCall = llmCalls[3];
    expect(rerunPageCall.userPrompt).toContain(`[[topic/${TARGET_SLUG}]]`);
    expect(rerunPageCall.userPrompt).not.toContain(`[[topic/${CURATED_SLUG}]]`);
  });

  it('still refuses the whole write when a cited source no longer exists', async () => {
    script('Excel ETL', BODY);
    // The memories disappear between gathering and writing, which is exactly the
    // race the anti-hallucination gate exists for. A dangling `[[wikilink]]` is
    // permitted; a citation that cannot be checked is not.
    beforePageCall = () => {
      db.prepare('DELETE FROM memories WHERE content LIKE ?').run('%Excel ETL%');
    };

    const report = await curate();

    expect(report.created + report.updated).toBe(0);
    expect(report.rejected).toEqual({ unknown_sources: 1 });
    expect(service.get({ slug: CURATED_SLUG })).toBeNull();
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM knowledge_links').get() as { count: number },
    ).toEqual({ count: 0 });
  });
});

/**
 * The conversation a curated page belongs to (migration-v22).
 *
 * Curation is the main path pages arrive by, so it is the main way one chat's
 * knowledge could become another chat's answer. These assertions are the
 * writer's side of `scope-isolation.test.ts`: the page lands in the scope the
 * run was given, a chat that was not there cannot find it, the nightly pass
 * still writes `global`, and the same subject in two chats is two pages rather
 * than one page the second chat silently rewrote.
 */
describe('curation writes into the conversation it came from', () => {
  const CHAT_A = 'feishu:oc_a';
  const CHAT_B = 'telegram:42';
  const SUBJECT = 'Excel ETL';
  const SLUG = 'excel-etl';
  const SOURCE = 'memory-scope-excel';

  let db: Database.Database;
  let service: KnowledgeService;
  let llmCalls: AuxLLMCallOptions[];
  let responses: string[];

  const callLLM = async (options: AuxLLMCallOptions): Promise<string> => {
    llmCalls.push(options);
    const next = responses.shift();
    if (next === undefined) throw new Error('unscripted aux-LLM call');
    return next;
  };

  function script(body = 'Excel ETL 走 Power Query + Python 清洗。'): void {
    responses = [
      JSON.stringify([{ subject: SUBJECT, memoryIds: [SOURCE] }]),
      JSON.stringify({ title: SUBJECT, content: body, tags: ['etl'], aliases: [] }),
    ];
  }

  /** `scope` omitted is the nightly phase: no conversation, so `global`. */
  function curate(options: { scope?: string; trigger?: 'manual' | 'nightly' } = {}) {
    return new KnowledgeCurator({
      db,
      knowledgeService: service,
      logger,
      config: config(),
      callLLM,
    }).run(options);
  }

  function scopes(): string[] {
    return (
      db.prepare('SELECT scope FROM knowledge_pages ORDER BY scope').all() as { scope: string }[]
    ).map((row) => row.scope);
  }

  beforeEach(() => {
    db = openSeededDatabase();
    service = knowledgeService(db);
    llmCalls = [];
    responses = [];
    db.prepare(
      `INSERT INTO memories (id, scope, scope_key, kind, content, confidence, status, created_at, updated_at)
       VALUES (?, 'user', 'u1', 'fact', ?, 0.9, 'active', ?, ?)`,
    ).run(SOURCE, `${SUBJECT} 走 Power Query + Python 清洗`, String(NOW), String(NOW));
  });

  afterEach(() => {
    db.close();
  });

  it('stores the page in the scope the run was given, invisible to another chat', async () => {
    script();

    const report = await curate({ scope: CHAT_A, trigger: 'manual' });

    expect(report.created).toBe(1);
    expect(scopes()).toEqual([CHAT_A]);
    expect(service.search('Excel', { scope: CHAT_A }).map((hit) => hit.slug)).toContain(SLUG);
    // The whole point: a page distilled in one group chat is not an answer in
    // every other chat on the same database.
    expect(service.search('Excel', { scope: CHAT_B })).toEqual([]);
  });

  it('still writes global when the run has no conversation (the nightly phase)', async () => {
    script();

    await curate({ trigger: 'nightly' });

    expect(scopes()).toEqual(['global']);
    // A console/global page stays readable everywhere — the read rule is
    // "own scope plus global", never equality.
    expect(service.search('Excel', { scope: CHAT_B }).map((hit) => hit.slug)).toContain(SLUG);
  });

  it('gives each chat its own page for one subject instead of rewriting the other', async () => {
    script('Chat A wrote this.');
    await curate({ scope: CHAT_A, trigger: 'manual' });

    script('Chat B wrote this.');
    const fromB = await curate({ scope: CHAT_B, trigger: 'manual' });

    expect(fromB.created).toBe(1);
    expect(fromB.updated).toBe(0);
    expect(scopes()).toEqual([CHAT_A, CHAT_B]);
    expect(service.get({ slug: SLUG }, { scope: CHAT_A })?.page.content).toBe('Chat A wrote this.');
    expect(service.get({ slug: SLUG }, { scope: CHAT_B })?.page.content).toBe('Chat B wrote this.');
  });

  it('does not offer another chat’s page as a link target', async () => {
    for (const [slug, scope] of [
      ['chat-a-only', CHAT_A],
      ['global-only', 'global'],
    ] as const) {
      const result = service.create(
        {
          pageType: 'topic',
          slug,
          title: slug,
          content: 'A page this run may or may not be able to address.',
          sources: [{ kind: 'memory', id: SOURCE }],
        },
        { actor: 'user', scope },
      );
      if (!result.ok) throw new Error(`fixture page refused: ${result.code}`);
    }

    script();
    await curate({ scope: CHAT_B, trigger: 'manual' });

    const pageCall = llmCalls[1];
    expect(pageCall.userPrompt).toContain('[[topic/global-only]]');
    // Chat A's page is not readable from chat B, so it is not an addressable
    // target: offering it would put another chat's slug into this page's body.
    expect(pageCall.userPrompt).not.toContain('chat-a-only');
  });
});
