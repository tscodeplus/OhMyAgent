/**
 * `/knowledge` — the explicit-instruction entry point into the knowledge layer
 * (plan §6 K2-5).
 *
 * The command is a thin shell over `KnowledgeService`, so what these tests pin
 * down is the shell: `list` and `pending` must not show the same pages (a
 * shadow-mode page in a browse list reads as a confirmed fact), `approve` is
 * what moves one across that boundary, and a gateway with the layer switched
 * off answers with a sentence instead of throwing on the missing dependency.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import {
  handleCommand,
  setKnowledgeCuratorResolver,
  type CommandDeps,
} from '../../src/commands/command-handler.js';
import type { KnowledgeService } from '../../src/memory/knowledge/service-contract.js';
import type { CreateKnowledgePageInput } from '../../src/memory/knowledge/types.js';
import { KnowledgeCurator, type KnowledgeCurateConfig } from '../../src/memory/knowledge/curate.js';
import type { AuxLLMCallOptions } from '../../src/memory/aux-llm-client.js';
import { createKnowledgeService } from '../../src/memory/knowledge/service.js';
import { i18n } from '../../src/i18n/index.js';
import { TWO_MEMORY_SOURCES, openSeededDatabase } from './fixtures.js';

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

function pageInput(overrides: Partial<CreateKnowledgePageInput> = {}): CreateKnowledgePageInput {
  return {
    pageType: 'topic',
    slug: 'excel-etl',
    title: 'Excel ETL',
    content: '用 Power Query 替代手工 VLOOKUP，数据清洗走一条流水线。',
    sources: TWO_MEMORY_SOURCES,
    ...overrides,
  };
}

describe('/knowledge command', () => {
  let db: Database.Database;
  let service: KnowledgeService;

  beforeEach(() => {
    db = openSeededDatabase();
    // `shadow: true` is the gateway that has curation review switched on: a
    // curated write lands in `pending`, a user write stays `active`.
    service = createKnowledgeService({ db, config: { shadow: true } });
  });

  afterEach(() => {
    db.close();
  });

  function seedActivePage(): string {
    const result = service.create(pageInput(), { actor: 'user' });
    if (!result.ok) throw new Error(`seed failed: ${result.code}`);
    return result.id;
  }

  function seedPendingPage(): string {
    const result = service.create(pageInput({ slug: 'pending-page', title: 'Pending page' }), {
      actor: 'agent',
      enforceAdmission: true,
    });
    if (!result.ok) throw new Error(`seed failed: ${result.code}`);
    if (result.status !== 'pending') throw new Error('fixture expected a pending page');
    return result.id;
  }

  it('list shows active pages and never a pending one', async () => {
    seedActivePage();
    seedPendingPage();

    const result = await handleCommand(
      '/knowledge list',
      's1',
      commandDeps({ knowledgeService: service }),
    );

    expect(result!.reply).toContain('topic/excel-etl');
    expect(result!.reply).toContain('Excel ETL');
    expect(result!.reply).not.toContain('topic/pending-page');
  });

  it('bare /knowledge behaves like list', async () => {
    seedActivePage();

    const result = await handleCommand(
      '/knowledge',
      's1',
      commandDeps({ knowledgeService: service }),
    );

    expect(result!.reply).toContain('topic/excel-etl');
  });

  it('list says so when there are no pages', async () => {
    const result = await handleCommand(
      '/knowledge list',
      's1',
      commandDeps({ knowledgeService: service }),
    );

    expect(result!.reply).toBe(i18n.t('commands:knowledge.empty'));
  });

  it('pending is the only place a shadow page shows up, with the id approve takes', async () => {
    seedActivePage();
    const pendingId = seedPendingPage();

    const result = await handleCommand(
      '/knowledge pending',
      's1',
      commandDeps({ knowledgeService: service }),
    );

    expect(result!.reply).toContain(pendingId);
    expect(result!.reply).toContain('topic/pending-page');
    expect(result!.reply).not.toContain('topic/excel-etl');
  });

  it('pending is empty when nothing awaits review', async () => {
    seedActivePage();

    const result = await handleCommand(
      '/knowledge pending',
      's1',
      commandDeps({ knowledgeService: service }),
    );

    expect(result!.reply).toBe(i18n.t('commands:knowledge.noPending'));
  });

  it('approve moves a pending page into the active listing', async () => {
    const pendingId = seedPendingPage();
    const deps = commandDeps({ knowledgeService: service });

    const approved = await handleCommand(`/knowledge approve ${pendingId}`, 's1', deps);
    expect(approved!.reply).toBe(i18n.t('commands:knowledge.approved', { id: pendingId }));

    const pending = await handleCommand('/knowledge pending', 's1', deps);
    expect(pending!.reply).toBe(i18n.t('commands:knowledge.noPending'));

    const list = await handleCommand('/knowledge list', 's1', deps);
    expect(list!.reply).toContain('topic/pending-page');
  });

  it('approve reports an unknown id instead of failing silently', async () => {
    const result = await handleCommand(
      '/knowledge approve nope',
      's1',
      commandDeps({ knowledgeService: service }),
    );

    expect(result!.reply).toBe(i18n.t('commands:knowledge.approveNotFound', { id: 'nope' }));
  });

  it('show reads a page by address and by bare slug', async () => {
    seedActivePage();
    const deps = commandDeps({ knowledgeService: service });

    for (const ref of ['topic/excel-etl', 'excel-etl']) {
      const result = await handleCommand(`/knowledge show ${ref}`, 's1', deps);
      expect(result!.reply).toContain('Excel ETL');
      expect(result!.reply).toContain('Power Query');
      // Citations are printed: the page's provenance is part of what it says.
      expect(result!.reply).toContain('memory:memory-knowledge-a');
    }
  });

  it('show reports an unknown page', async () => {
    const result = await handleCommand(
      '/knowledge show topic/ghost',
      's1',
      commandDeps({ knowledgeService: service }),
    );

    expect(result!.reply).toBe(i18n.t('commands:knowledge.pageNotFound', { ref: 'topic/ghost' }));
  });

  it('stats renders the counts the wiring point supplies', async () => {
    const result = await handleCommand(
      '/knowledge stats',
      's1',
      commandDeps({
        knowledgeService: service,
        knowledgeStats: () => ({
          total: 2,
          byStatus: { active: 1, pending: 1 },
          byPageType: { topic: 2 },
        }),
      }),
    );

    expect(result!.reply).toContain('2');
    expect(result!.reply).toContain('active 1');
    expect(result!.reply).toContain('pending 1');
    expect(result!.reply).toContain('topic 2');
  });

  it('stats says counts are unavailable when the wiring supplies none', async () => {
    const result = await handleCommand(
      '/knowledge stats',
      's1',
      commandDeps({ knowledgeService: service }),
    );

    expect(result!.reply).toBe(i18n.t('commands:knowledge.countsUnavailable'));
  });

  it('an unknown subcommand answers with the usage text', async () => {
    const result = await handleCommand(
      '/knowledge frobnicate',
      's1',
      commandDeps({ knowledgeService: service }),
    );

    expect(result!.reply).toBe(i18n.t('commands:knowledge.usage'));
  });

  // The disabled-layer path: `knowledge.enabled: false` (or a channel that never
  // wired the service) must answer, not crash on the missing dependency.
  it('degrades to a sentence when the knowledge layer is off', async () => {
    const commands = [
      '/knowledge',
      '/knowledge list',
      '/knowledge pending',
      '/knowledge stats',
      '/knowledge curate',
    ];
    for (const text of commands) {
      const result = await handleCommand(text, 's1', commandDeps());
      expect(result).not.toBeNull();
      expect(result!.reply).toBe(i18n.t('commands:knowledge.disabled'));
    }
  });
});

/**
 * `/knowledge curate` — the explicit-request entry point (plan §6 K2-5).
 *
 * It runs the same `KnowledgeCurator` the nightly phase runs, once and awaited,
 * with the `manual` trigger (which is admission rule 3: the user asked for a
 * page). What these tests pin down is that the edit path is the *page identity*
 * path: the second run of the same subject updates the page the first run wrote
 * instead of filing a twin, which is the engine's slug rule observed through the
 * command rather than through the engine.
 */
describe('/knowledge curate', () => {
  const NOW = Date.now();
  const SUBJECT = 'Homelab Backup';
  const MEMORY_IDS = ['memory-curate-a', 'memory-curate-b'];

  let db: Database.Database;
  let service: KnowledgeService;
  let responses: string[];
  let llmCalls: AuxLLMCallOptions[];

  const logger = { debug() {}, info() {}, warn() {}, error() {} } as never;

  const callLLM = async (options: AuxLLMCallOptions): Promise<string> => {
    llmCalls.push(options);
    const next = responses.shift();
    if (next === undefined) throw new Error('unscripted aux-LLM call');
    return next;
  };

  /** One grouping answer and one page answer: exactly one page per run. */
  function scriptOnePage(body = 'Nightly restic to the NAS, verified weekly.'): void {
    responses = [
      JSON.stringify([{ subject: SUBJECT, memoryIds: MEMORY_IDS }]),
      JSON.stringify({ title: SUBJECT, content: body, tags: ['ops'], aliases: [] }),
    ];
  }

  function curateConfig(overrides: Partial<KnowledgeCurateConfig> = {}): KnowledgeCurateConfig {
    return {
      enabled: true,
      // `manual` is the mode the command exists for; the nightly trigger is what
      // it keeps switched off.
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

  function curateDeps(): CommandDeps {
    return commandDeps({
      knowledgeService: service,
      knowledgeStats: () => ({ total: 0, byStatus: {}, byPageType: {} }),
    });
  }

  beforeEach(() => {
    db = openSeededDatabase();
    service = createKnowledgeService({ db, config: { shadow: false } });
    responses = [];
    llmCalls = [];

    // Two memories about one subject inside the curation window: admission rule 2
    // (≥ 2 independent sources) is what makes the page admissible.
    const insert = db.prepare(
      `INSERT INTO memories (id, scope, scope_key, kind, content, confidence, created_at, updated_at)
       VALUES (?, 'user', 'user-knowledge', 'fact', ?, 0.9, ?, ?)`,
    );
    insert.run(
      MEMORY_IDS[0],
      'Homelab Backup runs restic to the NAS nightly',
      String(NOW),
      String(NOW),
    );
    insert.run(
      MEMORY_IDS[1],
      'Homelab Backup keeps 30 dailies and 12 monthlies',
      String(NOW),
      String(NOW),
    );
  });

  afterEach(() => {
    setKnowledgeCuratorResolver(() => undefined);
    db.close();
  });

  it('creates a page, and a second run updates it instead of duplicating it', async () => {
    setKnowledgeCuratorResolver(() => curator());
    const deps = curateDeps();

    scriptOnePage('Nightly restic to the NAS, verified weekly.');
    const first = await handleCommand('/knowledge curate', 's1', deps);

    const afterFirst = service.list({ status: 'active' });
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0].slug).toBe('homelab-backup');
    expect(afterFirst[0].version).toBe(1);
    expect(first!.reply).toBe(
      i18n.t('commands:knowledge.curateDone', {
        created: 1,
        updated: 0,
        failed: 0,
        pages: '- `topic/homelab-backup` Homelab Backup',
      }),
    );

    // Same subject, so the same page identity: the run updates it (with
    // `expectedVersion`) rather than creating a second `homelab-backup`.
    scriptOnePage('Nightly restic to the NAS, verified weekly; offsite copy on Fridays.');
    const second = await handleCommand('/knowledge curate', 's1', deps);

    const afterSecond = service.list({ status: 'active' });
    expect(afterSecond).toHaveLength(1);
    expect(afterSecond[0].version).toBe(2);
    expect(afterSecond[0].content).toContain('offsite');
    expect(second!.reply).toBe(
      i18n.t('commands:knowledge.curateDone', {
        created: 0,
        updated: 1,
        failed: 0,
        pages: '- `topic/homelab-backup` Homelab Backup',
      }),
    );
  });

  it('reports a skipped run instead of curating when the layer is switched off', async () => {
    setKnowledgeCuratorResolver(() => curator({ enabled: false }));
    scriptOnePage();

    const result = await handleCommand('/knowledge curate', 's1', curateDeps());

    expect(result!.reply).toBe(i18n.t('commands:knowledge.curateSkipped', { reason: 'disabled' }));
    // Not one aux-LLM token was spent on a disabled layer.
    expect(llmCalls).toHaveLength(0);
    expect(service.list({ status: 'active' })).toHaveLength(0);
  });

  it('says curation is not wired when no curator resolves', async () => {
    const result = await handleCommand('/knowledge curate', 's1', curateDeps());

    expect(result!.reply).toBe(i18n.t('commands:knowledge.curateUnavailable'));
    expect(llmCalls).toHaveLength(0);
  });

  it('reports a run that wrote nothing as such, instead of a silent success', async () => {
    setKnowledgeCuratorResolver(() => curator());
    // A manual run counts every group as explicitly requested (admission rule 3),
    // so the refusal here is the page call itself: the model answered something
    // that is not a page, which is a failed group, not a page.
    responses = [JSON.stringify([{ subject: SUBJECT, memoryIds: MEMORY_IDS }]), 'not a page'];

    const result = await handleCommand('/knowledge curate', 's1', curateDeps());

    expect(result!.reply).toBe(
      i18n.t('commands:knowledge.curateNoPages', {
        rejected: i18n.t('commands:knowledge.none'),
        failed: 1,
      }),
    );
    expect(service.list({ status: 'active' })).toHaveLength(0);
  });

  it('answers a topic argument with the usage line and spends nothing', async () => {
    setKnowledgeCuratorResolver(() => curator());

    const result = await handleCommand('/knowledge curate homelab', 's1', curateDeps());

    expect(result!.reply).toBe(i18n.t('commands:knowledge.curateUsage'));
    expect(llmCalls).toHaveLength(0);
  });

  // The chat path is a channel send: a failed curation run has to come back as a
  // sentence, never as a rejected promise the channel cannot render.
  it('reports a failed run as a sentence instead of throwing', async () => {
    setKnowledgeCuratorResolver(() => curator());
    responses = []; // the grouping call is unscripted → it throws

    const result = await handleCommand('/knowledge curate', 's1', curateDeps());

    expect(result).not.toBeNull();
    expect(result!.reply).toBe(
      i18n.t('commands:knowledge.failed', { error: 'unscripted aux-LLM call' }),
    );
  });
});
