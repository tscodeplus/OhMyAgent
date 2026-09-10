import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema } from '../../src/memory/schema';
import { MemoryDoctor } from '../../src/memory/maintenance/memory-doctor';
import { MemoryRepository } from '../../src/memory/repositories/memory-repository';
import { generateId } from '../../src/shared/ids';

describe('MemoryDoctor: orphan terms / terms coverage / 24h observability', () => {
  let db: Database.Database;
  let repo: MemoryRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = OFF'); // better-sqlite3 defaults to ON; simulate legacy paths
    applySchema(db);
    repo = new MemoryRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('detects and repairs orphan terms, links, and embeddings', async () => {
    const memId = repo.create({
      id: 'mem-doc-1',
      scope: 'user',
      scope_key: 'default',
      kind: 'fact',
      content: 'fact with derived rows',
    }).id;
    db.prepare('INSERT INTO memory_terms (memory_id, term, term_type) VALUES (?, ?, ?)').run(
      memId,
      'fact',
      'token',
    );
    db.prepare(
      'INSERT INTO memory_links (id, source_memory_id, target_entity, relation_type) VALUES (?, ?, ?, ?)',
    ).run(generateId(), memId, 'entity-x', 'related');
    // Delete the memory via raw SQL (bypassing cleanup, like legacy paths).
    db.prepare('DELETE FROM memories WHERE id = ?').run(memId);

    const doctor = new (await import('../../src/memory/maintenance/memory-doctor.js')).MemoryDoctor(
      db,
      repo,
    );
    const diagnosis = await doctor.diagnose();
    const byName = Object.fromEntries(diagnosis.checks.map((c) => [c.name, c]));
    expect(byName['orphan_terms'].status).toBe('warning');
    expect(byName['orphan_links'].status).toBe('warning');

    const repair = await doctor.repair();
    expect(repair.repaired).toBeGreaterThanOrEqual(2);
    expect((db.prepare('SELECT COUNT(*) n FROM memory_terms').get() as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) n FROM memory_links').get() as { n: number }).n).toBe(0);
  });

  it('reports terms_coverage warning for active memories without terms', async () => {
    void repo.create({
      id: 'mem-doc-2',
      scope: 'user',
      scope_key: 'default',
      kind: 'fact',
      content: 'no terms here',
    });
    const doctor = new (await import('../../src/memory/maintenance/memory-doctor.js')).MemoryDoctor(
      db,
      repo,
    );
    const diagnosis = await doctor.diagnose();
    const coverage = diagnosis.checks.find((c) => c.name === 'terms_coverage');
    expect(coverage?.status).toBe('warning');
  });

  it('observability check counts only the last 24h', async () => {
    void repo.create({
      id: 'mem-doc-3',
      scope: 'user',
      scope_key: 'default',
      kind: 'fact',
      content: 'x',
    });
    const old = Date.now() - 48 * 60 * 60 * 1000;
    const fresh = Date.now() - 60 * 60 * 1000;
    db.prepare('INSERT INTO memory_observation_events (event, created_at) VALUES (?, ?)').run(
      'memory.embedding.failed',
      String(old),
    );
    db.prepare('INSERT INTO memory_observation_events (event, created_at) VALUES (?, ?)').run(
      'memory.merge.failed',
      String(fresh),
    );

    const doctor = new (await import('../../src/memory/maintenance/memory-doctor.js')).MemoryDoctor(
      db,
      repo,
    );
    const diagnosis = await doctor.diagnose();
    const obs = diagnosis.checks.find((c) => c.name === 'memory_observability')!;
    expect(obs.status).toBe('warning');
    expect((obs.details as { total: number }).total).toBe(1);
    expect(
      (obs.details as { counts: Record<string, number> }).counts['memory.embedding.failed'],
    ).toBeUndefined();
  });
});
