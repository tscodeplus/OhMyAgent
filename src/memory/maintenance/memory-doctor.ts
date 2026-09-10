import type Database from 'better-sqlite3';
import type { MemoryRepository } from '../repositories/memory-repository.js';
import type { PersonaStore } from '../persona-store.js';
import type { PersonaDistiller } from '../persona-distiller.js';
import { parseEpochMs } from '../../shared/timestamp.js';
import { loadSqliteVecExtension } from '../sqlite-vec.js';

export interface DoctorCheck {
  name: string;
  status: 'ok' | 'warning' | 'error';
  message: string;
  details?: Record<string, unknown>;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  totalIssues: number;
  repaired: number;
}

export class MemoryDoctor {
  constructor(
    private db: Database.Database,
    private memoryRepo: MemoryRepository,
    private personaStore?: PersonaStore,
    private personaDistiller?: PersonaDistiller,
  ) {}

  async diagnose(): Promise<DoctorReport> {
    const checks: DoctorCheck[] = [];

    // The doctor may be invoked on a connection that hasn't loaded sqlite-vec
    // yet (standalone tool runs) — without it, vec_* virtual tables error as
    // "no such module: vec0" and vec-side checks silently no-op.
    try {
      loadSqliteVecExtension(this.db);
    } catch {
      // vec0 unavailable on this platform — vec table checks will be skipped.
    }

    // 1. Orphan embeddings (fallback table + vec0 virtual table)
    const orphanEmbeddings = [
      ...(
        this.db
          .prepare(
            `
      SELECT me.id FROM memory_embeddings me
      LEFT JOIN memories m ON me.memory_id = m.id
      WHERE m.id IS NULL
    `,
          )
          .all() as Array<{ id: string }>
      ).map((r) => r.id),
    ];
    try {
      orphanEmbeddings.push(
        ...(
          this.db
            .prepare(
              `
      SELECT v.memory_id AS id FROM vec_memory_embeddings v
      LEFT JOIN memories m ON v.memory_id = m.id
      WHERE m.id IS NULL
    `,
            )
            .all() as Array<{ id: string }>
        ).map((r) => r.id),
      );
    } catch {
      // vec0 unavailable on this platform — table absent.
    }
    checks.push({
      name: 'orphan_embeddings',
      status: orphanEmbeddings.length > 0 ? 'warning' : 'ok',
      message:
        orphanEmbeddings.length > 0
          ? `${orphanEmbeddings.length} orphan embeddings found`
          : 'No orphan embeddings',
      details: { count: orphanEmbeddings.length },
    });

    // 2. Orphan links
    const orphanLinks = this.db
      .prepare(
        `
      SELECT ml.id FROM memory_links ml
      LEFT JOIN memories m ON ml.source_memory_id = m.id
      WHERE m.id IS NULL
    `,
      )
      .all() as Array<{ id: string }>;
    checks.push({
      name: 'orphan_links',
      status: orphanLinks.length > 0 ? 'warning' : 'ok',
      message:
        orphanLinks.length > 0 ? `${orphanLinks.length} orphan links found` : 'No orphan links',
      details: { count: orphanLinks.length },
    });

    // 2b. Orphan terms
    const orphanTerms = this.db
      .prepare(
        `
      SELECT mt.memory_id FROM memory_terms mt
      LEFT JOIN memories m ON mt.memory_id = m.id
      WHERE m.id IS NULL
    `,
      )
      .all() as Array<{ memory_id: string }>;
    checks.push({
      name: 'orphan_terms',
      status: orphanTerms.length > 0 ? 'warning' : 'ok',
      message:
        orphanTerms.length > 0 ? `${orphanTerms.length} orphan terms found` : 'No orphan terms',
      details: { count: orphanTerms.length },
    });

    // 2c. Lexical terms coverage — memories with no memory_terms rows are
    // invisible to the lexical recall channel (termSearchWrapper).
    const missingTerms = this.db
      .prepare(
        `
      SELECT COUNT(*) as cnt FROM memories m
      WHERE m.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM memory_terms mt WHERE mt.memory_id = m.id)
    `,
      )
      .get() as { cnt: number };
    checks.push({
      name: 'terms_coverage',
      status: missingTerms.cnt > 0 ? 'warning' : 'ok',
      message:
        missingTerms.cnt > 0
          ? `${missingTerms.cnt} active memories missing lexical terms (terms_backfill will repair)`
          : 'All active memories have lexical terms',
      details: { count: missingTerms.cnt },
    });

    // 3. FTS vs lifecycle consistency
    // content= FTS5 external content tables can't remove individual entries;
    // entries persist until the source row is physically deleted. Recall is
    // unaffected: all queries JOIN with m.status='active'. The gap equals
    // soft-deleted+superseded count and is harmless.
    const ftsCount = this.db.prepare('SELECT COUNT(*) as cnt FROM memories_fts').get() as {
      cnt: number;
    };
    const activeCount = this.db
      .prepare("SELECT COUNT(*) as cnt FROM memories WHERE status = 'active'")
      .get() as { cnt: number };
    const inactiveForFts = this.db
      .prepare("SELECT COUNT(*) as cnt FROM memories WHERE status != 'active'")
      .get() as { cnt: number };
    const ftsGap = ftsCount.cnt - activeCount.cnt;
    checks.push({
      name: 'fts_lifecycle_consistency',
      status: 'ok', // Always ok — expected with content= FTS5 + soft-delete
      message:
        ftsGap > 0
          ? `FTS has ${ftsGap} more entries than active memories (expected: ${inactiveForFts.cnt} inactive rows persist in FTS; recall JOIN filters by status='active')`
          : 'FTS index consistent with active memory count',
      details: {
        ftsCount: ftsCount.cnt,
        activeCount: activeCount.cnt,
        inactiveCount: inactiveForFts.cnt,
        gap: ftsGap,
      },
    });

    // 4. Persona staleness
    if (this.personaStore) {
      const persona = this.personaStore.get();
      if (persona) {
        const activePrefs = this.memoryRepo
          .findByScopeKind('user', 'preference')
          .filter((p) => p.status === 'active');
        const personaLastUpdated = new Date(persona.lastUpdated).getTime();
        const stalePrefs = activePrefs.filter(
          (p) => parseEpochMs(p.updated_at) > personaLastUpdated,
        );
        checks.push({
          name: 'persona_staleness',
          status: stalePrefs.length > 0 ? 'warning' : 'ok',
          message:
            stalePrefs.length > 0
              ? `Persona is stale: ${stalePrefs.length} preferences newer than persona`
              : 'Persona is up to date',
          details: { stalePrefCount: stalePrefs.length, activePrefCount: activePrefs.length },
        });
      } else {
        checks.push({
          name: 'persona_staleness',
          status: 'warning',
          message: 'No persona exists',
          details: {},
        });
      }
    }

    // 5. Missing embeddings
    const missingEmbeddings = this.db
      .prepare(
        `
      SELECT COUNT(*) as cnt FROM memories m
      LEFT JOIN memory_embeddings me ON me.memory_id = m.id
      WHERE me.id IS NULL AND m.status = 'active'
    `,
      )
      .get() as { cnt: number };
    checks.push({
      name: 'missing_embeddings',
      status: missingEmbeddings.cnt > 0 ? 'warning' : 'ok',
      message:
        missingEmbeddings.cnt > 0
          ? `${missingEmbeddings.cnt} active memories missing embeddings`
          : 'All active memories have embeddings',
      details: { count: missingEmbeddings.cnt },
    });

    // 6. Inactive count
    const inactiveCount = this.db
      .prepare("SELECT COUNT(*) as cnt FROM memories WHERE status != 'active'")
      .get() as { cnt: number };
    checks.push({
      name: 'inactive_memories',
      status: 'ok',
      message: `${inactiveCount.cnt} inactive memories (superseded/deleted)`,
      details: { count: inactiveCount.cnt },
    });

    // Degradation events from the last 24h only — all-time counts are
    // dominated by historical noise and would flag permanently (same windowing
    // convention as GET /api/memory/pipeline/status).
    let recentTotal = 0;
    let recentCounts: Record<string, number> = {};
    try {
      const rows = this.db
        .prepare(
          `SELECT event, COUNT(*) AS n FROM memory_observation_events
           WHERE CAST(created_at AS INTEGER) >= ? GROUP BY event`,
        )
        .all(Date.now() - 24 * 60 * 60 * 1000) as Array<{ event: string; n: number }>;
      recentTotal = rows.reduce((sum, row) => sum + row.n, 0);
      recentCounts = Object.fromEntries(rows.map((row) => [row.event, row.n]));
    } catch {
      // Table may not exist yet on fresh DBs.
    }
    checks.push({
      name: 'memory_observability',
      status: recentTotal > 0 ? 'warning' : 'ok',
      message:
        recentTotal > 0
          ? `${recentTotal} memory degradation/error events in the last 24h`
          : 'No memory degradation/error events in the last 24h',
      details: {
        windowHours: 24,
        total: recentTotal,
        counts: recentCounts,
      },
    });

    const embeddingCount = this.db
      .prepare('SELECT COUNT(*) as cnt FROM memory_embeddings')
      .get() as { cnt: number };
    checks.push({
      name: 'vector_strategy',
      status: 'ok',
      message: `Vector fallback has ${embeddingCount.cnt} embeddings available`,
      details: {
        embeddingCount: embeddingCount.cnt,
        sqliteVec: 'not_initialized',
        fallback: 'cosine-prefilter',
      },
    });

    const issues = checks.filter((c) => c.status !== 'ok').length;
    return { checks, totalIssues: issues, repaired: 0 };
  }

  async repair(): Promise<DoctorReport> {
    const report = await this.diagnose();
    let repaired = 0;

    // Repair orphan embeddings — both the fallback table and the vec0
    // virtual table (which has no FK cascade and is invisible to raw SQL
    // joins the checks use).
    const orphanEmbeddings = report.checks.find((c) => c.name === 'orphan_embeddings');
    if (orphanEmbeddings?.status !== 'ok') {
      const count = (orphanEmbeddings?.details?.count as number) ?? 0;
      if (count > 0) {
        const danglingIds = (
          this.db
            .prepare(
              `
          SELECT memory_id FROM memory_embeddings WHERE memory_id NOT IN (SELECT id FROM memories)
        `,
            )
            .all() as Array<{ memory_id: string }>
        ).map((r) => r.memory_id);
        this.db
          .prepare(
            `
          DELETE FROM memory_embeddings WHERE memory_id NOT IN (SELECT id FROM memories)
        `,
          )
          .run();
        // vec0 rows for the same dangling ids (SQLite drops the table when
        // the vec0 extension is missing — tolerate that).
        try {
          const vecResult = this.db
            .prepare(
              `
            DELETE FROM vec_memory_embeddings WHERE memory_id NOT IN (SELECT id FROM memories)
          `,
            )
            .run();
          repaired += vecResult.changes;
        } catch {
          // vec0 unavailable on this platform — vec table absent.
        }
        repaired += danglingIds.length;
      }
    }

    // Repair orphan links
    const orphanLinks = report.checks.find((c) => c.name === 'orphan_links');
    if (orphanLinks?.status !== 'ok') {
      const count = (orphanLinks?.details?.count as number) ?? 0;
      if (count > 0) {
        this.db
          .prepare(
            `
          DELETE FROM memory_links WHERE source_memory_id NOT IN (SELECT id FROM memories)
        `,
          )
          .run();
        repaired += count;
      }
    }

    // Repair orphan terms
    const orphanTerms = report.checks.find((c) => c.name === 'orphan_terms');
    if (orphanTerms?.status !== 'ok') {
      const count = (orphanTerms?.details?.count as number) ?? 0;
      if (count > 0) {
        this.db
          .prepare(
            `
          DELETE FROM memory_terms WHERE memory_id NOT IN (SELECT id FROM memories)
        `,
          )
          .run();
        repaired += count;
      }
    }

    // Repair persona
    const personaCheck = report.checks.find((c) => c.name === 'persona_staleness');
    if (personaCheck?.status === 'warning' && this.personaDistiller) {
      const success = await this.personaDistiller.rebuildFull();
      if (success) repaired++;
    }

    return { ...report, repaired };
  }
}
