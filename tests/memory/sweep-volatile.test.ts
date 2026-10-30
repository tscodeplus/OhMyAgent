/**
 * `pnpm memory:sweep-volatile` — plan §4's historical cleanup.
 *
 * The sweep exists because changing `writePreference()`'s kind rule only affects
 * new writes: rows already stored with `kind = 'preference'` are exempt from
 * retention and stay forever. What matters in these tests is the boundary the
 * script refuses to cross — a name stays, an unprovable row stays, and nothing is
 * written without `--apply`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { openDatabase } from '../../src/memory/db';
import { MemoryRepository } from '../../src/memory/repositories/memory-repository';
import { EmbeddingRepository } from '../../src/memory/repositories/embedding-repository';
import { generateId } from '../../src/shared/ids';
import { judgeSweepRow, sweepVolatilePreferences } from '../../scripts/memory-sweep-volatile';

describe('memory:sweep-volatile', () => {
  let db: Database.Database;
  let repo: MemoryRepository;

  beforeEach(() => {
    db = openDatabase(':memory:');
    repo = new MemoryRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  function seed(content: string): string {
    const id = generateId();
    repo.upsert({
      id,
      scope: 'user',
      scope_key: 'session-1',
      kind: 'preference',
      content,
    });
    new EmbeddingRepository(db).create({
      id: generateId(),
      memory_id: id,
      embedding: new Float32Array([0.1, 0.2, 0.3, 0.4]),
      model: 'test',
      dimension: 4,
    });
    return id;
  }

  function kindOf(id: string): string | undefined {
    const row = db.prepare('SELECT kind FROM memories WHERE id = ?').get(id) as
      { kind: string } | undefined;
    return row?.kind;
  }

  it('downgrades a volatile preference and leaves a name alone', () => {
    expect(
      judgeSweepRow({ kind: 'preference', content: 'E:\\Excel 目录下当前有 4 个 Excel 文件' }),
    ).toEqual({ verdict: 'downgrade', reason: 'volatile' });
    expect(judgeSweepRow({ kind: 'preference', content: '用户要求回复控制在20词以内' })).toEqual({
      verdict: 'downgrade',
      reason: 'volatile',
    });
    // A name is falsifiable and read side depends on it — §3.1 keeps these as
    // `preference`, so the sweep must not touch them even if the wording is odd.
    expect(judgeSweepRow({ kind: 'preference', content: '以后称呼我为大拿' })).toEqual({
      verdict: 'keep',
      reason: 'preferred_name',
    });
    expect(judgeSweepRow({ kind: 'preference', content: '用户偏好使用 pnpm' })).toEqual({
      verdict: 'keep',
      reason: 'not_provable',
    });
  });

  it('writes nothing on a dry run', () => {
    const id = seed('E:\\Excel 目录下当前有 4 个 Excel 文件');

    const summary = sweepVolatilePreferences(db, { apply: false });

    expect(summary.dryRun).toBe(true);
    expect(summary.downgraded).toBe(1);
    expect(kindOf(id)).toBe('preference');
  });

  it('downgrades to `fact` with --apply, keeping the row searchable', () => {
    const id = seed('E:\\Excel 目录下当前有 4 个 Excel 文件');

    const summary = sweepVolatilePreferences(db, { apply: true });

    expect(summary.downgraded).toBe(1);
    expect(kindOf(id)).toBe('fact');
    // Still there: the point is to hand it to hygiene's horizon, not to hide it.
    expect(repo.findById(id)).toBeDefined();
  });

  it('deletes through the repositories, taking the vector with it', () => {
    const id = seed('E:\\Excel 目录下当前有 4 个 Excel 文件');

    const summary = sweepVolatilePreferences(db, { apply: true, delete: true });

    expect(summary.deleted).toBe(1);
    expect(summary.downgraded).toBe(0);
    expect(repo.findById(id)).toBeUndefined();
    const vectors = db
      .prepare('SELECT COUNT(*) AS n FROM memory_embeddings WHERE memory_id = ?')
      .get(id) as { n: number };
    expect(vectors.n).toBe(0);
  });

  it('reports the verdict it will apply when --delete is combined with a dry run', () => {
    // `--delete` without `--apply` is refused at the CLI, but the library folds the
    // verdict anyway so the printed table never says "downgrade" for rows the
    // caller intends to delete.
    seed('E:\\Excel 目录下当前有 4 个 Excel 文件');
    const summary = sweepVolatilePreferences(db, { apply: false, delete: true });
    expect(summary.rows[0]?.verdict).toBe('delete');
    expect(summary.deleted).toBe(1);
  });
});
