import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { Logger } from 'pino';
import { applySchema } from '../../src/memory/schema';
import { migrateV10 } from '../../src/memory/migration-v10';
import { EntityRepository, type EntityEdge } from '../../src/memory/repositories/entity-repository';
import {
  GRAPH_SYNC_JOB_NAME,
  MENTION_RELATION_TYPE,
  createGraphSyncJob,
  mineGraphFromMemories,
  syncGraphFromMemoryLinks,
} from '../../src/graph/graph-sync';
import { resolveGraphSyncConfig } from '../../src/graph/graph-config';

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

const MEMORY_CREATED_AT = 1_700_000_000_000;

const EXCEL_MEMORY =
  '用户要求在 D:\\tmp\\excel-mcp 下新建 Excel 文件，并通过 excel-mcp 使用 Power Query 获取 E:\\Excel 下所有 Excel 文件的文件名和 Sheet 数。';

describe('graph-sync: mention mining of unlinked memories', () => {
  let db: Database.Database;
  let repo: EntityRepository;

  function seedMemory(id: string, content: string, options: { createdAt?: number } = {}): void {
    const createdAt = options.createdAt ?? MEMORY_CREATED_AT;
    db.prepare(
      `INSERT INTO memories (id, scope, scope_key, kind, content, status, created_at, updated_at)
       VALUES (?, 'user', 'k', 'fact', ?, 'active', ?, ?)`,
    ).run(id, content, String(createdAt), String(createdAt));
  }

  function edges(relationType: string): EntityEdge[] {
    return db
      .prepare('SELECT * FROM entity_edges WHERE relation_type = ?')
      .all(relationType) as EntityEdge[];
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

  it('mines an Excel/Power Query memory into entities and MENTIONED edges', () => {
    seedMemory('m1', EXCEL_MEMORY);

    const summary = mineGraphFromMemories(db, repo);

    expect(summary.memoriesMined).toBe(1);
    expect(summary.edgesCreated).toBe(summary.mentionsMined - 1);

    const excel = repo.findByName('Excel');
    const powerQuery = repo.findByName('Power Query');
    const excelMcp = repo.findByName('excel-mcp');
    expect(excel).toBeDefined();
    expect(powerQuery).toBeDefined();
    expect(excelMcp).toBeDefined();

    const mentioned = edges(MENTION_RELATION_TYPE);
    expect(mentioned.length).toBe(summary.edgesCreated);
    // The most confident mention is the memory's subject; the rest hang off it,
    // so the mined nodes are connected to each other instead of each sitting
    // behind its own placeholder node.
    expect(mentioned[0]?.source_entity_id).toBe(excel!.id);
    for (const edge of mentioned) {
      expect(edge.source_memory_id).toBe('m1');
      expect(edge.valid_from).toBe(MEMORY_CREATED_AT);
      expect(edge.confidence).toBeGreaterThan(0);
      expect(edge.confidence).toBeLessThanOrEqual(1);
    }
    const targets = mentioned.map((edge) => edge.target_entity_id);
    expect(targets).toContain(powerQuery!.id);
    expect(targets).toContain(excelMcp!.id);
  });

  it('mines CJK content into a connected subject/target pair', () => {
    seedMemory('m-cjk', '希望把知识图谱接入飞书');

    const summary = mineGraphFromMemories(db, repo);

    expect(summary.memoriesMined).toBe(1);
    const graph = repo.findByName('知识图谱');
    const feishu = repo.findByName('飞书');
    expect(graph).toBeDefined();
    expect(feishu).toBeDefined();

    const mentioned = edges(MENTION_RELATION_TYPE);
    expect(mentioned).toHaveLength(1);
    expect(mentioned[0]?.source_entity_id).toBe(graph!.id);
    expect(mentioned[0]?.target_entity_id).toBe(feishu!.id);
    expect(mentioned[0]?.source_memory_id).toBe('m-cjk');
  });

  it('uses the memory placeholder when only one mention is found', () => {
    seedMemory('m-one', '记忆系统');

    const summary = mineGraphFromMemories(db, repo);

    expect(summary.memoriesMined).toBe(1);
    expect(summary.edgesCreated).toBe(1);
    const placeholder = repo.findByName('memory:m-one', 'memory');
    const topic = repo.findByName('记忆系统');
    expect(placeholder).toBeDefined();
    expect(topic).toBeDefined();
    expect(edges(MENTION_RELATION_TYPE)[0]?.source_entity_id).toBe(placeholder!.id);
  });

  it('writes no new rows on a second run', () => {
    seedMemory('m1', EXCEL_MEMORY, { createdAt: MEMORY_CREATED_AT });

    const first = mineGraphFromMemories(db, repo);
    expect(first.edgesCreated).toBeGreaterThan(0);

    const entitiesAfterFirst = count('entities');
    const edgesAfterFirst = count('entity_edges');

    const second = mineGraphFromMemories(db, repo);

    expect(second).toEqual({
      memoriesMined: 0,
      mentionsMined: 0,
      entitiesCreated: 0,
      entitiesMatched: 0,
      edgesCreated: 0,
      edgesRefreshed: 0,
      skipped: 0,
    });
    expect(count('entities')).toBe(entitiesAfterFirst);
    expect(count('entity_edges')).toBe(edgesAfterFirst);
  });

  it('leaves a memory alone once the link projection gave it a MENTIONED edge', () => {
    seedMemory('m-linked', EXCEL_MEMORY);
    db.prepare(
      `INSERT INTO memory_links (id, source_memory_id, target_entity, relation_type, confidence)
       VALUES ('l1', 'm-linked', '程语', 'MENTIONED', 0.9)`,
    ).run();
    // The job runs the link projection first; that is what materialises the
    // edge the mining pass then treats as "already covered".
    syncGraphFromMemoryLinks(db, repo);
    const entitiesAfterProjection = count('entities');

    const summary = mineGraphFromMemories(db, repo);

    expect(summary.memoriesMined).toBe(0);
    expect(count('entities')).toBe(entitiesAfterProjection);
  });

  it('reports counts but writes nothing on a dry run', () => {
    seedMemory('m1', EXCEL_MEMORY);

    const summary = mineGraphFromMemories(db, repo, { dryRun: true });

    expect(summary.memoriesMined).toBe(1);
    expect(summary.entitiesCreated).toBeGreaterThan(0);
    expect(summary.edgesCreated).toBeGreaterThan(0);
    expect(count('entities')).toBe(0);
    expect(count('entity_edges')).toBe(0);
  });

  it('bounds one run by opts.limit and resumes with the next oldest memories', () => {
    seedMemory('m0', 'Excel');
    seedMemory('m1', 'TypeScript', { createdAt: MEMORY_CREATED_AT + 1000 });

    const first = mineGraphFromMemories(db, repo, { limit: 1 });
    expect(first.memoriesMined).toBe(1);
    expect(repo.findByName('memory:m0')).toBeDefined();
    expect(repo.findByName('memory:m1')).toBeUndefined();

    const second = mineGraphFromMemories(db, repo, { limit: 1 });
    expect(second.memoriesMined).toBe(1);
    expect(repo.findByName('memory:m1')).toBeDefined();
  });

  it('skips memories with nothing minable', () => {
    seedMemory('m-empty', '12345 !!! 🎉');

    const summary = mineGraphFromMemories(db, repo);

    expect(summary.memoriesMined).toBe(0);
    expect(summary.skipped).toBe(1);
    expect(count('entity_edges')).toBe(0);
  });
});

describe('graph-sync: mention mining in the graph_sync job', () => {
  let db: Database.Database;

  function seedMemory(id: string, content: string): void {
    db.prepare(
      `INSERT INTO memories (id, scope, scope_key, kind, content, created_at, updated_at)
       VALUES (?, 'user', 'k', 'fact', ?, ?, ?)`,
    ).run(id, content, String(MEMORY_CREATED_AT), String(MEMORY_CREATED_AT));
  }

  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db);
    migrateV10(db);
  });

  afterEach(() => {
    db.close();
  });

  it('mines through the job and reports the mined counts in details', async () => {
    seedMemory('m1', EXCEL_MEMORY);

    const result = await createGraphSyncJob(db, resolveGraphSyncConfig(undefined), logger).run({
      dryRun: false,
    });

    expect(result.name).toBe(GRAPH_SYNC_JOB_NAME);
    expect(result.status).toBe('success');
    expect(result.affectedRows).toBeGreaterThan(0);
    const mined = result.details?.mined as { memoriesMined: number; edgesCreated: number };
    expect(mined.memoriesMined).toBe(1);
    expect(mined.edgesCreated).toBe(result.affectedRows);
    expect(
      (db.prepare('SELECT COUNT(*) AS cnt FROM entities').get() as { cnt: number }).cnt,
    ).toBeGreaterThan(0);
  });

  it('does not mine when memory.graph.mine_mentions is false', async () => {
    seedMemory('m1', EXCEL_MEMORY);

    const result = await createGraphSyncJob(
      db,
      resolveGraphSyncConfig({ mine_mentions: false }),
      logger,
    ).run({ dryRun: false });

    expect(result.status).toBe('skipped');
    expect(result.affectedRows).toBe(0);
    expect(
      (db.prepare('SELECT COUNT(*) AS cnt FROM entity_edges').get() as { cnt: number }).cnt,
    ).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS cnt FROM entities').get() as { cnt: number }).cnt).toBe(
      0,
    );
  });

  it('reports skipped when there is nothing to project or mine', async () => {
    seedMemory('m1', '12345');

    const result = await createGraphSyncJob(db, resolveGraphSyncConfig(undefined), logger).run({
      dryRun: false,
    });

    expect(result.status).toBe('skipped');
    expect(result.affectedRows).toBe(0);
    expect(result.details?.reason).toBe('no_projectable_links');
    expect(result.details?.mined).toBeDefined();
  });
});

/**
 * Corpus-level filtering: once there are enough memories to have statistics, a
 * name seen in only one of them is a sentence fragment, not a topic.
 *
 * jieba emits plenty of plausible-looking but meaningless two-character tokens
 * ("问过", "白天"), and per-memory heuristics cannot tell them apart from real
 * topics. Across a batch the difference is obvious, so the mining pass measures
 * document frequency before writing anything.
 */
describe('graph-sync: corpus filter for mined mentions', () => {
  let db: Database.Database;
  let repo: EntityRepository;

  function seedMemory(id: string, content: string, offset: number): void {
    const createdAt = MEMORY_CREATED_AT + offset;
    db.prepare(
      `INSERT INTO memories (id, scope, scope_key, kind, content, status, created_at, updated_at)
       VALUES (?, 'user', 'k', 'fact', ?, 'active', ?, ?)`,
    ).run(id, content, String(createdAt), String(createdAt));
  }

  function entityNames(): string[] {
    return (db.prepare('SELECT name FROM entities').all() as Array<{ name: string }>).map(
      (row) => row.name,
    );
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

  it('drops a one-off fragment but keeps a topic the corpus repeats', () => {
    // "ChromaDB" recurs; "问过" appears once.
    seedMemory('d1', '使用 ChromaDB 做向量检索', 0);
    seedMemory('d2', 'ChromaDB 的检索效果不错', 1_000);
    seedMemory('d3', '还是用 ChromaDB 更省事', 2_000);
    seedMemory('d4', '我昨天问过这个问题', 3_000);
    seedMemory('d5', '今天继续整理笔记', 4_000);

    mineGraphFromMemories(db, repo);

    const names = entityNames();
    expect(names).toContain('ChromaDB');
    expect(names).not.toContain('问过');
  });

  it('does not apply the cutoff while the corpus is too small to measure', () => {
    // Two memories cannot support a document-frequency cutoff: with only one
    // occurrence each, every name looks like a fragment.
    seedMemory('s1', EXCEL_MEMORY, 0);
    seedMemory('s2', '用户偏好使用 excel-mcp，而不是 Python', 1_000);

    mineGraphFromMemories(db, repo);

    const names = entityNames();
    expect(names).toContain('Excel');
    expect(names).toContain('Power Query');
    expect(names).toContain('Python');
  });

  it('keeps a name the graph already knows even when the batch mentions it once', () => {
    repo.upsertEntity({ name: 'ChromaDB', entityType: 'concept' });
    seedMemory('k1', '使用 ChromaDB 做向量检索', 0);
    seedMemory('k2', '整理一下项目笔记', 1_000);
    seedMemory('k3', '写一点周报', 2_000);
    seedMemory('k4', '再看一眼文档', 3_000);

    mineGraphFromMemories(db, repo);

    // Dropping it would make the graph oscillate between runs as batches slide.
    expect(entityNames()).toContain('ChromaDB');
  });
});
