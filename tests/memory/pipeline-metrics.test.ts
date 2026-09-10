import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema } from '../../src/memory/schema';
import {
  computePipelineMetrics,
  formatPipelineMetricsReport,
} from '../../src/memory/eval/pipeline-metrics';
import { MaintenanceRunRepository } from '../../src/memory/maintenance/maintenance-run-repository';

describe('computePipelineMetrics (TDAM pipeline eval metrics)', () => {
  let db: Database.Database;
  let runRepo: MaintenanceRunRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db);
    runRepo = new MaintenanceRunRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('returns zeroed metrics on a fresh database', () => {
    const m = computePipelineMetrics(db);
    expect(m.layers).toEqual({
      sessions: 0,
      atomicMemories: 0,
      scenes: 0,
      persona: 0,
    });
    expect(m.personaDistillation.successRate).toBe(0);
    expect(m.maintenance.totalRuns).toBe(0);
    expect(m.maintenance.averageDurationMs).toBeNull();
    expect(m.observationEvents).toEqual({});
  });

  it('counts layers from persisted rows', () => {
    db.prepare(
      "INSERT INTO memories (id, scope, scope_key, kind, content) VALUES ('m1', 'user', 'u', 'fact', 'x')",
    ).run();
    db.prepare(
      "INSERT INTO memories (id, scope, scope_key, kind, content) VALUES ('m2', 'user', 'u', 'scene', 'x')",
    ).run();
    db.prepare(
      "INSERT INTO memories (id, scope, scope_key, kind, content) VALUES ('m3', 'user', '__persona__', 'persona', 'x')",
    ).run();

    const m = computePipelineMetrics(db);
    expect(m.layers.atomicMemories).toBe(1);
    expect(m.layers.scenes).toBe(1);
    expect(m.layers.persona).toBe(1);
  });

  it('rolls up persona distillation and maintenance run rates', () => {
    const runId = runRepo.startRun('dreamcycle_hygiene', false);
    runRepo.finishRun(runId, 3);

    const failId = runRepo.startRun('dreamcycle_purge', false);
    runRepo.finishRun(failId, 0, 'boom');

    db.prepare(
      "INSERT INTO persona_distillation_runs (id, mode, status, active_preference_count) VALUES ('r1', 'incremental', 'success', 2)",
    ).run();
    db.prepare(
      "INSERT INTO persona_distillation_runs (id, mode, status, active_preference_count) VALUES ('r2', 'full', 'failed', 0)",
    ).run();

    const m = computePipelineMetrics(db);
    expect(m.maintenance).toMatchObject({ totalRuns: 2, succeeded: 1, failed: 1 });
    expect(m.maintenance.successRate).toBeCloseTo(0.5);
    expect(m.personaDistillation).toMatchObject({ total: 2, succeeded: 1, failed: 1 });
    expect(m.personaDistillation.successRate).toBeCloseTo(0.5);
  });

  it('aggregates observability event counters', () => {
    db.prepare(
      "INSERT INTO memory_observation_events (event) VALUES ('memory.embedding.failed')",
    ).run();
    db.prepare(
      "INSERT INTO memory_observation_events (event) VALUES ('memory.embedding.failed')",
    ).run();
    db.prepare(
      "INSERT INTO memory_observation_events (event) VALUES ('memory.write.degraded')",
    ).run();

    const m = computePipelineMetrics(db);
    expect(m.observationEvents['memory.embedding.failed']).toBe(2);
    expect(m.observationEvents['memory.write.degraded']).toBe(1);
  });

  it('formats a human-readable report', () => {
    const runId = runRepo.startRun('dreamcycle_hygiene', false);
    runRepo.finishRun(runId, 1);
    const report = formatPipelineMetricsReport(computePipelineMetrics(db));
    expect(report).toContain('L0 sessions=');
    expect(report).toContain('maintenance: 1/1 (100.0%)');
  });
});
