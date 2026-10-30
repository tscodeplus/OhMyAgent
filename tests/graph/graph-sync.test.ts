import { createHash } from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { Logger } from 'pino';
import { applySchema } from '../../src/memory/schema';
import { migrateV10 } from '../../src/memory/migration-v10';
import { migrateV23 } from '../../src/memory/migration-v23';
import { EntityRepository, type EntityEdge } from '../../src/memory/repositories/entity-repository';
import { LINK_REFUSAL_RULE_VERSION } from '../../src/graph/entity-mining';
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
    // The mention target gained a node but no edge: "this corpus names Power
    // Query" is what the row asserts, "Excel founded Power Query" is not.
    expect(repo.findByName('Power Query')).toBeDefined();
  });

  it('admits a node for a memory whose only rows are MENTIONED, but no edge', () => {
    seedMemory('m5');
    seedLink('m5', 'Power Query', { relation: 'MENTIONED', subject: 'Excel' });

    const summary = syncGraphFromMemoryLinks(db, repo);

    expect(summary.linksProcessed).toBe(0);
    expect(summary.mentionNodesAdmitted).toBe(2);
    expect(count('entity_edges')).toBe(0);
    // The whole point of the split: a name the corpus talks about is a node even
    // when no memory states a fact about it (Ubuntu on the reference device had
    // 38 mentioning memories and 0 statements).
    expect(count('entities')).toBe(2);
    expect(repo.findByName('Power Query')).toBeDefined();
    expect(repo.findByName('Excel')).toBeDefined();
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

  it('admits a node for a memory whose rows all lack a subject, but no edge', () => {
    seedMemory('m6');
    seedLink('m6', 'Acme Corp', { relation: 'FOUNDED', confidence: 0.95, subject: null });

    const summary = syncGraphFromMemoryLinks(db, repo);

    expect(summary.linksProcessed).toBe(0);
    expect(count('entity_edges')).toBe(0);
    // The subject is unknown — which is the truthful answer — but the memory does
    // name Acme Corp, so the name exists as a node. (`linksWithoutSubject` stays
    // 0 here: that counter only sees rows inside the edge batch, and a memory
    // with no edge-eligible row never enters it.)
    expect(count('entities')).toBe(1);
    expect(repo.findByName('Acme Corp')).toBeDefined();
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
    expect(second.mentionNodesCreated).toBe(0);
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
    // Nodes are a whole-corpus view, not a per-run window: `limit` bounds the
    // *links* one run projects, so Entity 2 has a node while still having no
    // edge. Resumption is about edges, which is what the next assertions check.
    expect(repo.findByName('Entity 2')).toBeDefined();
    expect(count('entity_edges')).toBe(2);

    // Resumable: the two projected memories drop out of the batch, the next two
    // oldest take their place.
    const second = syncGraphFromMemoryLinks(db, repo, { limit: 2 });
    expect(second.memoriesProcessed).toBe(2);
    expect(second.edgesCreated).toBe(2);
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
      mentionNodesAdmitted: 0,
      mentionNodesCreated: 0,
      skipped: 0,
      memoriesProcessed: 0,
      linksProcessed: 0,
      memoriesFresh: 0,
      memoriesStuck: 0,
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
      projectMentionNodes: true,
      maxMentionNodes: 2000,
    });
  });

  it('can be told to keep nodes edge-only, and rejects a non-boolean switch', () => {
    // The switch exists for an operator who wants the graph to contain only
    // asserted facts; `resolveGraphSyncConfig` must not silently coerce.
    expect(resolveGraphSyncConfig({ project_mention_nodes: false }).projectMentionNodes).toBe(
      false,
    );
    expect(() =>
      resolveGraphSyncConfig({ project_mention_nodes: 'no' as unknown as boolean }),
    ).toThrow(/project_mention_nodes/);
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

/**
 * The projector's refusal ledger (migration v23): a memory whose every
 * edge-eligible link the JS gates refuse stops being re-scanned every run, and
 * Batch slots can no longer be filled by a backlog of refusable rows.
 */
describe('graph-sync: link-refusal ledger (migration v23)', () => {
  let db: Database.Database;
  let repo: EntityRepository;

  function seedMemory(id: string, content: string, createdAt: number = MEMORY_CREATED_AT): void {
    db.prepare(
      `INSERT INTO memories (id, scope, scope_key, kind, content, status, created_at, updated_at)
       VALUES (?, 'user', 'k', 'fact', ?, 'active', ?, ?)`,
    ).run(id, content, String(createdAt), String(createdAt));
  }

  /**
   * Verbatim deterministic gate-refusal fixtures, both measured refusal shapes:
   *   - ADVISES whose only 建议 sits 65+ characters from every endpoint mention
   *     (a keyword in a different clause);
   *   - PART_OF whose endpoints merely share the sentence with no part-of
   *     wording.
   * Names that never occur in the content would fail open (unverifiable, not
   * disproven), so a refusal fixture has to be refusable — otherwise the link
   * projects and the ledger is pointless.
   */
  const REFUSED_FIXTURES = {
    advisesFar: {
      memory_id: '',
      content:
        'Alice Smith 和 Acme Corp 谈过一次工作安排。这一段只是叙述背景，包含天气、提交记录、若干路径与配置片段，后面一直没有再展开过任何相关讨论。结尾附录里有一条建议：等待明天。',
      subject: 'Alice Smith',
      target: 'Acme Corp',
      relation: 'ADVISES',
    },
    partUnattested: {
      memory_id: '',
      content: '效果不错，通过 excel-mcp 使用 Power Query 完成。',
      subject: 'excel-mcp',
      target: 'Power Query',
      relation: 'PART_OF',
    },
  } as const;

  function seedRefused(
    id: string,
    fixture: keyof typeof REFUSED_FIXTURES,
    createdAt: number = MEMORY_CREATED_AT,
  ): void {
    const row = REFUSED_FIXTURES[fixture];
    seedMemory(id, row.content, createdAt);
    db.prepare(
      `INSERT INTO memory_links (id, source_memory_id, target_entity, relation_type, confidence,
                                 subject_entity)
       VALUES (?, ?, ?, ?, 0.9, ?)`,
    ).run(`l-${id}`, id, row.target, row.relation, row.subject);
  }

  function seedProjectableMemory(id: string, createdAt: number = MEMORY_CREATED_AT): void {
    seedMemory(id, 'Alice Smith 创立了 Acme Corp。', createdAt);
    db.prepare(
      `INSERT INTO memory_links (id, source_memory_id, target_entity, relation_type, confidence,
                                 subject_entity, subject_entity_type)
       VALUES (?, ?, 'Acme Corp', 'FOUNDED', 0.9, 'Alice Smith', 'person')`,
    ).run(`l-${id}`, id);
  }

  const ledgerRows = () =>
    db.prepare('SELECT * FROM entity_link_refusals ORDER BY memory_id').all() as Array<{
      memory_id: string;
      content_hash: string;
      rule_version: number;
      decided_at: number;
    }>;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applySchema(db);
    migrateV10(db);
    migrateV23(db);
    repo = new EntityRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('details a refused backlog run as skipped, distinguishing stuck from fresh', async () => {
    // Two gate-refused memories: the job reports the refusals as `stuck`
    // instead of blending them into `skipped`, so an operator can tell "nothing
    // new" from "new garbage refused once".
    seedRefused('s1', 'advisesFar');
    seedRefused('s2', 'partUnattested', MEMORY_CREATED_AT + 1000);

    const result = await createGraphSyncJob(db, resolveGraphSyncConfig(undefined), logger).run({
      dryRun: false,
    });

    expect(result.status).toBe('skipped');
    const details = result.details as {
      reason: string;
      memoriesFresh: number;
      memoriesStuck: number;
    };
    expect(details.reason).toBe('no_projectable_links');
    expect(details.memoriesStuck).toBe(2);
    expect(details.memoriesFresh).toBe(2);
  });

  it('creates the table once and replays as a no-op', () => {
    const first = migrateV23(db);
    expect(first.created).toBe(false);
    expect(first.verified).toBe(true);
    expect(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type = 'table' AND name = 'entity_link_refusals'",
          )
          .get() as { cnt: number }
      ).cnt,
    ).toBe(1);
  });

  it('ledgers refused memories and frees the batch slots for fresh ones', () => {
    seedRefused('s1', 'advisesFar');
    seedRefused('s2', 'partUnattested', MEMORY_CREATED_AT + 1000);
    // Older than the batch would reach on the first run (memory limit 2):
    // without the ledger it always stays behind the two stuck memories.
    seedProjectableMemory('fresh', MEMORY_CREATED_AT + 2000);

    const first = syncGraphFromMemoryLinks(db, repo, { limit: 2 });
    expect(first.memoriesProcessed).toBe(0);
    expect(first.memoriesStuck).toBe(2);
    expect(first.memoriesFresh).toBe(2);
    expect(ledgerRows()).toEqual([
      expect.objectContaining({
        memory_id: 's1',
        rule_version: LINK_REFUSAL_RULE_VERSION,
        content_hash: createHash('sha256')
          .update(REFUSED_FIXTURES.advisesFar.content)
          .digest('hex'),
      }),
      expect.objectContaining({
        memory_id: 's2',
        rule_version: LINK_REFUSAL_RULE_VERSION,
        content_hash: createHash('sha256')
          .update(REFUSED_FIXTURES.partUnattested.content)
          .digest('hex'),
      }),
    ]);

    // The run after the ledger: the stuck memories are invisible to the batch
    // and the projectable memory takes the slot that used to be starved.
    const second = syncGraphFromMemoryLinks(db, repo, { limit: 2 });
    expect(second.memoriesProcessed).toBe(1);
    expect(second.linksProcessed).toBe(1);
    expect(second.memoriesStuck).toBe(0);
    expect(second.edgesCreated).toBe(1);
    expect(ledgerRows()).toHaveLength(2);
  });

  it('re-evaluates (and rewrites) the verdict when the rule version changes', () => {
    seedRefused('s1', 'advisesFar');
    const oldVersion = LINK_REFUSAL_RULE_VERSION + 1;
    db.prepare(
      `INSERT INTO entity_link_refusals (memory_id, content_hash, rule_version, decided_at)
       VALUES ('s1', 'stale', ?, ?)`,
    ).run(oldVersion, Date.now());

    syncGraphFromMemoryLinks(db, repo);

    // A rule-version mismatch puts the memory back into the batch; the gates
    // still refuse, so the row is rewritten under the current version instead
    // of hiding the memory forever.
    const [row] = ledgerRows();
    expect(row.rule_version).toBe(LINK_REFUSAL_RULE_VERSION);
    expect(row.content_hash).toBe(
      createHash('sha256').update(REFUSED_FIXTURES.advisesFar.content).digest('hex'),
    );
  });

  it('re-opens a ledgered memory whose content was edited (decided_at < updated_at)', () => {
    seedProjectableMemory('m1');
    const decidedAt = Date.now() - 10_000;
    db.prepare(
      `INSERT INTO entity_link_refusals (memory_id, content_hash, rule_version, decided_at)
       VALUES ('m1', 'stale', ?, ?)`,
    ).run(LINK_REFUSAL_RULE_VERSION, decidedAt);

    // Fresh verdict: the memory stays hidden.
    syncGraphFromMemoryLinks(db, repo);
    expect(ledgerRows()).toHaveLength(1);

    // Content edit bumps updated_at past the verdict, so the next run
    // re-evaluates — and projects, which clears the row.
    db.prepare(`UPDATE memories SET content = ?, updated_at = ? WHERE id = ?`).run(
      'Alice Smith 创立了 Acme Corp。',
      String(decidedAt + 1000),
      'm1',
    );
    const edited = syncGraphFromMemoryLinks(db, repo);
    expect(edited.memoriesProcessed).toBe(1);
    expect(edited.edgesCreated).toBe(1);
    expect(ledgerRows()).toEqual([]);
  });

  it('never ledgers a memory that projected', () => {
    seedProjectableMemory('m1');

    const summary = syncGraphFromMemoryLinks(db, repo);
    expect(summary.memoriesProcessed).toBe(1);
    expect(summary.memoriesStuck).toBe(0);
    expect(ledgerRows()).toEqual([]);
  });

  it('reports the stuck count on a dry run without redirecting the next real run', () => {
    seedRefused('s1', 'advisesFar');

    const rehearsal = syncGraphFromMemoryLinks(db, repo, { dryRun: true });
    expect(rehearsal.memoriesStuck).toBe(1);
    expect(rehearsal.memoriesFresh).toBe(1);
    expect(ledgerRows()).toEqual([]);

    const real = syncGraphFromMemoryLinks(db, repo);
    expect(real.memoriesStuck).toBe(1);
    expect(ledgerRows()).toHaveLength(1);
  });

  it('keeps the ledger rows across a legacy-cleanup projection (verdicts survive graph:reset)', () => {
    seedRefused('s1', 'advisesFar');

    syncGraphFromMemoryLinks(db, repo);
    expect(ledgerRows()).toHaveLength(1);

    // Deleting edges (what graph:reset / self-heal do) must not forget the
    // verdict, but neither may it outlive the rules: another run reaches the
    // same refusal from the same gates.
    db.prepare(
      'DELETE FROM entity_edges WHERE source_entity_id IN (SELECT id FROM entities)',
    ).run();
    syncGraphFromMemoryLinks(db, repo);
    expect(ledgerRows()).toHaveLength(1);
  });
});
