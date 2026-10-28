import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { Logger } from 'pino';
import { applySchema } from '../../src/memory/schema';
import { migrateV10 } from '../../src/memory/migration-v10';
import { EntityRepository, type EntityEdge } from '../../src/memory/repositories/entity-repository';
import {
  GRAPH_SYNC_JOB_NAME,
  createGraphSyncJob,
  inferEntityType,
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

  function seedLink(
    memoryId: string,
    target: string,
    options: { id?: string; relation?: string; confidence?: number } = {},
  ): void {
    db.prepare(
      `INSERT INTO memory_links (id, source_memory_id, target_entity, relation_type, confidence)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      options.id ?? `link-${memoryId}-${target}-${options.relation ?? 'MENTIONED'}`,
      memoryId,
      target,
      options.relation ?? 'MENTIONED',
      options.confidence ?? 0.8,
    );
  }

  function edges(): EntityEdge[] {
    return db.prepare('SELECT * FROM entity_edges').all() as EntityEdge[];
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

  it('projects a multi-link memory as subject→target edges with inferred types', () => {
    seedMemory('m1');
    seedLink('m1', 'Alice Smith', { relation: 'WORKS_AT', confidence: 0.9 });
    seedLink('m1', 'Acme Corp', { relation: 'WORKS_AT', confidence: 0.8 });

    const summary = syncGraphFromMemoryLinks(db, repo, { minConfidence: 0.3 });

    expect(summary.entitiesCreated).toBe(2);
    expect(summary.edgesCreated).toBe(1);
    expect(summary.linksProcessed).toBe(1);

    const subject = repo.findByName('Alice Smith', 'person');
    const target = repo.findByName('Acme Corp', 'organization');
    expect(subject).toBeDefined();
    expect(target).toBeDefined();

    const [edge] = edges();
    expect(edge.source_entity_id).toBe(subject!.id);
    expect(edge.target_entity_id).toBe(target!.id);
    expect(edge.relation_type).toBe('WORKS_AT');
    expect(edge.confidence).toBe(0.8);
    expect(edge.source_memory_id).toBe('m1');
    expect(edge.valid_from).toBe(MEMORY_CREATED_AT);
  });

  it('uses the memory placeholder node as subject when the memory has a single link', () => {
    seedMemory('m2');
    seedLink('m2', '程语', { relation: 'MENTIONED', confidence: 0.75 });

    const summary = syncGraphFromMemoryLinks(db, repo);

    expect(summary.entitiesCreated).toBe(2);
    const placeholder = repo.findByName('memory:m2', 'memory');
    const topic = repo.findByName('程语', 'concept');
    expect(placeholder).toBeDefined();
    expect(topic).toBeDefined();

    const [edge] = edges();
    expect(edge.source_entity_id).toBe(placeholder!.id);
    expect(edge.target_entity_id).toBe(topic!.id);
    expect(edge.relation_type).toBe('MENTIONED');
    expect(edge.confidence).toBe(0.75);
    expect(edge.valid_from).toBe(MEMORY_CREATED_AT);
  });

  it('creates nothing new on a second run', () => {
    seedMemory('m1');
    seedLink('m1', 'Alice Smith', { relation: 'WORKS_AT', confidence: 0.9 });
    seedLink('m1', 'Acme Corp', { relation: 'WORKS_AT', confidence: 0.8 });
    seedMemory('m2', { createdAt: MEMORY_CREATED_AT + 1000 });
    seedLink('m2', '程语', { confidence: 0.75 });

    const first = syncGraphFromMemoryLinks(db, repo);
    expect(first.edgesCreated).toBe(2);

    const entitiesAfterFirst = count('entities');
    const edgesAfterFirst = count('entity_edges');

    const second = syncGraphFromMemoryLinks(db, repo);

    expect(second.entitiesCreated).toBe(0);
    expect(second.entitiesMatched).toBe(0);
    expect(second.edgesCreated).toBe(0);
    expect(second.edgesRefreshed).toBe(0);
    expect(second.linksProcessed).toBe(0);
    expect(count('entities')).toBe(entitiesAfterFirst);
    expect(count('entity_edges')).toBe(edgesAfterFirst);
  });

  it('skips links from memories that are not active', () => {
    seedMemory('m-old', { status: 'superseded' });
    seedLink('m-old', 'Ghost Entity', { confidence: 1.0 });

    const summary = syncGraphFromMemoryLinks(db, repo);

    expect(summary.memoriesProcessed).toBe(0);
    expect(summary.skipped).toBe(1);
    expect(count('entities')).toBe(0);
    expect(count('entity_edges')).toBe(0);
  });

  it('skips blank targets and low-confidence links without throwing', () => {
    seedMemory('m1');
    seedLink('m1', 'Alice Smith', { relation: 'WORKS_AT', confidence: 0.9 });
    seedLink('m1', '   ', { id: 'blank-target', confidence: 0.9 });
    seedLink('m1', 'Weak Entity', { id: 'weak', confidence: 0.1 });

    const summary = syncGraphFromMemoryLinks(db, repo, { minConfidence: 0.3 });

    expect(summary.skipped).toBe(2);
    expect(repo.findByName('Weak Entity')).toBeUndefined();
    expect(count('entity_edges')).toBe(1);
  });

  it('bounds one run by opts.limit and resumes with the next oldest memories', () => {
    for (let index = 0; index < 4; index++) {
      seedMemory(`m${index}`, { createdAt: MEMORY_CREATED_AT + index * 1000 });
      seedLink(`m${index}`, `Entity ${index}`);
    }

    const first = syncGraphFromMemoryLinks(db, repo, { limit: 2 });
    expect(first.memoriesProcessed).toBe(2);
    expect(first.edgesCreated).toBe(2);
    expect(repo.findByName('memory:m0')).toBeDefined();
    expect(repo.findByName('memory:m2')).toBeUndefined();

    // Resumable: the two projected memories drop out of the batch, the next two
    // oldest take their place.
    const second = syncGraphFromMemoryLinks(db, repo, { limit: 2 });
    expect(second.memoriesProcessed).toBe(2);
    expect(repo.findByName('memory:m2')).toBeDefined();
    expect(repo.findByName('memory:m3')).toBeDefined();
    expect(count('entity_edges')).toBe(4);
  });

  it('writes nothing on a dry run but still reports the counts', () => {
    seedMemory('m1');
    seedLink('m1', 'Alice Smith');
    seedLink('m1', 'Acme Corp');

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
      skipped: 0,
      memoriesProcessed: 0,
      linksProcessed: 0,
    });
    expect(count('entities')).toBe(0);
  });

  it('infers organization and person from the name shape, concept otherwise', () => {
    expect(inferEntityType('Acme Corp')).toBe('organization');
    expect(inferEntityType('清华大学')).toBe('organization');
    expect(inferEntityType('Alice Smith')).toBe('person');
    // A two-word Title Case name is indistinguishable from a person's name by
    // shape, so the rule errs toward `person` rather than inventing a category.
    expect(inferEntityType('Power Query')).toBe('person');
    expect(inferEntityType('程语')).toBe('concept');
  });
});

describe('graph-sync: config gate', () => {
  let db: Database.Database;
  let runRepo: MaintenanceRunRepository;
  let scheduler: MaintenanceScheduler;

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
    db.prepare(
      `INSERT INTO memories (id, scope, scope_key, kind, content, created_at, updated_at)
       VALUES ('m1', 'user', 'k', 'fact', 'c', ?, ?)`,
    ).run(String(MEMORY_CREATED_AT), String(MEMORY_CREATED_AT));
    db.prepare(
      `INSERT INTO memory_links (id, source_memory_id, target_entity, relation_type, confidence)
       VALUES ('l1', 'm1', '程语', 'MENTIONED', 0.9)`,
    ).run();

    scheduler.register(createGraphSyncJob(db, resolveGraphSyncConfig({ enabled: false }), logger));

    const results = await scheduler.runDue();
    expect(results).toHaveLength(0);
    expect(runRepo.getRecentRuns()).toHaveLength(0);
    expect((db.prepare('SELECT COUNT(*) AS cnt FROM entities').get() as { cnt: number }).cnt).toBe(
      0,
    );
  });

  it('records exactly one maintenance_runs row per run, named graph_sync', async () => {
    db.prepare(
      `INSERT INTO memories (id, scope, scope_key, kind, content, created_at, updated_at)
       VALUES ('m1', 'user', 'k', 'fact', 'c', ?, ?)`,
    ).run(String(MEMORY_CREATED_AT), String(MEMORY_CREATED_AT));
    db.prepare(
      `INSERT INTO memory_links (id, source_memory_id, target_entity, relation_type, confidence)
       VALUES ('l1', 'm1', '程语', 'MENTIONED', 0.9)`,
    ).run();

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
});
