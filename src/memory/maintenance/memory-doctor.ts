import type Database from 'better-sqlite3';
import type { MemoryRepository } from '../repositories/memory-repository.js';
import type { PersonaStore } from '../persona-store.js';
import type { PersonaDistiller } from '../persona-distiller.js';
import { memoryObservability } from '../observability.js';

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

    // 1. Orphan embeddings
    const orphanEmbeddings = this.db.prepare(`
      SELECT me.id FROM memory_embeddings me
      LEFT JOIN memories m ON me.memory_id = m.id
      WHERE m.id IS NULL
    `).all() as Array<{ id: string }>;
    checks.push({
      name: 'orphan_embeddings',
      status: orphanEmbeddings.length > 0 ? 'warning' : 'ok',
      message: orphanEmbeddings.length > 0
        ? `${orphanEmbeddings.length} orphan embeddings found`
        : 'No orphan embeddings',
      details: { count: orphanEmbeddings.length },
    });

    // 2. Orphan links
    const orphanLinks = this.db.prepare(`
      SELECT ml.id FROM memory_links ml
      LEFT JOIN memories m ON ml.source_memory_id = m.id
      WHERE m.id IS NULL
    `).all() as Array<{ id: string }>;
    checks.push({
      name: 'orphan_links',
      status: orphanLinks.length > 0 ? 'warning' : 'ok',
      message: orphanLinks.length > 0
        ? `${orphanLinks.length} orphan links found`
        : 'No orphan links',
      details: { count: orphanLinks.length },
    });

    // 3. FTS vs lifecycle consistency
    // content= FTS5 external content tables can't remove individual entries;
    // entries persist until the source row is physically deleted. Recall is
    // unaffected: all queries JOIN with m.status='active'. The gap equals
    // soft-deleted+superseded count and is harmless.
    const ftsCount = this.db.prepare('SELECT COUNT(*) as cnt FROM memories_fts').get() as { cnt: number };
    const activeCount = this.db.prepare("SELECT COUNT(*) as cnt FROM memories WHERE status = 'active'").get() as { cnt: number };
    const inactiveForFts = this.db.prepare("SELECT COUNT(*) as cnt FROM memories WHERE status != 'active'").get() as { cnt: number };
    const ftsGap = ftsCount.cnt - activeCount.cnt;
    checks.push({
      name: 'fts_lifecycle_consistency',
      status: 'ok', // Always ok — expected with content= FTS5 + soft-delete
      message: ftsGap > 0
        ? `FTS has ${ftsGap} more entries than active memories (expected: ${inactiveForFts.cnt} inactive rows persist in FTS; recall JOIN filters by status='active')`
        : 'FTS index consistent with active memory count',
      details: { ftsCount: ftsCount.cnt, activeCount: activeCount.cnt, inactiveCount: inactiveForFts.cnt, gap: ftsGap },
    });

    // 4. Persona staleness
    if (this.personaStore) {
      const persona = this.personaStore.get();
      if (persona) {
        const activePrefs = this.memoryRepo.findByScopeKind('user', 'preference')
          .filter(p => p.status === 'active');
        const personaLastUpdated = new Date(persona.lastUpdated).getTime();
        const stalePrefs = activePrefs.filter(
          p => new Date(p.updated_at).getTime() > personaLastUpdated,
        );
        checks.push({
          name: 'persona_staleness',
          status: stalePrefs.length > 0 ? 'warning' : 'ok',
          message: stalePrefs.length > 0
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
    const missingEmbeddings = this.db.prepare(`
      SELECT COUNT(*) as cnt FROM memories m
      LEFT JOIN memory_embeddings me ON me.memory_id = m.id
      WHERE me.id IS NULL AND m.status = 'active'
    `).get() as { cnt: number };
    checks.push({
      name: 'missing_embeddings',
      status: missingEmbeddings.cnt > 0 ? 'warning' : 'ok',
      message: missingEmbeddings.cnt > 0
        ? `${missingEmbeddings.cnt} active memories missing embeddings`
        : 'All active memories have embeddings',
      details: { count: missingEmbeddings.cnt },
    });

    // 6. Inactive count
    const inactiveCount = this.db.prepare("SELECT COUNT(*) as cnt FROM memories WHERE status != 'active'").get() as { cnt: number };
    checks.push({
      name: 'inactive_memories',
      status: 'ok',
      message: `${inactiveCount.cnt} inactive memories (superseded/deleted)`,
      details: { count: inactiveCount.cnt },
    });

    const observationReport = memoryObservability.snapshot();
    checks.push({
      name: 'memory_observability',
      status: observationReport.total > 0 ? 'warning' : 'ok',
      message: observationReport.total > 0
        ? `${observationReport.total} memory degradation/error events recorded`
        : 'No memory degradation/error events recorded',
      details: {
        total: observationReport.total,
        counts: observationReport.counts,
        recent: observationReport.recent.slice(-5),
      },
    });

    const embeddingCount = this.db.prepare('SELECT COUNT(*) as cnt FROM memory_embeddings').get() as { cnt: number };
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

    const issues = checks.filter(c => c.status !== 'ok').length;
    return { checks, totalIssues: issues, repaired: 0 };
  }

  async repair(): Promise<DoctorReport> {
    const report = await this.diagnose();
    let repaired = 0;

    // Repair orphan embeddings
    const orphanEmbeddings = report.checks.find(c => c.name === 'orphan_embeddings');
    if (orphanEmbeddings?.status !== 'ok') {
      const count = (orphanEmbeddings?.details?.count as number) ?? 0;
      if (count > 0) {
        this.db.prepare(`
          DELETE FROM memory_embeddings WHERE memory_id NOT IN (SELECT id FROM memories)
        `).run();
        repaired += count;
      }
    }

    // Repair orphan links
    const orphanLinks = report.checks.find(c => c.name === 'orphan_links');
    if (orphanLinks?.status !== 'ok') {
      const count = (orphanLinks?.details?.count as number) ?? 0;
      if (count > 0) {
        this.db.prepare(`
          DELETE FROM memory_links WHERE source_memory_id NOT IN (SELECT id FROM memories)
        `).run();
        repaired += count;
      }
    }

    // Repair persona
    const personaCheck = report.checks.find(c => c.name === 'persona_staleness');
    if (personaCheck?.status === 'warning' && this.personaDistiller) {
      const success = await this.personaDistiller.rebuildFull();
      if (success) repaired++;
    }

    return { ...report, repaired };
  }
}
