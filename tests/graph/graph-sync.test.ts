import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { Logger } from 'pino';
import { applySchema } from '../../src/memory/schema';
import { migrateV10 } from '../../src/memory/migration-v10';
import { EntityRepository, type EntityEdge } from '../../src/memory/repositories/entity-repository';
import {
  GRAPH_SYNC_JOB_NAME,
  closeContradictedEdges,
  createGraphSyncJob,
  syncGraphFromMemoryLinks,
} from '../../src/graph/graph-sync';
import { resolveGraphSyncConfig } from '../../src/graph/graph-config';
import { MaintenanceScheduler } from '../../src/memory/maintenance/maintenance-scheduler';
import { MaintenanceRunRepository } from '../../src/memory/maintenance/maintenance-run-repository';

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

const MEMORY_CREATED_AT = 1_700_000_000_000;

/**
 * The projection only draws what a producer asserted: one `memory_links` row
 * that names its subject becomes one edge, and co-occurrence (`MENTIONED`) or
 * an unknown subject (`subject_entity IS NULL`) becomes nothing.
 */
describe('graph-sync: memory_links → entities/entity_edges', () => {
  let db: Database.Database;
  let repo: EntityRepository;

  function seedMemory(id: string, options: { createdAt?: number; status?: string } = {}): void {
    const createdAt = options.createdAt ?? MEMORY_CREATED_AT;
    db.prepare(
      `INSERT INTO memories (id, scope, scope_key, kind, content, status, created_at, updated_at)
       VALUES (?, 'user', 'k', 'fact', ?, ?, ?, ?)`,
    ).run(id, `content ${id}`, options.status ?? 'active', String(createdAt), String(createdAt));
  }

  interface SeedLinkOptions {
    id?: string;
    relation?: string;
    confidence?: number;
    subject?: string | null;
    subjectType?: string | null;
    targetType?: string | null;
  }

  function seedLink(memoryId: string, target: string, options: SeedLinkOptions = {}): void {
    const relation = options.relation ?? 'MENTIONED';
    db.prepare(
      `INSERT INTO memory_links (
         id, source_memory_id, target_entity, relation_type, confidence,
         subject_entity, subject_entity_type, target_entity_type
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      options.id ?? `link-${memoryId}-${target}-${relation}`,
      memoryId,
      target,
      relation,
      options.confidence ?? 0.8,
      options.subject ?? null,
      options.subjectType ?? null,
      options.targetType ?? null,
    );
  }

  function edges(): EntityEdge[] {
    return db
      .prepare('SELECT * FROM entity_edges ORDER BY valid_from, relation_type')
      .all() as EntityEdge[];
  }

  function count(table: string): number {
    return (db.prepare(`SELECT COUNT(*) AS cnt FROM ${table}`).get() as { cnt: number }).cnt;
  }

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applySchema(db);
    migrateV10(db);
    repo = new EntityRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('projects one subject-bearing row as one edge, keeping the asserted types', () => {
    seedMemory('m1');
    seedLink('m1', 'Acme Corp', {
      relation: 'WORKS_AT',
      confidence: 0.9,
      subject: 'Alice Smith',
      subjectType: 'person',
      targetType: 'organization',
    });

    const summary = syncGraphFromMemoryLinks(db, repo, { minConfidence: 0.3 });

    expect(summary.entitiesCreated).toBe(2);
    expect(summary.edgesCreated).toBe(1);
    expect(summary.linksProcessed).toBe(1);
    expect(summary.memoriesProcessed).toBe(1);

    const subject = repo.findByName('Alice Smith', 'person');
    const target = repo.findByName('Acme Corp', 'organization');
    expect(subject).toBeDefined();
    expect(target).toBeDefined();

    const [edge] = edges();
    expect(edge.source_entity_id).toBe(subject!.id);
    expect(edge.target_entity_id).toBe(target!.id);
    expect(edge.relation_type).toBe('WORKS_AT');
    expect(edge.confidence).toBe(0.9);
    expect(edge.source_memory_id).toBe('m1');
    expect(edge.valid_from).toBe(MEMORY_CREATED_AT);
    expect(edge.valid_to).toBeNull();
  });

  it('never creates a memory:<id> placeholder node, even for a memory with one row', () => {
    seedMemory('m2');
    seedLink('m2', 'Acme Corp', { relation: 'FOUNDED', subject: 'Alice Smith' });

    syncGraphFromMemoryLinks(db, repo);

    expect(repo.findByName('memory:m2')).toBeUndefined();
    expect(
      (
        db.prepare("SELECT COUNT(*) AS cnt FROM entities WHERE entity_type = 'memory'").get() as {
          cnt: number;
        }
      ).cnt,
    ).toBe(0);
    expect(count('entities')).toBe(2);
  });

  it('keeps MENTIONED rows out of entity_edges — co-occurrence is not a statement', () => {
    seedMemory('m3');
    seedLink('m3', 'Power Query', {
      relation: 'MENTIONED',
      subject: 'Excel',
      confidence: 0.9,
    });
    seedLink('m3', 'Acme Corp', { relation: 'FOUNDED', subject: 'Excel', confidence: 0.9 });

    const summary = syncGraphFromMemoryLinks(db, repo);

    expect(summary.mentionLinksFiltered).toBe(1);
    expect(summary.linksProcessed).toBe(1);
    expect(edges().map((edge) => edge.relation_type)).toEqual(['FOUNDED']);
    // The mention target gained no node of its own: nothing is derived from a
    // row the graph refuses to draw.
    expect(repo.findByName('Power Query')).toBeUndefined();
  });

  it('draws nothing at all for a memory whose only rows are MENTIONED', () => {
    seedMemory('m5');
    seedLink('m5', 'Power Query', { relation: 'MENTIONED', subject: 'Excel' });

    const summary = syncGraphFromMemoryLinks(db, repo);

    expect(summary.linksProcessed).toBe(0);
    expect(count('entities')).toBe(0);
    expect(count('entity_edges')).toBe(0);
  });

  it('skips rows without a subject instead of guessing one', () => {
    seedMemory('m4');
    seedLink('m4', 'Initech Ltd', { relation: 'FOUNDED', confidence: 0.5, subject: '   ' });
    seedLink('m4', 'Acme Corp', { relation: 'FOUNDED', confidence: 0.9, subject: 'Alice Smith' });

    const summary = syncGraphFromMemoryLinks(db, repo);

    expect(summary.linksWithoutSubject).toBe(1);
    expect(summary.linksProcessed).toBe(1);
    expect(edges()).toHaveLength(1);
  });

  it('draws nothing for a memory whose rows all lack a subject', () => {
    seedMemory('m6');
    seedLink('m6', 'Acme Corp', { relation: 'FOUNDED', confidence: 0.95, subject: null });

    const summary = syncGraphFromMemoryLinks(db, repo);

    expect(summary.linksProcessed).toBe(0);
    expect(count('entities')).toBe(0);
    expect(count('entity_edges')).toBe(0);
  });

  it('closes the previous object when a newer memory states a different one', () => {
    seedMemory('m1', { createdAt: MEMORY_CREATED_AT });
    seedLink('m1', 'Acme Corp', { relation: 'WORKS_AT', subject: 'Alice Smith' });
    seedMemory('m2', { createdAt: MEMORY_CREATED_AT + 60_000 });
    seedLink('m2', 'Initech Ltd', { relation: 'WORKS_AT', subject: 'Alice Smith' });

    const summary = syncGraphFromMemoryLinks(db, repo);

    expect(summary.edgesCreated).toBe(2);
    expect(summary.edgesClosed).toBe(1);
    const acme = repo.findByName('Acme Corp')!;
    const initech = repo.findByName('Initech Ltd')!;
    const closed = edges().find((edge) => edge.target_entity_id === acme.id)!;
    const open = edges().find((edge) => edge.target_entity_id === initech.id)!;
    // The old fact is closed, never deleted: "where did she work in June" stays
    // answerable.
    expect(closed.valid_to).toBe(MEMORY_CREATED_AT + 60_000);
    expect(open.valid_to).toBeNull();
  });

  it('closes contradictions through closeContradictedEdges without touching other relations', () => {
    seedMemory('m1');
    seedLink('m1', 'Acme Corp', { relation: 'WORKS_AT', subject: 'Alice Smith' });
    seedLink('m1', 'Ruby', { relation: 'LIKES', subject: 'Alice Smith' });

    syncGraphFromMemoryLinks(db, repo);
    const alice = repo.findByName('Alice Smith')!;
    const ruby = repo.findByName('Ruby', 'concept')!;
    const closed = closeContradictedEdges(db, {
      subjectId: alice.id,
      relationType: 'LIKES',
      keepTargetId: ruby.id,
      at: MEMORY_CREATED_AT + 5_000,
    });

    // Nothing else points at a conflicting object, and the other relation is
    // untouched: only `(subject, relation)` pairs are compared.
    expect(closed).toBe(0);
    expect(edges().every((edge) => edge.valid_to === null)).toBe(true);
  });

  it('creates nothing new on a second run', () => {
    seedMemory('m1');
    seedLink('m1', 'Acme Corp', { relation: 'WORKS_AT', subject: 'Alice Smith' });
    seedMemory('m2', { createdAt: MEMORY_CREATED_AT + 1000 });
    seedLink('m2', 'Initech Ltd', { relation: 'WORKS_AT', subject: 'Alice Smith' });

    const first = syncGraphFromMemoryLinks(db, repo);
    expect(first.edgesCreated).toBe(2);

    const entitiesAfterFirst = count('entities');
    const edgesAfterFirst = count('entity_edges');

    const second = syncGraphFromMemoryLinks(db, repo);

    expect(second.entitiesCreated).toBe(0);
    expect(second.entitiesMatched).toBe(0);
    expect(second.edgesCreated).toBe(0);
    expect(second.edgesRefreshed).toBe(0);
    expect(second.edgesClosed).toBe(0);
    expect(second.linksProcessed).toBe(0);
    expect(count('entities')).toBe(entitiesAfterFirst);
    expect(count('entity_edges')).toBe(edgesAfterFirst);
  });

  it('skips links from memories that are not active', () => {
    seedMemory('m-old', { status: 'superseded' });
    seedLink('m-old', 'Acme Corp', { relation: 'FOUNDED', subject: 'Alice Smith' });

    const summary = syncGraphFromMemoryLinks(db, repo);

    expect(summary.memoriesProcessed).toBe(0);
    expect(summary.skipped).toBe(1);
    expect(count('entities')).toBe(0);
    expect(count('entity_edges')).toBe(0);
  });

  it('skips blank targets, low-confidence rows and self-loops without throwing', () => {
    seedMemory('m1');
    seedLink('m1', 'Acme Corp', { id: 'good', relation: 'FOUNDED', subject: 'Alice Smith' });
    seedLink('m1', '   ', { id: 'blank-target', relation: 'FOUNDED', subject: 'Alice Smith' });
    seedLink('m1', 'Weak Entity', {
      id: 'weak',
      relation: 'FOUNDED',
      subject: 'Alice Smith',
      confidence: 0.1,
    });
    seedLink('m1', 'alice smith', { id: 'self', relation: 'KNOWS', subject: 'Alice Smith' });

    const summary = syncGraphFromMemoryLinks(db, repo, { minConfidence: 0.3 });

    expect(summary.skipped).toBe(3);
    expect(summary.linksProcessed).toBe(1);
    expect(repo.findByName('Weak Entity')).toBeUndefined();
    expect(count('entity_edges')).toBe(1);
  });

  it('bounds one run by opts.limit and resumes with the next oldest memories', () => {
    for (let index = 0; index < 4; index++) {
      seedMemory(`m${index}`, { createdAt: MEMORY_CREATED_AT + index * 1000 });
      seedLink(`m${index}`, `Entity ${index}`, {
        relation: 'FOUNDED',
        subject: 'Alice Smith',
      });
    }

    const first = syncGraphFromMemoryLinks(db, repo, { limit: 2 });
    expect(first.memoriesProcessed).toBe(2);
    expect(first.edgesCreated).toBe(2);
    expect(repo.findByName('Entity 0')).toBeDefined();
    expect(repo.findByName('Entity 2')).toBeUndefined();

    // Resumable: the two projected memories drop out of the batch, the next two
    // oldest take their place.
    const second = syncGraphFromMemoryLinks(db, repo, { limit: 2 });
    expect(second.memoriesProcessed).toBe(2);
    expect(repo.findByName('Entity 2')).toBeDefined();
    expect(repo.findByName('Entity 3')).toBeDefined();
    expect(count('entity_edges')).toBe(4);
  });

  it('writes nothing on a dry run but still reports the counts', () => {
    seedMemory('m1');
    seedLink('m1', 'Acme Corp', { relation: 'WORKS_AT', subject: 'Alice Smith' });

    const summary = syncGraphFromMemoryLinks(db, repo, { dryRun: true });

    expect(summary.edgesCreated).toBe(1);
    expect(count('entities')).toBe(0);
    expect(count('entity_edges')).toBe(0);
  });

  it('does nothing at all when memory_links is empty', () => {
    const summary = syncGraphFromMemoryLinks(db, repo);

    expect(summary).toEqual({
      entitiesCreated: 0,
      entitiesMatched: 0,
      edgesCreated: 0,
      edgesRefreshed: 0,
      edgesClosed: 0,
      linksWithoutSubject: 0,
      mentionLinksFiltered: 0,
      skipped: 0,
      memoriesProcessed: 0,
      linksProcessed: 0,
    });
    expect(count('entities')).toBe(0);
  });
});

describe('graph-sync: config gate', () => {
  let db: Database.Database;
  let runRepo: MaintenanceRunRepository;
  let scheduler: MaintenanceScheduler;

  function seedMemoryWithLink(): void {
    db.prepare(
      `INSERT INTO memories (id, scope, scope_key, kind, content, created_at, updated_at)
       VALUES ('m1', 'user', 'k', 'fact', 'c', ?, ?)`,
    ).run(String(MEMORY_CREATED_AT), String(MEMORY_CREATED_AT));
    db.prepare(
      `INSERT INTO memory_links (
         id, source_memory_id, target_entity, relation_type, confidence,
         subject_entity, subject_entity_type, target_entity_type
       ) VALUES ('l1', 'm1', 'Acme Corp', 'FOUNDED', 0.9, 'Alice Smith', 'person', 'organization')`,
    ).run();
  }

  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db);
    migrateV10(db);
    runRepo = new MaintenanceRunRepository(db);
    scheduler = new MaintenanceScheduler({ enabled: false, intervalMs: 300_000 }, runRepo, logger);
  });

  afterEach(() => {
    db.close();
  });

  it('defaults to enabled with the documented bounds', () => {
    expect(resolveGraphSyncConfig(undefined)).toEqual({
      enabled: true,
      minConfidence: 0.3,
      maxLinksPerRun: 500,
      mineMentions: true,
      maxMentionsPerMemory: 8,
    });
  });

  it('fails fast on values that cannot be honoured', () => {
    expect(() => resolveGraphSyncConfig({ enabled: 'yes' })).toThrow(/enabled/);
    expect(() => resolveGraphSyncConfig({ min_confidence: 2 })).toThrow(/min_confidence/);
    expect(() => resolveGraphSyncConfig({ max_links_per_run: 0 })).toThrow(/max_links_per_run/);
    expect(() => resolveGraphSyncConfig({ mine_mentions: 'yes' })).toThrow(/mine_mentions/);
    expect(() => resolveGraphSyncConfig({ max_mentions_per_memory: 0 })).toThrow(
      /max_mentions_per_memory/,
    );
  });

  it('accepts numeric strings for counts, like every other interpolation-friendly key', () => {
    const config = resolveGraphSyncConfig({
      max_links_per_run: '250',
      max_mentions_per_memory: '3',
    });
    expect(config.maxLinksPerRun).toBe(250);
    expect(config.maxMentionsPerMemory).toBe(3);
  });

  it('does not run when the gate is off', async () => {
    seedMemoryWithLink();
    scheduler.register(createGraphSyncJob(db, resolveGraphSyncConfig({ enabled: false }), logger));

    const results = await scheduler.runDue();
    expect(results).toHaveLength(0);
    expect(runRepo.getRecentRuns()).toHaveLength(0);
    expect((db.prepare('SELECT COUNT(*) AS cnt FROM entities').get() as { cnt: number }).cnt).toBe(
      0,
    );
  });

  it('records exactly one maintenance_runs row per run, named graph_sync', async () => {
    seedMemoryWithLink();
    scheduler.register(createGraphSyncJob(db, resolveGraphSyncConfig(undefined), logger));

    const results = await scheduler.runDue();
    expect(results).toHaveLength(1);
    expect(results[0]?.name).toBe(GRAPH_SYNC_JOB_NAME);
    expect(results[0]?.affectedRows).toBe(1);

    const runs = db
      .prepare('SELECT job_name, status FROM maintenance_runs WHERE job_name = ?')
      .all(GRAPH_SYNC_JOB_NAME) as Array<{ job_name: string; status: string }>;
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('success');

    // Within the interval the job does not tick again, so no second row appears.
    await scheduler.runDue();
    expect(
      runRepo.getRecentRuns(50).filter((run) => run.job_name === GRAPH_SYNC_JOB_NAME),
    ).toHaveLength(1);
  });

  it('records the subject before projecting, so one pass can do both', async () => {
    // No subject on the row: the mining pass has to write it, otherwise whatever
    // the projection reads would be a guess — this pins the pass order.
    db.prepare(
      `INSERT INTO memories (id, scope, scope_key, kind, content, created_at, updated_at)
       VALUES ('m1', 'user', 'k', 'fact', '知识图谱向飞书建议了新的接入方式', ?, ?)`,
    ).run(String(MEMORY_CREATED_AT), String(MEMORY_CREATED_AT));
    db.prepare(
      `INSERT INTO memory_links (id, source_memory_id, target_entity, relation_type, confidence)
       VALUES ('l1', 'm1', '飞书', 'ADVISES', 0.9)`,
    ).run();

    const result = await createGraphSyncJob(db, resolveGraphSyncConfig(undefined), logger).run({
      dryRun: false,
    });

    expect(result.status).toBe('success');
    const mined = result.details?.mined as { linksAnnotated: number };
    expect(mined.linksAnnotated).toBe(1);
    const row = db
      .prepare('SELECT subject_entity, subject_entity_type, target_entity FROM memory_links')
      .get() as { subject_entity: string; subject_entity_type: string; target_entity: string };
    expect(row.subject_entity).toBe('知识图谱');
    expect(row.target_entity).toBe('飞书');
    expect(row.subject_entity_type).toBe('concept');
    // The row states a relation, so it becomes an edge — from the recorded
    // subject, not from a node invented to stand in for the memory.
    const edges = db
      .prepare(
        `SELECT s.name AS source, t.name AS target
         FROM entity_edges e
         JOIN entities s ON s.id = e.source_entity_id
         JOIN entities t ON t.id = e.target_entity_id`,
      )
      .all() as Array<{ source: string; target: string }>;
    expect(edges).toEqual([{ source: '知识图谱', target: '飞书' }]);
  });
});
