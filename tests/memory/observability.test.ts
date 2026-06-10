import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema } from '../../src/memory/schema.js';
import {
  attachMemoryObservabilityDb,
  errorForObservation,
  hashForObservation,
  memoryObservability,
} from '../../src/memory/observability.js';

describe('memoryObservability', () => {
  beforeEach(() => {
    memoryObservability.clear();
  });

  it('records counts and recent events without storing raw content', () => {
    memoryObservability.record('memory.embedding.failed', {
      contentHash: hashForObservation('raw private content'),
      error: errorForObservation(new Error('provider failed')),
    });

    const report = memoryObservability.snapshot();
    expect(report.total).toBe(1);
    expect(report.counts['memory.embedding.failed']).toBe(1);
    expect(report.recent[0].details?.contentHash).toHaveLength(16);
    expect(report.recent[0].details?.contentHash).not.toBe('raw private content');
  });

  it('can be cleared between diagnostic runs', () => {
    memoryObservability.record('memory.fts.failed');
    expect(memoryObservability.snapshot().total).toBe(1);

    memoryObservability.clear();
    expect(memoryObservability.snapshot().total).toBe(0);
  });

  it('persists observations in sqlite across sink snapshots', () => {
    const db = new Database(':memory:');
    applySchema(db);
    attachMemoryObservabilityDb(db);

    memoryObservability.record('memory.vector.failed', { queryHash: hashForObservation('query') });
    const persisted = memoryObservability.snapshot();

    expect(persisted.total).toBe(1);
    expect(persisted.counts['memory.vector.failed']).toBe(1);
    expect(persisted.recent[0].details?.queryHash).toHaveLength(16);

    memoryObservability.clear();
    db.close();
  });
});
