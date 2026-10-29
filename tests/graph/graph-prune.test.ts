import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { openDatabase } from '../../src/memory/db';
import { EntityRepository } from '../../src/memory/repositories/entity-repository';
import { selfHealGraph } from '../../src/graph/graph-prune';
import { createGraphSyncJob } from '../../src/graph/graph-sync';
import { DEFAULT_GRAPH_SYNC_CONFIG } from '../../src/graph/graph-config';

/**
 * Why this exists: the projector only adds, so tightening a rule left rows the
 * new rules refuse in the graph forever, and `graph:reset` was the only eviction
 * path. That is what made "does the graph need rebuilding?" a real question.
 *
 * The fixture reproduces the local machine's actual state: one edge whose
 * `FOUNDED` keyword comes from "代理已创建 file_info.xlsx" — a file was created,
 * not a company — and one node written twice with different types.
 */
describe('graph-prune: evicting what the current rules refuse', () => {
  let db: Database.Database;
  let repo: EntityRepository;
  const T = 1_700_000_000_000;

  beforeEach(() => {
    db = openDatabase(':memory:');
    repo = new EntityRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  function seedMemory(id: string, content: string): void {
    db.prepare(
      `INSERT INTO memories (id, scope, scope_key, kind, content, status, created_at, updated_at)
       VALUES (?, 'user', 'k', 'fact', ?, 'active', ?, ?)`,
    ).run(id, content, String(T), String(T));
  }

  const count = (table: 'entities' | 'entity_edges'): number =>
    (db.prepare(`SELECT COUNT(*) AS cnt FROM ${table}`).get() as { cnt: number }).cnt;

  it('deletes an edge whose predicate is about something else in the sentence', () => {
    // Verbatim shape from data/app.db: the filing of a file, 98 characters away
    // from the subject and 72 from the object.
    seedMemory(
      'm1',
      '用户要求在 D:\\tmp\\excel-mcp 下新建 Excel 文件，并通过 excel-mcp 使用 Power Query 获取 E:\\Excel 下所有 Excel 文件的文件名、Sheet 数、行数和列数，明确不要使用 Python。代理已创建 file_info.xlsx 并用 excel-mcp 查询。',
    );
    const excel = repo.upsertEntity({ name: 'Excel', entityType: 'concept' });
    const pq = repo.upsertEntity({ name: 'Power Query', entityType: 'concept' });
    repo.linkEntities({
      sourceId: excel.id,
      targetId: pq.id,
      relationType: 'FOUNDED',
      confidence: 0.9,
      sourceMemoryId: 'm1',
    });

    const summary = selfHealGraph(db);

    expect(summary.edgesPruned).toBe(1);
    expect(count('entity_edges')).toBe(0);
    // The nodes stay: the corpus does name Excel and Power Query, and that is
    // what a node claims.
    expect(count('entities')).toBe(2);
  });

  it('keeps an edge a memory actually attests', () => {
    seedMemory('m2', '程语 创立了 Acme Corp，早期只有一个客户。');
    const chengyu = repo.upsertEntity({ name: '程语', entityType: 'person' });
    const acme = repo.upsertEntity({ name: 'Acme Corp', entityType: 'organization' });
    repo.linkEntities({
      sourceId: chengyu.id,
      targetId: acme.id,
      relationType: 'FOUNDED',
      confidence: 0.9,
      sourceMemoryId: 'm2',
    });

    expect(selfHealGraph(db).edgesPruned).toBe(0);
    expect(count('entity_edges')).toBe(1);
  });

  it('leaves closed edges alone — a retracted fact is still history', () => {
    seedMemory('m3', '代理已创建 file_info.xlsx，和 Power Query 无关，但那句话里有 Excel。');
    const excel = repo.upsertEntity({ name: 'Excel', entityType: 'concept' });
    const pq = repo.upsertEntity({ name: 'Power Query', entityType: 'concept' });
    const edge = repo.linkEntities({
      sourceId: excel.id,
      targetId: pq.id,
      relationType: 'FOUNDED',
      confidence: 0.9,
      sourceMemoryId: 'm3',
    });
    repo.retractEdge(edge.id, T + 1000);

    expect(selfHealGraph(db).edgesPruned).toBe(0);
    expect(count('entity_edges')).toBe(1);
  });

  it('merges two nodes for one name and repoints their edges', () => {
    seedMemory('m4', '用 Power Query 合并三张表。');
    // The local machine's real shape: a relation typed it `person`, a mention
    // typed it `concept`.
    const asPerson = repo.upsertEntity({ name: 'Power Query', entityType: 'person' });
    const asConcept = repo.upsertEntity({ name: 'Power Query', entityType: 'concept' });
    const excel = repo.upsertEntity({ name: 'Excel', entityType: 'concept' });
    repo.linkEntities({
      sourceId: asPerson.id,
      targetId: excel.id,
      relationType: 'WORKS_AT',
      confidence: 0.8,
      sourceMemoryId: 'm4',
    });

    const summary = selfHealGraph(db);

    expect(summary.nodesMerged).toBe(1);
    expect(count('entities')).toBe(2);
    // The edge follows the survivor rather than cascading away with the loser.
    expect(count('entity_edges')).toBe(1);
    const keeper = repo.findByName('Power Query')!;
    const edge = db.prepare('SELECT source_entity_id FROM entity_edges').get() as {
      source_entity_id: string;
    };
    expect(edge.source_entity_id).toBe(keeper.id);
    // The survivor is the edge-bearing copy (`person`), not an alphabetical pick.
    expect(keeper.entity_type).toBe('person');
  });

  it('is idempotent and reports zero on a second run', () => {
    seedMemory(
      'm5',
      '用户要求在 D:\tmp\excel-mcp 下新建 Excel 文件，并通过 excel-mcp 使用 Power Query 获取 E:\Excel 下所有 Excel 文件的文件名、Sheet 数、行数和列数，明确不要使用 Python。代理已创建 file_info.xlsx 并用 excel-mcp 查询。',
    );
    const excel = repo.upsertEntity({ name: 'Excel', entityType: 'concept' });
    repo.upsertEntity({ name: 'Power Query', entityType: 'person' });
    repo.upsertEntity({ name: 'Power Query', entityType: 'concept' });
    const pq = repo.findByName('Power Query')!;
    repo.linkEntities({
      sourceId: excel.id,
      targetId: pq.id,
      relationType: 'FOUNDED',
      confidence: 0.9,
      sourceMemoryId: 'm5',
    });

    selfHealGraph(db);
    expect(selfHealGraph(db)).toEqual({ edgesPruned: 0, nodesMerged: 0 });
  });

  it('writes nothing on a dry run but reports what it would do', () => {
    seedMemory(
      'm6',
      '用户要求在 D:\tmp\excel-mcp 下新建 Excel 文件，并通过 excel-mcp 使用 Power Query 获取 E:\Excel 下所有 Excel 文件的文件名、Sheet 数、行数和列数，明确不要使用 Python。代理已创建 file_info.xlsx 并用 excel-mcp 查询。',
    );
    const excel = repo.upsertEntity({ name: 'Excel', entityType: 'concept' });
    repo.upsertEntity({ name: 'Power Query', entityType: 'person' });
    repo.upsertEntity({ name: 'Power Query', entityType: 'concept' });
    const pq = repo.findByName('Power Query')!;
    repo.linkEntities({
      sourceId: excel.id,
      targetId: pq.id,
      relationType: 'FOUNDED',
      confidence: 0.9,
      sourceMemoryId: 'm6',
    });
    const entitiesBefore = count('entities');
    const edgesBefore = count('entity_edges');

    const summary = selfHealGraph(db, { dryRun: true });

    expect(summary).toEqual({ edgesPruned: 1, nodesMerged: 1 });
    expect(count('entities')).toBe(entitiesBefore);
    expect(count('entity_edges')).toBe(edgesBefore);
  });

  it('runs from the scheduled job, so no operator has to remember it', async () => {
    seedMemory(
      'm7',
      '用户要求在 D:\tmp\excel-mcp 下新建 Excel 文件，并通过 excel-mcp 使用 Power Query 获取 E:\Excel 下所有 Excel 文件的文件名、Sheet 数、行数和列数，明确不要使用 Python。代理已创建 file_info.xlsx 并用 excel-mcp 查询。',
    );
    const excel = repo.upsertEntity({ name: 'Excel', entityType: 'concept' });
    repo.upsertEntity({ name: 'Power Query', entityType: 'person' });
    repo.upsertEntity({ name: 'Power Query', entityType: 'concept' });
    const pq = repo.findByName('Power Query')!;
    repo.linkEntities({
      sourceId: excel.id,
      targetId: pq.id,
      relationType: 'FOUNDED',
      confidence: 0.9,
      sourceMemoryId: 'm7',
    });

    const job = createGraphSyncJob(db, DEFAULT_GRAPH_SYNC_CONFIG);
    const result = await job.run({ dryRun: false });

    expect(result.status).toBe('success');
    expect(result.details).toMatchObject({ healed: { edgesPruned: 1, nodesMerged: 1 } });
    expect(count('entity_edges')).toBe(0);
  });
});
