/**
 * `provenance_backfill` (`src/memory/maintenance/jobs/provenance-backfill-job.ts`).
 *
 * The job fills the one gap `migration-v13` documented but nothing produced:
 * `memory_sources.source = 'backfill'`. On the real device database
 * `memories.source_message_id` is 0/712, so "命中记忆 → 回到原话" is false for
 * every memory written before K1 — these tests pin down when it becomes true:
 *
 *   - a distinctive token (identifier / URL / path / quoted span) from the
 *     memory's own text occurring in exactly one message ⇒ one `backfill` row
 *     with that message id and session, plus the primary-source column;
 *   - the same token in several messages of different sessions ⇒ no row, and
 *     the refusal is counted (`ambiguousRejected`) instead of disappearing;
 *   - a hit pair in one session with a message between them ⇒ no row either:
 *     "one stretch of dialogue" is adjacency, not co-occurrence;
 *   - a memory with no distinctive token ⇒ no row, counted as `noEvidence`;
 *   - idempotent: a memory that has a source is not a candidate again;
 *   - `enabled: false` and `dryRun` write nothing while still reporting counts;
 *   - `max_memories_per_run` bounds the memories scanned per run, and successive
 *     runs probe different windows of the backlog so a rejected memory cannot
 *     starve the rest (a dry run does not move the window).
 *
 * `memory.entity_extraction` taught this repo the expensive lesson pinned at the
 * bottom: a config key zod accepts but `buildMemorySection()` drops never
 * reaches the job, and it silently falls back to the defaults.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/memory/db';
import { MessageRepository } from '../../src/memory/repositories/message-repository';
import { MaintenanceRunRepository } from '../../src/memory/maintenance/maintenance-run-repository';
import { loadConfig, resetConfig, stopConfigWatcher } from '../../src/app/config';
import { jsConfigToYaml } from '../../src/app/config-loader';
import type { MaintenanceJobResult } from '../../src/memory/maintenance/maintenance-job';
import {
  createProvenanceBackfillJob,
  deriveProbes,
  DEFAULT_PROVENANCE_BACKFILL_CONFIG,
  PROVENANCE_BACKFILL_JOB_NAME,
  type ProvenanceBackfillJobConfig,
} from '../../src/memory/maintenance/jobs/provenance-backfill-job';

describe('deriveProbes', () => {
  it('reads identifiers, paths and quoted spans, and ignores generic Chinese', () => {
    const probes = deriveProbes('用户对 "现在是白天还是晚上" 使用 D:\\tmp\\excel-mcp 和 Node22');

    expect(probes.map((p) => p.text)).toEqual(
      expect.arrayContaining(['现在是白天还是晚上', 'D:\\tmp\\excel-mcp', 'Node22']),
    );
    // The tier order is the evidence order: a verbatim span outranks an identifier.
    expect(probes[0].tier).toBe('verbatim');
    // Generic conversational Chinese is never a probe.
    expect(probes.some((p) => p.text.includes('用户'))).toBe(false);
  });

  it('offers nothing for a memory that is only generic Chinese', () => {
    expect(deriveProbes('用户偏好简短回答。')).toEqual([]);
  });

  it('does not carve a probe out of a longer name or out of a sentence full stop', () => {
    const probes = deriveProbes('SQLite 是主流方案，keep it under 20 words.').map((p) => p.text);

    // `Lite` would be a substring of SQLite, and `words` a word ending a sentence
    // with a separator only because of the full stop after it.
    expect(probes).not.toContain('Lite');
    expect(probes).not.toContain('words');
  });
});

describe('provenance_backfill', () => {
  let db: Database.Database;
  let messages: MessageRepository;

  beforeEach(() => {
    db = openDatabase(':memory:');
    messages = new MessageRepository(db);
    for (const sessionId of ['s1', 's2']) {
      db.prepare(
        `INSERT INTO sessions (id, chat_id, user_id, channel, created_at, updated_at)
         VALUES (?, ?, 'unknown', 'webui', ?, ?)`,
      ).run(sessionId, sessionId, Date.now(), Date.now());
    }
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

  function seedMessage(
    id: string,
    sessionId: string,
    content: string,
    role: 'user' | 'assistant' = 'user',
    createdAt = Date.now(),
  ): void {
    messages.create({ id, session_id: sessionId, role, content, created_at: createdAt });
  }

  function runJob(
    config: Partial<ProvenanceBackfillJobConfig> = {},
    dryRun = false,
  ): Promise<MaintenanceJobResult> {
    return createProvenanceBackfillJob(db, {
      config: { ...DEFAULT_PROVENANCE_BACKFILL_CONFIG, ...config },
    }).run({ dryRun });
  }

  function sourceRows(memoryId: string): Array<{
    message_id: string;
    session_id: string | null;
    role: string | null;
    source: string;
  }> {
    return db
      .prepare(
        `SELECT message_id, session_id, role, source
         FROM memory_sources WHERE memory_id = ? ORDER BY message_id`,
      )
      .all(memoryId) as Array<{
      message_id: string;
      session_id: string | null;
      role: string | null;
      source: string;
    }>;
  }

  function primarySourceId(memoryId: string): string | null {
    const row = db.prepare('SELECT source_message_id FROM memories WHERE id = ?').get(memoryId) as
      { source_message_id: string | null } | undefined;
    return row?.source_message_id ?? null;
  }

  function totalSourceRows(): number {
    return (db.prepare('SELECT COUNT(*) AS n FROM memory_sources').get() as { n: number }).n;
  }

  function sourcedIds(): string[] {
    return (
      db
        .prepare('SELECT DISTINCT memory_id FROM memory_sources ORDER BY memory_id')
        .all() as Array<{
        memory_id: string;
      }>
    ).map((row) => row.memory_id);
  }

  it('sources a memory whose identifier occurs in exactly one message', async () => {
    seedMemory('m1', '用户的项目使用 oma-probe-42 作为构建标识');
    seedMessage('msg-unique', 's1', '我想确认一下 oma-probe-42 这个构建标识', 'user', 1000);
    seedMessage('msg-other', 's1', '今天天气不错', 'assistant', 2000);

    const result = await runJob();

    expect(result.details).toMatchObject({
      memoriesConsidered: 1,
      candidatesMatched: 1,
      ambiguousRejected: 0,
      noEvidence: 0,
      rowsWritten: 1,
      dryRun: false,
    });
    expect(result.affectedRows).toBe(1);
    expect(sourceRows('m1')).toEqual([
      { message_id: 'msg-unique', session_id: 's1', role: 'user', source: 'backfill' },
    ]);
    expect(primarySourceId('m1')).toBe('msg-unique');
  });

  it('accepts a contiguous stretch of one session and takes the earliest as primary', async () => {
    seedMemory('m1', '用户讨论 oma-run-9 的部署方式');
    seedMessage('run-1', 's1', 'oma-run-9 是什么？', 'user', 1000);
    seedMessage('run-2', 's1', 'oma-run-9 是这次构建的标识', 'assistant', 2000);
    seedMessage('run-3', 's1', '好的，谢谢', 'user', 3000);

    const result = await runJob();

    expect(result.details).toMatchObject({ candidatesMatched: 1, rowsWritten: 2 });
    expect(sourceRows('m1').map((row) => row.message_id)).toEqual(['run-1', 'run-2']);
    expect(sourceRows('m1')[1]).toMatchObject({ session_id: 's1', role: 'assistant' });
    expect(primarySourceId('m1')).toBe('run-1');
  });

  it('writes nothing when the probe matches messages in different sessions', async () => {
    seedMemory('m1', '用户的项目使用 oma-dup-7 作为标识');
    seedMessage('dup-a', 's1', 'oma-dup-7 的配置在哪', 'user', 1000);
    seedMessage('dup-b', 's2', 'oma-dup-7 已经上线了', 'user', 2000);

    const result = await runJob();

    expect(result.details).toMatchObject({
      memoriesConsidered: 1,
      candidatesMatched: 0,
      ambiguousRejected: 1,
      noEvidence: 0,
      rowsWritten: 0,
    });
    expect(totalSourceRows()).toBe(0);
    expect(primarySourceId('m1')).toBeNull();
  });

  it('writes nothing when the hits are in one session but not consecutive', async () => {
    seedMemory('m1', '用户的项目使用 oma-gap-1 作为标识');
    seedMessage('gap-a', 's1', 'oma-gap-1 的配置在哪', 'user', 1000);
    seedMessage('gap-b', 's1', '先聊点别的', 'assistant', 2000);
    seedMessage('gap-c', 's1', 'oma-gap-1 已经上线了', 'user', 3000);

    const result = await runJob();

    expect(result.details).toMatchObject({ ambiguousRejected: 1, rowsWritten: 0 });
    expect(totalSourceRows()).toBe(0);
  });

  it('writes nothing for a memory with no distinctive token', async () => {
    seedMemory('m1', '用户偏好简短回答。');
    seedMessage('msg-1', 's1', '以后回答短一点', 'user', 1000);

    const result = await runJob();

    expect(result.details).toMatchObject({
      memoriesConsidered: 1,
      candidatesMatched: 0,
      ambiguousRejected: 0,
      noEvidence: 1,
      rowsWritten: 0,
    });
    expect(totalSourceRows()).toBe(0);
  });

  it('is idempotent: a sourced memory is not a candidate on a second run', async () => {
    seedMemory('m1', '用户的项目使用 oma-probe-42 作为构建标识');
    seedMessage('msg-unique', 's1', 'oma-probe-42 这个构建标识是什么', 'user', 1000);

    const first = await runJob();
    const second = await runJob();

    expect(first.details).toMatchObject({ rowsWritten: 1 });
    expect(second.details).toMatchObject({ memoriesConsidered: 0, rowsWritten: 0 });
    expect(totalSourceRows()).toBe(1);
  });

  it('reports the counts on a dry run without writing', async () => {
    seedMemory('m1', '用户的项目使用 oma-probe-42 作为构建标识');
    seedMemory('m2', '用户偏好简短回答。');
    seedMessage('msg-unique', 's1', 'oma-probe-42 这个构建标识是什么', 'user', 1000);

    const result = await runJob({}, true);

    expect(result.dryRun).toBe(true);
    expect(result.details).toMatchObject({
      memoriesConsidered: 2,
      candidatesMatched: 1,
      noEvidence: 1,
      rowsWritten: 0,
      dryRun: true,
    });
    expect(totalSourceRows()).toBe(0);
  });

  it('does no work and writes nothing when disabled', async () => {
    seedMemory('m1', '用户的项目使用 oma-probe-42 作为构建标识');
    seedMessage('msg-unique', 's1', 'oma-probe-42 这个构建标识是什么', 'user', 1000);

    const job = createProvenanceBackfillJob(db, {
      config: { enabled: false, max_memories_per_run: 20 },
    });
    const result = await job.run({ dryRun: false });

    expect(job.enabled).toBe(false);
    expect(result.status).toBe('skipped');
    expect(result.details).toMatchObject({
      memoriesConsidered: 0,
      candidatesMatched: 0,
      ambiguousRejected: 0,
      noEvidence: 0,
      rowsWritten: 0,
      enabled: false,
    });
    expect(totalSourceRows()).toBe(0);
  });

  it('respects max_memories_per_run and drains the backlog oldest first', async () => {
    for (const [index, probe] of ['oma-cap-1', 'oma-cap-2', 'oma-cap-3'].entries()) {
      seedMemory(`m${index + 1}`, `用户的项目使用 ${probe} 作为构建标识`, 1000 + index);
      seedMessage(`msg-${index + 1}`, 's1', `${probe} 这个构建标识是什么`, 'user', 1000 + index);
    }

    const first = await runJob({ max_memories_per_run: 2 });
    const second = await runJob({ max_memories_per_run: 2 });

    expect(first.details).toMatchObject({ memoriesConsidered: 2, rowsWritten: 2 });
    expect(first.details?.elapsedMs === undefined).toBe(false);
    expect(second.details).toMatchObject({ memoriesConsidered: 1, rowsWritten: 1 });
    expect(sourceRows('m1')).toHaveLength(1);
    expect(sourceRows('m3')).toHaveLength(1);
  });

  /**
   * The rotation, observed through the windows rather than through rows: every
   * memory here is rejected (no distinctive token), so none of them leaves the
   * candidate list and the window is the only thing that can differ.
   */
  it('probes a different window on each successive run and wraps to the start', async () => {
    for (let index = 0; index < 4; index++) {
      seedMemory(`m${index + 1}`, '用户偏好简短回答。', 1000 + index);
    }
    const runs = new MaintenanceRunRepository(db);
    const windows: unknown[] = [];

    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await runJob({ max_memories_per_run: 2 });
      windows.push(result.details?.window);
      // What MaintenanceScheduler.runJob does around every run: one history row,
      // finished — and it is that count the window index is derived from.
      const id = runs.startRun(PROVENANCE_BACKFILL_JOB_NAME, false);
      runs.finishRun(id, 0);
    }

    expect(windows).toEqual([
      { index: 0, offset: 0, candidateTotal: 4, pages: 2, limit: 2 },
      { index: 1, offset: 2, candidateTotal: 4, pages: 2, limit: 2 },
      // The wrap: after the last page the next run starts over.
      { index: 0, offset: 0, candidateTotal: 4, pages: 2, limit: 2 },
    ]);
  });

  it('covers the whole backlog across successive runs without re-probing', async () => {
    for (const [index, probe] of ['oma-win-1', 'oma-win-2', 'oma-win-3', 'oma-win-4'].entries()) {
      seedMemory(`m${index + 1}`, `用户的项目使用 ${probe} 作为构建标识`, 1000 + index);
      seedMessage(`msg-${index + 1}`, 's1', `${probe} 这个构建标识是什么`, 'user', 1000 + index);
    }
    const runs = new MaintenanceRunRepository(db);

    const first = await runJob({ max_memories_per_run: 2 });
    const firstWave = sourcedIds();
    const id = runs.startRun(PROVENANCE_BACKFILL_JOB_NAME, false);
    runs.finishRun(id, 0);
    const second = await runJob({ max_memories_per_run: 2 });

    const all = sourcedIds();
    expect(first.details).toMatchObject({ memoriesConsidered: 2, rowsWritten: 2 });
    expect(second.details).toMatchObject({ memoriesConsidered: 2, rowsWritten: 2 });
    expect(firstWave).toEqual(['m1', 'm2']);
    // The second run probed the other window: two disjoint slices, 2 + 2 = 4.
    expect(all.filter((id) => !firstWave.includes(id))).toEqual(['m3', 'm4']);
    expect(all).toHaveLength(4);
  });

  it('does not advance the window on a dry run', async () => {
    for (let index = 0; index < 4; index++) {
      seedMemory(`m${index + 1}`, '用户偏好简短回答。', 1000 + index);
    }
    const runs = new MaintenanceRunRepository(db);
    // One finished real run, then a scheduled dry run — which writes its own
    // history row with `dry_run = 1` and must still not consume the window.
    runs.finishRun(runs.startRun(PROVENANCE_BACKFILL_JOB_NAME, false), 0);
    const dryId = runs.startRun(PROVENANCE_BACKFILL_JOB_NAME, true);
    runs.finishRun(dryId, 0);

    const dry = await runJob({ max_memories_per_run: 2 }, true);
    const real = await runJob({ max_memories_per_run: 2 });

    expect(dry.details).toMatchObject({ window: { index: 1, offset: 2 }, rowsWritten: 0 });
    expect(real.details).toMatchObject({ window: { index: 1, offset: 2 } });
  });
});

/**
 * The block the job is configured by. Pinned here because a config key zod
 * accepts but `buildMemorySection()` drops never reaches the job.
 */
describe('memory.provenance_backfill config wiring', () => {
  let dir: string;

  beforeEach(() => {
    resetConfig();
    stopConfigWatcher();
    dir = mkdtempSync(join(tmpdir(), 'oma-provenance-backfill-'));
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
        '  provenance_backfill:',
        '    enabled: false',
        '    max_memories_per_run: 7',
        '',
      ].join('\n'),
    );
    expect(config.memory.provenanceBackfill).toEqual({
      enabled: false,
      max_memories_per_run: 7,
    });
  });

  it('is enabled with a 20-memory bound when the block is absent', () => {
    const config = configFrom('memory:\n  summarize_interval: 20\n');
    expect(config.memory.provenanceBackfill).toEqual({
      enabled: true,
      max_memories_per_run: 20,
    });
  });

  it('fails fast on a wrong type, naming the key', () => {
    expect(() =>
      configFrom('memory:\n  provenance_backfill:\n    max_memories_per_run: lots\n'),
    ).toThrow(/memory\.provenance_backfill\.max_memories_per_run/);
    resetConfig();
    expect(() => configFrom('memory:\n  provenance_backfill:\n    enabled: "yes"\n')).toThrow();
  });

  it('writes the block back as snake_case instead of dropping it', () => {
    // The third mapping direction: a block the read side understands but
    // `jsConfigToYaml` cannot write back is erased by the next WebUI save.
    const yaml = jsConfigToYaml(
      { memory: { provenanceBackfill: { enabled: false, max_memories_per_run: 3 } } },
      {},
    );
    expect((yaml.memory as Record<string, unknown>).provenance_backfill).toEqual({
      enabled: false,
      max_memories_per_run: 3,
    });
  });
});
