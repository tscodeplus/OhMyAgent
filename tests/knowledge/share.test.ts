/**
 * The share entry point — a message becoming a knowledge page (plan §6 K2-5,
 * third entry point).
 *
 * What these tests pin down is not "a page got written" but *how*: a shared
 * message is curated by `KnowledgeCurator.curateMessage`, which shares the
 * grouping → page → `writeGroups` path and the single `KnowledgeService` write
 * call with the nightly pass. So the assertions are about the invariants that
 * sharing would quietly break if it had its own writer:
 *
 *   - the shared message is a citation of the page it produced (`message`
 *     provenance, not just `memory`), and shadow mode still lands it `pending`;
 *   - `curate.mode: off` / `knowledge.enabled: false` refuse with a skip reason
 *     instead of spending an aux-LLM call or throwing into the chat path;
 *   - identical group input yields identical page rows from either route.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import {
  handleCommand,
  setKnowledgeCuratorResolver,
  type CommandDeps,
} from '../../src/commands/command-handler.js';
import { KnowledgeCurator, type KnowledgeCurateConfig } from '../../src/memory/knowledge/curate.js';
import { createKnowledgeService } from '../../src/memory/knowledge/service.js';
import type { KnowledgeService } from '../../src/memory/knowledge/service-contract.js';
import type { AuxLLMCallOptions } from '../../src/memory/aux-llm-client.js';
import { i18n } from '../../src/i18n/index.js';
import { MESSAGE_ID, SESSION_ID, openSeededDatabase } from './fixtures.js';

const logger = { debug() {}, info() {}, warn() {}, error() {} } as never;

/** The fixture message: a user message about a nameable subject. */
const SHARED_MESSAGE = MESSAGE_ID;
/** A shared link arrives as a user message whose content is/contains the URL. */
const LINK_MESSAGE = 'message-share-link';
const LINK_MESSAGE_CONTENT = 'Excel 里我们用 Power Query 清洗数据 https://example.com/power-query';

/**
 * `/knowledge` reads nothing but the knowledge deps, but `CommandDeps` is a
 * single object type — the agent-service slice is stubbed so a missing field
 * cannot hide behind `as never`.
 */
function commandDeps(overrides: Partial<CommandDeps> = {}): CommandDeps {
  return {
    agentService: {
      abort: vi.fn(async () => undefined),
      isRunning: vi.fn(() => false),
      reset: vi.fn(() => true),
      destroyRuntime: vi.fn(() => true),
      rejectPendingApprovals: vi.fn(() => 0),
      resolveFirstPendingApproval: vi.fn(() => false),
      resolveAllPendingApprovals: vi.fn(() => 0),
      rejectPendingQuestions: vi.fn(() => 0),
      resolveUserQuestion: vi.fn(() => false),
      resolveFirstPendingQuestion: vi.fn(() => false),
      steer: vi.fn(() => true),
      followUp: vi.fn(async () => true),
      swapCard: vi.fn(async () => true),
      onNextAgentEnd: vi.fn(),
      setSessionAgentId: vi.fn(),
    },
    ...overrides,
  };
}

interface Harness {
  db: Database.Database;
  service: KnowledgeService;
  curator(overrides?: Partial<KnowledgeCurateConfig>): KnowledgeCurator;
  /** Queue the next aux-LLM answers, in call order. */
  script(...answers: string[]): void;
  llmCalls: AuxLLMCallOptions[];
}

function harness(
  config: { shadow?: boolean; curator?: Partial<KnowledgeCurateConfig> } = {},
): Harness {
  const shadow = config.shadow ?? false;
  const db = openSeededDatabase();
  const service = createKnowledgeService({ db, config: { shadow } });
  const responses: string[] = [];
  const llmCalls: AuxLLMCallOptions[] = [];

  const callLLM = async (options: AuxLLMCallOptions): Promise<string> => {
    llmCalls.push(options);
    const next = responses.shift();
    if (next === undefined) throw new Error('unscripted aux-LLM call');
    return next;
  };

  return {
    db,
    service,
    llmCalls,
    script(...answers: string[]) {
      responses.push(...answers);
    },
    curator(overrides = {}) {
      return new KnowledgeCurator({
        db,
        knowledgeService: service,
        logger,
        config: {
          enabled: true,
          // `manual` is the mode the share command exists for: the nightly phase
          // stays off, the user-triggered entry points stay on.
          mode: 'manual',
          // The curator decides the status it writes (`curate.shadow`), so the
          // service's own shadow flag is not what a curation page follows.
          shadow,
          maxPagesPerRun: 5,
          requireSources: 2,
          minMemoryConfidence: 0.6,
          ...config.curator,
          ...overrides,
        },
        callLLM,
      });
    },
  };
}

/** One grouping answer and one page answer: the shape of any single-page run. */
function onePageAnswers(
  subject: string,
  citedIds: string[],
  body = 'Power Query 替代了手工 VLOOKUP。',
): string[] {
  return [
    JSON.stringify([{ subject, memoryIds: citedIds }]),
    JSON.stringify({ title: subject, content: body, tags: ['excel'], aliases: [] }),
  ];
}

function pageSources(db: Database.Database, pageId: string): string[] {
  const rows = db
    .prepare(
      'SELECT source_kind, source_id FROM knowledge_sources WHERE page_id = ? ORDER BY source_kind, source_id',
    )
    .all(pageId) as Array<{ source_kind: string; source_id: string }>;
  return rows.map((row) => `${row.source_kind}:${row.source_id}`);
}

describe('curateMessage — a shared message becomes a page', () => {
  let h: Harness;

  beforeEach(() => {
    // `shadow: true` is the cautious gateway: a curated page waits for review.
    h = harness({ shadow: true });
  });

  afterEach(() => {
    setKnowledgeCuratorResolver(() => undefined);
    h.db.close();
  });

  it('writes at most one pending page citing the shared message', async () => {
    h.script(...onePageAnswers('Power Query', [SHARED_MESSAGE]));

    const report = await h.curator().curateMessage(SHARED_MESSAGE);

    expect(report.skipped).toBeUndefined();
    expect(report.created).toBe(1);
    expect(report.updated).toBe(0);

    const pending = h.service.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      slug: 'power-query',
      page_type: 'topic',
      title: 'Power Query',
      status: 'pending',
      updated_by: 'system',
    });
    // A shadow page is not knowledge yet: nothing active, so nothing searchable.
    expect(h.service.list({ status: 'active' })).toEqual([]);

    // Provenance: the message that was shared *and* the memories that already
    // know the subject — the page answers "where did this come from".
    expect(pageSources(h.db, pending[0].id)).toEqual([
      `memory:memory-knowledge-a`,
      `memory:memory-knowledge-b`,
      `message:${SHARED_MESSAGE}`,
    ]);
  });

  it('resolves a URL to the user message that contains it', async () => {
    h.db
      .prepare(
        `INSERT INTO messages (id, session_id, role, content, created_at)
         VALUES (?, ?, 'user', ?, ?)`,
      )
      .run(LINK_MESSAGE, SESSION_ID, LINK_MESSAGE_CONTENT, String(Date.now()));
    h.script(...onePageAnswers('Power Query', [LINK_MESSAGE]));

    const report = await h.curator().curateMessage('https://example.com/power-query');

    expect(report.created).toBe(1);
    // The page cites the message the URL resolved to, not the URL string.
    expect(pageSources(h.db, h.service.listPending()[0].id)).toContain(`message:${LINK_MESSAGE}`);
  });

  it('writes one page even when the model proposes several subjects for one message', async () => {
    h.script(
      JSON.stringify([
        { subject: 'Power Query', memoryIds: [SHARED_MESSAGE] },
        { subject: 'Excel', memoryIds: [SHARED_MESSAGE] },
      ]),
      JSON.stringify({ title: 'Power Query', content: 'A body.', tags: [], aliases: [] }),
    );

    const report = await h.curator().curateMessage(SHARED_MESSAGE);

    expect(report.groups).toBe(2);
    expect(report.created).toBe(1);
    expect(h.service.listPending()).toHaveLength(1);
  });

  it('skips with a reason when the reference matches no user message', async () => {
    const report = await h.curator().curateMessage('no-such-message');

    expect(report.skipped).toBe('message_not_found');
    expect(h.llmCalls).toHaveLength(0);
    expect(h.service.listPending()).toEqual([]);
  });
});

describe('curateMessage — degradation', () => {
  let h: Harness;

  afterEach(() => {
    setKnowledgeCuratorResolver(() => undefined);
    h.db.close();
  });

  it('refuses with the same skip reason as the nightly pass when curate.mode is off', async () => {
    h = harness({ curator: { mode: 'off' } });
    h.script(...onePageAnswers('Power Query', [SHARED_MESSAGE]));

    const report = await h.curator().curateMessage(SHARED_MESSAGE);

    expect(report.skipped).toBe('disabled');
    // Not one aux-LLM token is spent on a frozen curation layer.
    expect(h.llmCalls).toHaveLength(0);
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM knowledge_pages').get()).toEqual({ n: 0 });
  });

  it('refuses when the knowledge layer itself is disabled', async () => {
    h = harness({ curator: { enabled: false } });
    h.script(...onePageAnswers('Power Query', [SHARED_MESSAGE]));

    const report = await h.curator().curateMessage(SHARED_MESSAGE);

    expect(report.skipped).toBe('disabled');
    expect(h.llmCalls).toHaveLength(0);
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM knowledge_pages').get()).toEqual({ n: 0 });
  });

  it('answers /knowledge share with a sentence when the layer is off', async () => {
    // `knowledge.enabled: false` means no service is wired at all — the command
    // has to say so rather than fail on the missing dependency.
    h = harness();

    const result = await handleCommand(`/knowledge share ${SHARED_MESSAGE}`, 's1', commandDeps());

    expect(result!.reply).toBe(i18n.t('commands:knowledge.disabled'));
  });

  it('answers /knowledge share with a sentence when no curator is wired', async () => {
    h = harness();

    const result = await handleCommand(
      `/knowledge share ${SHARED_MESSAGE}`,
      's1',
      commandDeps({ knowledgeService: h.service }),
    );

    expect(result!.reply).toBe(i18n.t('commands:knowledge.curateUnavailable'));
  });
});

describe('/knowledge share', () => {
  let h: Harness;

  beforeEach(() => {
    h = harness({ shadow: true });
  });

  afterEach(() => {
    setKnowledgeCuratorResolver(() => undefined);
    h.db.close();
  });

  it('reports a pending page by address so the user knows to approve it', async () => {
    const curator = h.curator();
    setKnowledgeCuratorResolver(() => curator);
    h.script(...onePageAnswers('Power Query', [SHARED_MESSAGE]));

    const result = await handleCommand(
      `/knowledge share ${SHARED_MESSAGE}`,
      's1',
      commandDeps({ knowledgeService: h.service }),
    );

    expect(result!.reply).toBe(
      i18n.t('commands:knowledge.shareDonePending', {
        address: 'topic/power-query',
        title: 'Power Query',
      }),
    );
    expect(h.service.listPending()).toHaveLength(1);
  });

  it('reports an unknown reference instead of failing silently', async () => {
    setKnowledgeCuratorResolver(() => h.curator());

    const result = await handleCommand(
      '/knowledge share nope',
      's1',
      commandDeps({ knowledgeService: h.service }),
    );

    expect(result!.reply).toBe(i18n.t('commands:knowledge.shareMessageNotFound', { ref: 'nope' }));
  });

  it('answers a missing reference with the usage line and spends nothing', async () => {
    setKnowledgeCuratorResolver(() => h.curator());

    const result = await handleCommand(
      '/knowledge share',
      's1',
      commandDeps({ knowledgeService: h.service }),
    );

    expect(result!.reply).toBe(i18n.t('commands:knowledge.shareUsage'));
    expect(h.llmCalls).toHaveLength(0);
  });
});

describe('nightly and share are one write path', () => {
  const NOW = Date.now();
  const SUBJECT = 'Homelab Backup';
  const PAGE_BODY = 'Nightly restic to the NAS, verified weekly.';
  const SHARED_ID = 'message-share-1';

  /**
   * Same fixtures on both sides: two memories about one subject, one page answer.
   * The only difference is which reference each route curates from.
   */
  function seedMemories(db: Database.Database): void {
    const insert = db.prepare(
      `INSERT INTO memories (id, scope, scope_key, kind, content, confidence, created_at, updated_at)
       VALUES (?, 'user', 'user-knowledge', 'fact', ?, 0.9, ?, ?)`,
    );
    insert.run(
      'memory-homelab-1',
      `${SUBJECT} runs restic to the NAS nightly`,
      String(NOW),
      String(NOW),
    );
    insert.run(
      'memory-homelab-2',
      `${SUBJECT} keeps 30 dailies and 12 monthlies`,
      String(NOW),
      String(NOW),
    );
  }

  function seedSharedMessage(db: Database.Database): void {
    db.prepare(
      `INSERT INTO messages (id, session_id, role, content, created_at)
       VALUES (?, ?, 'user', ?, ?)`,
    ).run(SHARED_ID, SESSION_ID, `${SUBJECT} https://example.com/homelab`, String(NOW));
  }

  /** Every column that is the page's content rather than its identity or clock. */
  function pageRows(db: Database.Database): unknown[] {
    return db
      .prepare(
        `SELECT page_type, slug, title, content, aliases, tags, confidence, version, status, updated_by
           FROM knowledge_pages`,
      )
      .all();
  }

  it('produces identical rows for identical group input', async () => {
    // Route 1: the nightly pass over the window's memories.
    const nightlySide = harness({ shadow: true, curator: { mode: 'nightly' } });
    seedMemories(nightlySide.db);
    nightlySide.script(
      ...onePageAnswers(SUBJECT, ['memory-homelab-1', 'memory-homelab-2'], PAGE_BODY),
    );
    const nightlyReport = await nightlySide.curator().run({ trigger: 'nightly' });

    // Route 2: the same subject, reached from one shared message.
    const shareSide = harness({ shadow: true });
    seedMemories(shareSide.db);
    seedSharedMessage(shareSide.db);
    shareSide.script(...onePageAnswers(SUBJECT, [SHARED_ID], PAGE_BODY));
    const shareReport = await shareSide.curator().curateMessage(SHARED_ID);

    try {
      expect(nightlyReport.created).toBe(1);
      expect(shareReport.created).toBe(1);

      // Same page: same identity, same body, same admission outcome, same shadow
      // status, same author. Had the share flow grown a writer of its own, one of
      // these columns would differ.
      expect(pageRows(shareSide.db)).toEqual(pageRows(nightlySide.db));

      // ...and the only difference is the citation the share flow brought with it.
      expect(pageSources(nightlySide.db, nightlySide.service.listPending()[0].id)).toEqual([
        'memory:memory-homelab-1',
        'memory:memory-homelab-2',
      ]);
      expect(pageSources(shareSide.db, shareSide.service.listPending()[0].id)).toEqual([
        'memory:memory-homelab-1',
        'memory:memory-homelab-2',
        `message:${SHARED_ID}`,
      ]);
    } finally {
      nightlySide.db.close();
      shareSide.db.close();
    }
  });
});
