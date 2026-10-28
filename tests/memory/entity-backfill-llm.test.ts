/**
 * `entity_backfill` LLM pass (`src/memory/maintenance/jobs/entity-backfill-job.ts`).
 *
 * The job is the producer that regrows typed relations after the deterministic
 * keyword typing was removed: mention rows stay, and a model types the subset it
 * can attest. What is pinned here is the contract the graph depends on —
 *
 *   - a memory nobody has typed gets one model call and, when the model returns
 *     a relation the memory supports, a typed `memory_links` row that carries
 *     the memory's already-recorded subject (otherwise the projector skips it);
 *   - a memory that has been typed (or that this run already handled) is never
 *     sent again;
 *   - answers the projector's gates would refuse are not written, and are
 *     counted in `rejectedByGates` instead of disappearing;
 *   - no aux model, or `llm: false`, means exactly the pre-LLM behaviour and
 *     `llmAttempted: false`;
 *   - `max_memories_per_run` is a hard cap on model calls per run.
 *
 * The model is stubbed at `auxLLMCall`, the single boundary every aux task goes
 * through (`entity-extractor.extractEntitiesLLM` → `auxLLMCall`).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/memory/db';
import { MemoryLinkRepository } from '../../src/memory/repositories/memory-link-repository';
import { loadConfig, resetConfig, stopConfigWatcher } from '../../src/app/config';
import type { MaintenanceJobResult } from '../../src/memory/maintenance/maintenance-job';
import {
  createEntityBackfillJob,
  DEFAULT_ENTITY_EXTRACTION_JOB_CONFIG,
  type EntityBackfillJobOptions,
} from '../../src/memory/maintenance/jobs/entity-backfill-job';
import type { AuxModelConfig } from '../../src/memory/aux-llm-client';

const auxLLMCall = vi.fn();

vi.mock('../../src/memory/aux-llm-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/memory/aux-llm-client.js')>();
  return {
    ...actual,
    auxLLMCall: (...args: unknown[]) => auxLLMCall(...args),
  };
});

const AUX_CONFIG: AuxModelConfig = { modelRef: 'deepseek/deepseek-chat' };

/** A memory whose text attests `张伟 —ADVISES→ Acme` through the word 顾问. */
const ADVISES_TEXT = '张伟是Acme公司的顾问';

/**
 * Stand-in for the model: one JSON array per memory text. `extractEntitiesLLM`
 * parses the array with `parseLLMEntities`, so this is the same shape a real aux
 * model is asked for.
 */
function modelAnswers(answers: Record<string, Array<Record<string, unknown>>>) {
  auxLLMCall.mockImplementation(
    async (_config: unknown, options: { userPrompt: string; logger: unknown }) => {
      void options;
      const answer = answers[options.userPrompt];
      return JSON.stringify(answer ?? []);
    },
  );
}

describe('entity_backfill — LLM pass', () => {
  let db: Database.Database;
  let linkRepo: MemoryLinkRepository;

  beforeEach(() => {
    auxLLMCall.mockReset();
    db = openDatabase(':memory:');
    linkRepo = new MemoryLinkRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  function seedMemory(id: string, content: string, createdAt = Date.now()): void {
    db.prepare(
      `INSERT INTO memories (id, scope, scope_key, kind, content, status, created_at, updated_at)
       VALUES (?, 'user', 'user-1', 'fact', ?, 'active', ?, ?)`,
    ).run(id, content, String(createdAt), String(createdAt));
  }

  /**
   * A `MENTIONED` pair as the deterministic extractor would have left it: the
   * memory's subject row carries no subject (a memory is not its own entity),
   * and the related row names the subject.
   */
  function seedMention(
    id: string,
    memoryId: string,
    target: string,
    subject: string | null,
    confidence = 0.7,
  ): void {
    db.prepare(
      `INSERT INTO memory_links (id, source_memory_id, target_entity, relation_type, confidence,
                                 subject_entity, subject_entity_type, target_entity_type)
       VALUES (?, ?, ?, 'MENTIONED', ?, ?, ?, ?)`,
    ).run(
      id,
      memoryId,
      target,
      confidence,
      subject,
      subject === null ? null : 'concept',
      'concept',
    );
  }

  function runJob(options: Partial<EntityBackfillJobOptions> = {}): Promise<MaintenanceJobResult> {
    return createEntityBackfillJob(db, linkRepo, {
      config: DEFAULT_ENTITY_EXTRACTION_JOB_CONFIG,
      auxConfig: AUX_CONFIG,
      ...options,
    }).run({ dryRun: false });
  }

  function linkRows(memoryId: string): Array<{
    target_entity: string;
    relation_type: string;
    subject_entity: string | null;
    confidence: number;
  }> {
    return db
      .prepare(
        `SELECT target_entity, relation_type, subject_entity, confidence
         FROM memory_links WHERE source_memory_id = ? ORDER BY target_entity`,
      )
      .all(memoryId) as Array<{
      target_entity: string;
      relation_type: string;
      subject_entity: string | null;
      confidence: number;
    }>;
  }

  function typedCount(): number {
    const row = db
      .prepare(
        "SELECT COUNT(*) AS n FROM memory_links WHERE upper(trim(relation_type)) <> 'MENTIONED'",
      )
      .get() as { n: number };
    return row.n;
  }

  it('writes the typed relation a model returns for a memory that only has mentions', async () => {
    seedMemory('m1', ADVISES_TEXT);
    seedMention('l1', 'm1', '张伟', null);
    seedMention('l2', 'm1', 'Acme', '张伟');
    modelAnswers({
      [ADVISES_TEXT]: [{ entity: 'Acme', relation: 'ADVISES', confidence: 0.9 }],
    });

    const result = await runJob();

    const typed = linkRows('m1').filter((row) => row.relation_type === 'ADVISES');
    expect(typed).toEqual([
      { target_entity: 'Acme', relation_type: 'ADVISES', subject_entity: '张伟', confidence: 0.9 },
    ]);
    // The subject the producer already recorded is copied onto the new row: a
    // typed row without one is skipped by the projector (and mining will never
    // revisit a memory that already has a subject).
    expect(result.details).toMatchObject({
      llmAttempted: true,
      llmCalls: 1,
      typedLinksWritten: 1,
      rejectedByGates: 0,
      degradedReason: null,
    });
  });

  it('does not re-process a memory on a second run', async () => {
    seedMemory('m1', ADVISES_TEXT);
    seedMention('l1', 'm1', '张伟', null);
    seedMention('l2', 'm1', 'Acme', '张伟');
    modelAnswers({
      [ADVISES_TEXT]: [{ entity: 'Acme', relation: 'ADVISES', confidence: 0.9 }],
    });

    await runJob();
    const second = await runJob();

    expect(auxLLMCall).toHaveBeenCalledTimes(1);
    expect(second.details).toMatchObject({ llmAttempted: false, llmCalls: 0 });
    expect(typedCount()).toBe(1);
  });

  it('refuses an endpoint that is a fragment of the text and says so', async () => {
    const text = '请问如何称呼你比较合适';
    seedMemory('m1', text);
    // No subject recorded: the fragment gate and not the relation gate is what
    // has to refuse this answer.
    seedMention('l1', 'm1', '称呼', null);
    modelAnswers({ [text]: [{ entity: '何称', relation: 'ADVISES', confidence: 0.9 }] });

    const result = await runJob();

    expect(typedCount()).toBe(0);
    expect(result.details).toMatchObject({ rejectedByGates: 1, typedLinksWritten: 0 });
  });

  it('refuses a relation the memory does not attest and says so', async () => {
    // The measured false statement: the word 建议 lives inside the answer, so a
    // model that reports ADVISES on 周五 claims something no sentence states.
    const text = '穿衣建议：周五降温，注意保暖';
    seedMemory('m1', text);
    seedMention('l1', 'm1', '周五', '穿衣建议');
    modelAnswers({ [text]: [{ entity: '周五', relation: 'ADVISES', confidence: 0.9 }] });

    const result = await runJob();

    expect(typedCount()).toBe(0);
    expect(result.details).toMatchObject({ rejectedByGates: 1, typedLinksWritten: 0 });
  });

  it('keeps today’s behaviour with llm: false, and spends no model call', async () => {
    const text = '王小明是我的同事';
    seedMemory('m1', text);
    modelAnswers({ [text]: [{ entity: '王小明', relation: 'ATTENDED', confidence: 0.9 }] });

    const result = await runJob({
      config: { ...DEFAULT_ENTITY_EXTRACTION_JOB_CONFIG, llm: false },
    });

    expect(auxLLMCall).not.toHaveBeenCalled();
    // The deterministic pass is unchanged: the mention is still recorded.
    expect(linkRows('m1')).toEqual([
      {
        target_entity: '王小明',
        relation_type: 'MENTIONED',
        subject_entity: null,
        confidence: 0.75,
      },
    ]);
    expect(result.details).toMatchObject({
      llmAttempted: false,
      llmCalls: 0,
      llmCallBudget: 0,
      degradedReason: 'llm_disabled',
    });
  });

  it('keeps today’s behaviour with no aux model configured', async () => {
    const text = '王小明是我的同事';
    seedMemory('m1', text);

    const result = await runJob({ auxConfig: undefined });

    expect(auxLLMCall).not.toHaveBeenCalled();
    expect(linkRows('m1').map((row) => row.relation_type)).toEqual(['MENTIONED']);
    expect(result.details).toMatchObject({
      llmAttempted: false,
      llmCalls: 0,
      llmCallBudget: 0,
      degradedReason: 'no_aux_model',
    });
  });

  it('holds max_memories_per_run against 50 candidates', async () => {
    const answers: Record<string, Array<Record<string, unknown>>> = {};
    for (let i = 0; i < 50; i++) {
      const id = `m${i}`;
      const text = `张伟是Acme公司的顾问${'　'.repeat(i % 3)}`;
      seedMemory(id, text, Date.now() + i);
      seedMention(`${id}-s`, id, '张伟', null);
      seedMention(`${id}-t`, id, 'Acme', '张伟');
      answers[text] = [{ entity: 'Acme', relation: 'ADVISES', confidence: 0.9 }];
    }
    modelAnswers(answers);

    const result = await runJob({
      config: { ...DEFAULT_ENTITY_EXTRACTION_JOB_CONFIG, max_memories_per_run: 5 },
    });

    expect(auxLLMCall).toHaveBeenCalledTimes(5);
    expect(result.details).toMatchObject({
      llmCalls: 5,
      llmCallBudget: 5,
      llmAttempted: true,
      typedLinksWritten: 5,
    });
    expect(typedCount()).toBe(5);
  });

  it('skips memories shorter than the threshold without spending a call', async () => {
    seedMemory('m1', '好的');
    modelAnswers({ 好的: [{ entity: '好的', relation: 'ADVISES', confidence: 0.9 }] });

    const result = await runJob();

    expect(auxLLMCall).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({ llmCalls: 0, llmAttempted: false });
  });

  it('does not spend the LLM budget on memories the deterministic pass just handled', async () => {
    const answers: Record<string, Array<Record<string, unknown>>> = {};
    const now = Date.now();

    // Seven newer memories with no links at all: the deterministic pass gives
    // them mentions in this run, so they must not consume LLM budget.
    for (let i = 0; i < 7; i++) {
      seedMemory(`fresh-${i}`, '王小明是我的同事，人很靠谱', now + 1000 + i);
    }

    // Five older memories that already have mentions: the candidates the model
    // pass exists for.
    for (let i = 0; i < 5; i++) {
      const id = `old-${i}`;
      seedMemory(id, ADVISES_TEXT, now - 1000 - i);
      seedMention(`${id}-s`, id, '张伟', null);
      seedMention(`${id}-t`, id, 'Acme', '张伟');
    }
    answers[ADVISES_TEXT] = [{ entity: 'Acme', relation: 'ADVISES', confidence: 0.9 }];
    modelAnswers(answers);

    const result = await runJob({
      config: { ...DEFAULT_ENTITY_EXTRACTION_JOB_CONFIG, max_memories_per_run: 5 },
    });

    expect(auxLLMCall).toHaveBeenCalledTimes(5);
    expect(result.details).toMatchObject({ llmCalls: 5, typedLinksWritten: 5 });
  });

  it('reports candidates on a dry run without calling the model', async () => {
    seedMemory('m1', ADVISES_TEXT);
    seedMention('l1', 'm1', '张伟', null);
    seedMention('l2', 'm1', 'Acme', '张伟');

    const result = await createEntityBackfillJob(db, linkRepo, {
      config: DEFAULT_ENTITY_EXTRACTION_JOB_CONFIG,
      auxConfig: AUX_CONFIG,
    }).run({ dryRun: true });

    expect(auxLLMCall).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({ llmCandidates: 1, llmAttempted: false });
    expect(linkRows('m1')).toHaveLength(2);
  });
});

/**
 * The block the job is configured by. Pinned here because a config key zod
 * accepts but `buildMemorySection()` drops never reaches the job — it silently
 * falls back to the defaults, which is the failure mode this repo keeps hitting.
 */
describe('memory.entity_extraction config wiring', () => {
  let dir: string;

  beforeEach(() => {
    resetConfig();
    stopConfigWatcher();
    dir = mkdtempSync(join(tmpdir(), 'oma-entity-extraction-'));
  });

  afterEach(() => {
    stopConfigWatcher();
    resetConfig();
    rmSync(dir, { recursive: true, force: true });
  });

  function configFrom(yaml: string) {
    const path = join(dir, 'config.yaml');
    writeFileSync(path, yaml, 'utf8');
    return loadConfig({ CONFIG_FILE: path });
  }

  it('reads the block from config.yaml', () => {
    const config = configFrom(
      [
        'memory:',
        '  entity_extraction:',
        '    llm: false',
        '    max_memories_per_run: 12',
        '    min_confidence: 0.4',
        '',
      ].join('\n'),
    );
    expect(config.memory.entityExtraction).toEqual({
      llm: false,
      max_memories_per_run: 12,
      min_confidence: 0.4,
    });
  });

  it('is enabled with a 5-call bound when the block is absent', () => {
    const config = configFrom('memory:\n  summarize_interval: 20\n');
    expect(config.memory.entityExtraction).toEqual({
      llm: true,
      max_memories_per_run: 5,
      min_confidence: 0.6,
    });
  });

  it('fails fast on a wrong type, naming the key', () => {
    expect(() =>
      configFrom('memory:\n  entity_extraction:\n    max_memories_per_run: lots\n'),
    ).toThrow(/memory\.entity_extraction\.max_memories_per_run/);
    resetConfig();
    expect(() => configFrom('memory:\n  entity_extraction:\n    llm: "yes"\n')).toThrow();
  });
});
