import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema } from '../../src/memory/schema';
import { DreamCycle, type DreamCycleConfig } from '../../src/memory/dream-cycle';
import { MaintenanceRunRepository } from '../../src/memory/maintenance/maintenance-run-repository';

/** Catch-up decision + force-run behavior (missed-nightly recovery). */
describe('DreamCycle catch-up on start', () => {
  let db: Database.Database;
  let runRepo: MaintenanceRunRepository;

  function buildDreamCycle(config?: Partial<DreamCycleConfig>): DreamCycle {
    return new DreamCycle(
      {
        enabled: true,
        timezone: '',
        hour: 2,
        minute: 0,
        windowGraceMinutes: 120,
        phaseTimeoutMs: 60_000,
        synthesizeBatchSize: 50,
        catchUpOnStart: true,
        ...config,
      },
      db,
      runRepo,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      undefined,
      {
        auxConfig: undefined,
        mergeThreshold: 0.85,
        logger: { warn() {}, info() {}, error() {}, debug() {} } as never,
      },
      { warn() {}, info() {}, error() {}, debug() {} } as never,
    );
  }

  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db);
    runRepo = new MaintenanceRunRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('needs catch-up when no dreamcycle run has ever been recorded', () => {
    expect(buildDreamCycle().shouldCatchUpOnStart()).toBe(true);
  });

  it('needs catch-up when the last run is older than 24h', () => {
    const runId = runRepo.startRun('dreamcycle_hygiene', false);
    runRepo.finishRun(runId, 0);
    // Backdate the row to 25h ago (started_at is an epoch-ms digit string).
    db.prepare('UPDATE maintenance_runs SET started_at = ? WHERE id = ?').run(
      String(Date.now() - 25 * 60 * 60 * 1000),
      runId,
    );
    expect(buildDreamCycle().shouldCatchUpOnStart()).toBe(true);
  });

  it('does not need catch-up when the last run is fresh', () => {
    const runId = runRepo.startRun('dreamcycle_hygiene', false);
    runRepo.finishRun(runId, 0);
    expect(buildDreamCycle().shouldCatchUpOnStart()).toBe(false);
  });

  it('treats an unparsable started_at as needing catch-up', () => {
    const runId = runRepo.startRun('dreamcycle_purge', false);
    runRepo.finishRun(runId, 0);
    db.prepare('UPDATE maintenance_runs SET started_at = ?').run('not-a-timestamp');
    expect(buildDreamCycle().shouldCatchUpOnStart()).toBe(true);
  });
});
