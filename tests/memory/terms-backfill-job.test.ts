import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema } from '../../src/memory/schema';
import { createTermsBackfillJob } from '../../src/memory/maintenance/jobs/terms-backfill-job';
import { MemoryRepository } from '../../src/memory/repositories/memory-repository';

describe('terms backfill job', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db);
    // Memories written without terms (bulk import path).
    for (const content of ['用户偏好使用 Windows 操作系统记事本', '今天是周三下午的会议安排']) {
      new MemoryRepository(db).create({
        id: `mem-${Math.random().toString(36).slice(2)}`,
        scope: 'user',
        scope_key: 'default',
        kind: 'preference',
        content,
      });
    }
  });

  afterEach(() => {
    db.close();
  });

  it('dryRun reports the gap without writing', async () => {
    const job = createTermsBackfillJob(db);
    const result = await job.run({ dryRun: true });
    expect(result.status).toBe('success');
    expect(result.dryRun).toBe(true);
    expect((result.details as { missingCount: number }).missingCount).toBe(2);
    expect((db.prepare('SELECT COUNT(*) n FROM memory_terms').get() as { n: number }).n).toBe(0);
  });

  it('extracts terms for memories missing them', async () => {
    const job = createTermsBackfillJob(db);
    const result = await job.run({ dryRun: false });
    expect(result.status).toBe('success');
    expect(result.affectedRows).toBe(2);
    expect(
      (db.prepare('SELECT COUNT(*) n FROM memory_terms').get() as { n: number }).n,
    ).toBeGreaterThan(0);
    // Idempotent: second pass finds nothing
    const second = await job.run({ dryRun: false });
    expect(second.affectedRows).toBe(0);
  });

  it('reports placeholder-content rows separately instead of fake progress', async () => {
    const { MemoryRepository } = await import('../../src/memory/repositories/memory-repository.js');
    new MemoryRepository(db).create({
      id: 'mem-na-1',
      scope: 'user',
      scope_key: 'default',
      kind: 'preference',
      content: 'N/A',
    });
    const job = createTermsBackfillJob(db);
    const result = await job.run({ dryRun: false });
    expect(result.affectedRows).toBe(2);
    expect((result.details as { noExtractableTerms: number }).noExtractableTerms).toBe(1);
  });
});
