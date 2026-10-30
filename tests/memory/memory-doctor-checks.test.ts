import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema } from '../../src/memory/schema';
import { migrateV14 } from '../../src/memory/migration-v14';
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
  it('does not treat per-turn injection telemetry as a degradation signal', async () => {
    // One `memory.injection` row per prompt build is normal operation. Counting
    // it here would warn on every healthy device forever, which is how an
    // operator learns to ignore the doctor.
    const now = String(Date.now() - 60 * 60 * 1000);
    db.prepare('INSERT INTO memory_observation_events (event, created_at) VALUES (?, ?)').run(
      'memory.injection',
      now,
    );
    db.prepare('INSERT INTO memory_observation_events (event, created_at) VALUES (?, ?)').run(
      'memory.injection.referenced',
      now,
    );

    const doctor = new (await import('../../src/memory/maintenance/memory-doctor.js')).MemoryDoctor(
      db,
      repo,
    );
    const obs = (await doctor.diagnose()).checks.find((c) => c.name === 'memory_observability')!;
    expect(obs.status).toBe('ok');
    expect((obs.details as { total?: number }).total ?? 0).toBe(0);
  });

  it('does not treat refused write-side candidates as a degradation signal', async () => {
    // `memory.durability.rejected` is the gates working, not breaking.
    db.prepare('INSERT INTO memory_observation_events (event, created_at) VALUES (?, ?)').run(
      'memory.durability.rejected',
      String(Date.now() - 60 * 60 * 1000),
    );

    const doctor = new (await import('../../src/memory/maintenance/memory-doctor.js')).MemoryDoctor(
      db,
      repo,
    );
    const obs = (await doctor.diagnose()).checks.find((c) => c.name === 'memory_observability')!;
    expect(obs.status).toBe('ok');
  });

  it('reports knowledge pages citing deleted memories (plan §8 S2)', async () => {
    migrateV14(db);
    const memId = repo.create({
      id: 'mem-doc-4',
      scope: 'user',
      scope_key: 'default',
      kind: 'fact',
      content: 'cited by a page',
    }).id;
    db.prepare(
      `INSERT INTO knowledge_pages (id, page_type, slug, title, content, status, version, created_at, updated_at)
       VALUES ('page-1', 'topic', 'slug-1', 'Title', 'Body', 'active', 1, ?, ?)`,
    ).run(Date.now(), Date.now());
    db.prepare(
      `INSERT INTO knowledge_sources (page_id, source_kind, source_id) VALUES ('page-1', 'memory', ?)`,
    ).run(memId);

    const doctor = new (await import('../../src/memory/maintenance/memory-doctor.js')).MemoryDoctor(
      db,
      repo,
    );
    let check = (await doctor.diagnose()).checks.find(
      (c) => c.name === 'orphan_knowledge_sources',
    )!;
    expect(check.status).toBe('ok');

    // Deleting the memory (hygiene / session-delete) is what leaves the citation
    // dangling — nothing tells the page.
    db.prepare('DELETE FROM memories WHERE id = ?').run(memId);

    check = (await doctor.diagnose()).checks.find((c) => c.name === 'orphan_knowledge_sources')!;
    expect(check.status).toBe('warning');
    expect((check.details as { count: number }).count).toBe(1);
    expect((check.details as { pageIds: string[] }).pageIds).toEqual(['page-1']);
  });

  it('also reports pages citing a superseded memory (review finding F3)', async () => {
    // A superseded row is NOT deleted, so the `NOT EXISTS` form of the check could
    // never see it — yet the page asserts a claim the memory layer retracted, which
    // is the same unverifiable citation from the reader's side. Supersede is the
    // correction path for exactly the five topics §3.1 keeps as `preference`.
    migrateV14(db);
    const memId = repo.create({
      id: 'mem-doc-5',
      scope: 'user',
      scope_key: 'default',
      kind: 'preference',
      content: '用户偏好使用 npm',
    }).id;
    db.prepare(
      `INSERT INTO knowledge_pages (id, page_type, slug, title, content, status, version, created_at, updated_at)
       VALUES ('page-2', 'topic', 'slug-2', 'Title', 'Body', 'active', 1, ?, ?)`,
    ).run(Date.now(), Date.now());
    db.prepare(
      `INSERT INTO knowledge_sources (page_id, source_kind, source_id) VALUES ('page-2', 'memory', ?)`,
    ).run(memId);

    const doctor = new (await import('../../src/memory/maintenance/memory-doctor.js')).MemoryDoctor(
      db,
      repo,
    );
    let check = (await doctor.diagnose()).checks.find(
      (c) => c.name === 'orphan_knowledge_sources',
    )!;
    expect(check.status).toBe('ok');

    repo.supersede(memId, 'mem-doc-6');

    check = (await doctor.diagnose()).checks.find((c) => c.name === 'orphan_knowledge_sources')!;
    expect(check.status).toBe('warning');
    expect(check.details as { inactive: number }).toMatchObject({ dangling: 0, inactive: 1 });
  });
});
