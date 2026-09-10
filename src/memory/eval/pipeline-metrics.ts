/**
 * Pipeline-side evaluation metrics (TDAM v1.0.0 "管线评测指标" pattern).
 *
 * While eval-runner.ts measures *retrieval quality* against annotated pairs,
 * this module measures the *write/extraction pipeline itself* straight from
 * persisted operational tables — no annotated dataset required:
 *
 *   - per-layer record counts (L0 sessions → L1 memories → L2 scenes → L3 persona)
 *   - memory hygiene deletion rate (temp-kind expiry pressure)
 *   - memory observability event counters (embedding/FTS/merge degradation)
 *   - persona distillation success rate (persona_distillation_runs)
 *   - maintenance (DreamCycle) job success rate + average duration (maintenance_runs)
 *
 * Everything degrades gracefully when a table is missing (fresh DB before
 * DreamCycle ran) — counts read as 0 rather than throwing.
 */

import type Database from 'better-sqlite3';

export interface PipelineMetrics {
  /** Layer record counts (same L0–L3 mapping as MemoryPipeline). */
  layers: {
    /** Raw sessions. */
    sessions: number;
    /** Active atomic memories (non-scene, non-persona). */
    atomicMemories: number;
    /** Scene cluster memories. */
    scenes: number;
    /** Persona memories. */
    persona: number;
  };
  /** Hygiene pressure: deleted temp-kind rows over the retention window. */
  hygiene: {
    /** Memories currently flagged status='deleted'. */
    deleted: number;
    /** Superseded rows kept for timeline integrity. */
    superseded: number;
  };
  /** memory_observation_events event counters (degradation signals). */
  observationEvents: Record<string, number>;
  /** persona_distillation_runs success rate and totals. */
  personaDistillation: {
    total: number;
    succeeded: number;
    failed: number;
    successRate: number;
  };
  /** maintenance_runs (DreamCycle phases + periodic jobs) rollup. */
  maintenance: {
    totalRuns: number;
    succeeded: number;
    failed: number;
    successRate: number;
    averageDurationMs: number | null;
  };
}

function count(db: Database.Database, sql: string): number {
  try {
    const row = db.prepare(sql).get() as { n?: number | string } | undefined;
    return row?.n != null ? Number(row.n) : 0;
  } catch {
    return 0;
  }
}

function rate(succeeded: number, total: number): number {
  return total > 0 ? succeeded / total : 0;
}

export function computePipelineMetrics(db: Database.Database): PipelineMetrics {
  const observationEvents: Record<string, number> = {};
  try {
    const rows = db
      .prepare('SELECT event, COUNT(*) AS n FROM memory_observation_events GROUP BY event')
      .all() as Array<{ event: string; n: number | string }>;
    for (const row of rows) observationEvents[row.event] = Number(row.n);
  } catch {
    // Table may not exist yet on fresh DBs.
  }

  const personaTotal = count(db, 'SELECT COUNT(*) AS n FROM persona_distillation_runs');
  const personaSucceeded = count(
    db,
    "SELECT COUNT(*) AS n FROM persona_distillation_runs WHERE status = 'success'",
  );
  const personaFailed = count(
    db,
    "SELECT COUNT(*) AS n FROM persona_distillation_runs WHERE status = 'failed'",
  );

  const maintenanceTotal = count(db, 'SELECT COUNT(*) AS n FROM maintenance_runs');
  const maintenanceSucceeded = count(
    db,
    "SELECT COUNT(*) AS n FROM maintenance_runs WHERE status = 'success'",
  );
  const maintenanceFailed = count(
    db,
    "SELECT COUNT(*) AS n FROM maintenance_runs WHERE status = 'failed'",
  );
  // started_at is epoch-ms digit string; finished_at may be NULL (still running).
  let averageDurationMs: number | null = null;
  try {
    const row = db
      .prepare(
        "SELECT AVG(CAST(finished_at AS INTEGER) - CAST(started_at AS INTEGER)) AS avg_ms FROM maintenance_runs WHERE finished_at IS NOT NULL AND started_at GLOB '[0-9]*' AND finished_at GLOB '[0-9]*'",
      )
      .get() as { avg_ms?: number | string | null } | undefined;
    if (row?.avg_ms != null) averageDurationMs = Number(row.avg_ms);
  } catch {
    // Non-fatal — duration rollup is advisory.
  }

  return {
    layers: {
      sessions: count(db, 'SELECT COUNT(*) AS n FROM sessions'),
      atomicMemories: count(
        db,
        "SELECT COUNT(*) AS n FROM memories WHERE status = 'active' AND kind NOT IN ('scene', 'persona')",
      ),
      scenes: count(db, "SELECT COUNT(*) AS n FROM memories WHERE kind = 'scene'"),
      persona: count(db, "SELECT COUNT(*) AS n FROM memories WHERE kind = 'persona'"),
    },
    hygiene: {
      deleted: count(db, "SELECT COUNT(*) AS n FROM memories WHERE status = 'deleted'"),
      superseded: count(db, "SELECT COUNT(*) AS n FROM memories WHERE status = 'superseded'"),
    },
    observationEvents,
    personaDistillation: {
      total: personaTotal,
      succeeded: personaSucceeded,
      failed: personaFailed,
      successRate: rate(personaSucceeded, personaTotal),
    },
    maintenance: {
      totalRuns: maintenanceTotal,
      succeeded: maintenanceSucceeded,
      failed: maintenanceFailed,
      successRate: rate(maintenanceSucceeded, maintenanceTotal),
      averageDurationMs,
    },
  };
}

/** One-line human-readable summary (mirrors formatMetricsReport style). */
export function formatPipelineMetricsReport(metrics: PipelineMetrics): string {
  const pd = metrics.personaDistillation;
  const mt = metrics.maintenance;
  const eventCount = Object.values(metrics.observationEvents).reduce((a, b) => a + b, 0);
  return [
    `L0 sessions=${metrics.layers.sessions}`,
    `L1 memories=${metrics.layers.atomicMemories}`,
    `L2 scenes=${metrics.layers.scenes}`,
    `L3 persona=${metrics.layers.persona}`,
    `hygiene: deleted=${metrics.hygiene.deleted} superseded=${metrics.hygiene.superseded}`,
    `degradation events=${eventCount}`,
    `persona distillation: ${pd.succeeded}/${pd.total} (${(pd.successRate * 100).toFixed(1)}%)`,
    `maintenance: ${mt.succeeded}/${mt.totalRuns} (${(mt.successRate * 100).toFixed(1)}%), avg ${mt.averageDurationMs ?? 'n/a'}ms`,
  ].join(' | ');
}
