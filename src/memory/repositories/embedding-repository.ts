import type Database from 'better-sqlite3';
import { loadSqliteVec, probeSqliteVec, sqliteVecAvailable, sqliteVecTableReady, vecDelete, vecInsert, vecSearch } from '../sqlite-vec.js';
import { errorForObservation, memoryObservability } from '../observability.js';

export interface MemoryEmbedding {
  id: string;
  memory_id: string;
  embedding: Buffer;
  model: string;
  dimension: number;
  created_at: string;
}

export interface CreateEmbeddingInput {
  id: string;
  memory_id: string;
  embedding: Buffer | Float32Array;
  model: string;
  dimension: number;
}

export interface CosineSearchResult {
  memory_id: string;
  score: number;
}

export class EmbeddingRepository {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  create(input: CreateEmbeddingInput): MemoryEmbedding {
    const embeddingBuf = input.embedding instanceof Float32Array
      ? Buffer.from(input.embedding.buffer, input.embedding.byteOffset, input.embedding.byteLength)
      : input.embedding;

    const stmt = this.db.prepare(`
      INSERT INTO memory_embeddings (id, memory_id, embedding, model, dimension)
      VALUES (@id, @memory_id, @embedding, @model, @dimension)
    `);
    stmt.run({
      id: input.id,
      memory_id: input.memory_id,
      embedding: embeddingBuf,
      model: input.model,
      dimension: input.dimension,
    });
    if (input.embedding instanceof Float32Array && loadSqliteVec(this.db, input.dimension)) {
      try {
        vecInsert(this.db, input.memory_id, input.embedding);
      } catch (err) {
        // sqlite-vec is an acceleration path; the canonical embedding row already
        // exists, so reads can still fall back to cosineSearch. But if vecSearch is
        // the active path this row becomes permanently unsearchable until a
        // backfillVec(), so surface it instead of swallowing — a recurring spike
        // here means recall is silently degrading.
        memoryObservability.record('memory.embedding.vec_insert_failed', {
          memoryId: input.memory_id,
          dimension: input.dimension,
          error: errorForObservation(err),
        });
      }
    }
    return this.findById(input.id)!;
  }

  findById(id: string): MemoryEmbedding | undefined {
    const stmt = this.db.prepare('SELECT * FROM memory_embeddings WHERE id = ?');
    const row = stmt.get(id) as MemoryEmbedding | undefined;
    return row ?? undefined;
  }

  findByMemoryId(memoryId: string): MemoryEmbedding | undefined {
    const stmt = this.db.prepare('SELECT * FROM memory_embeddings WHERE memory_id = ?');
    const row = stmt.get(memoryId) as MemoryEmbedding | undefined;
    return row ?? undefined;
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM memory_embeddings').get() as { cnt: number };
    return row.cnt;
  }

  /**
   * Cosine search fallback: compute cosine similarity in application layer.
   * Used when sqlite-vec extension is not available.
   *
   * @param queryEmbedding The query vector
   * @param limit Max results to return
   * @param candidateIds Optional pre-filter: only score these memory IDs (avoids full-table scan)
   */
  cosineSearch(queryEmbedding: Float32Array, limit: number = 10, candidateIds?: string[] | null): CosineSearchResult[] {
    // If candidateIds is empty array, return empty — nothing to score
    if (candidateIds !== undefined && candidateIds !== null && candidateIds.length === 0) {
      return [];
    }

    let rows: Array<{ memory_id: string; embedding: Buffer }>;

    if (candidateIds && candidateIds.length > 0) {
      // Pre-filtered scan: only load embeddings for candidate memory IDs
      const placeholders = candidateIds.map(() => '?').join(',');
      const stmt = this.db.prepare(
        `SELECT me.memory_id, me.embedding FROM memory_embeddings me
         JOIN memories m ON m.id = me.memory_id
         WHERE me.memory_id IN (${placeholders}) AND m.status = 'active'`
      );
      rows = stmt.all(...candidateIds) as Array<{ memory_id: string; embedding: Buffer }>;
    } else {
      // Full scan fallback — only for cases where no candidate filter is available
      rows = this.db.prepare(
        `SELECT me.memory_id, me.embedding FROM memory_embeddings me
         JOIN memories m ON m.id = me.memory_id
         WHERE m.status = 'active'`
      ).all() as Array<{ memory_id: string; embedding: Buffer }>;
    }

    const queryVec = new Float32Array(queryEmbedding);

    const scored = rows.map(row => {
      const dbVec = new Float32Array(
        row.embedding.buffer,
        row.embedding.byteOffset,
        row.embedding.byteLength / 4
      );
      const score = cosineSimilarity(queryVec, dbVec);
      return { memory_id: row.memory_id, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  vecSearch(queryEmbedding: Float32Array, limit: number = 10, candidateIds?: string[] | null): CosineSearchResult[] {
    if (!sqliteVecTableReady(this.db)) return [];
    try {
      return vecSearch(this.db, queryEmbedding, limit, candidateIds)
        .map(result => ({
          memory_id: result.memoryId,
          score: 1 / (1 + Math.max(0, result.distance)),
        }));
    } catch {
      return [];
    }
  }

  /**
   * Vec-first similarity search with a bounded cosine fallback. Use this for the
   * write-time dedup probe: it previously called cosineSearch() with no
   * candidate filter, forcing a full-table scan that loads EVERY active
   * embedding into JS on EVERY write — O(N) per write, the dominant cost as the
   * store grows. Now it prefers the sqlite-vec ANN index, and only falls back to
   * a cosine scan when the table is small enough (`maxFullScan`) to scan cheaply.
   * Above that bound, with no vec index, it returns [] (skip dedup) rather than
   * blocking the write — a missed dedup is far cheaper than an O(N) stall.
   */
  searchSimilar(
    queryEmbedding: Float32Array,
    limit: number,
    maxFullScan: number = 5000,
  ): CosineSearchResult[] {
    if (this.isVecAvailable()) {
      const vecResults = this.vecSearch(queryEmbedding, limit);
      if (vecResults.length > 0) return vecResults;
    }
    if (this.count() > maxFullScan) return [];
    return this.cosineSearch(queryEmbedding, limit);
  }

  /**
   * Actually load sqlite-vec into this database so any DLL/platform issues
   * surface immediately at startup. Does NOT create the virtual table —
   * that happens on first embedding write via loadSqliteVec().
   */
  probeVec(): void {
    probeSqliteVec(this.db);
  }

  isVecAvailable(): boolean {
    return sqliteVecAvailable(this.db);
  }

  backfillVec(limit: number = 10000): number {
    const rows = this.db.prepare(`
      SELECT me.memory_id, me.embedding, me.dimension
      FROM memory_embeddings me
      JOIN memories m ON m.id = me.memory_id
      WHERE m.status = 'active'
      LIMIT ?
    `).all(limit) as Array<{ memory_id: string; embedding: Buffer; dimension: number }>;
    if (rows.length === 0) return 0;
    if (!loadSqliteVec(this.db, rows[0].dimension)) return 0;
    let inserted = 0;
    for (const row of rows) {
      try {
        vecInsert(this.db, row.memory_id, new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4));
        inserted++;
      } catch {
        // Continue best-effort backfill.
      }
    }
    return inserted;
  }

  delete(id: string): boolean {
    const stmt = this.db.prepare('DELETE FROM memory_embeddings WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  }

  deleteByMemoryId(memoryId: string): boolean {
    const stmt = this.db.prepare('DELETE FROM memory_embeddings WHERE memory_id = ?');
    const result = stmt.run(memoryId);
    if (result.changes > 0 && sqliteVecTableReady(this.db)) {
      try {
        vecDelete(this.db, memoryId);
      } catch {
        // ignore sqlite-vec cleanup failures
      }
    }
    return result.changes > 0;
  }

  // ── Embedding meta tracking ──────────────────────────────────────────

  /**
   * Check whether the embedding provider/model/dimensions changed since
   * vectors were last written. Returns needsReindex=true when the config
   * changed and the vec table should be rebuilt.
   */
  checkEmbeddingMeta(provider: string, model: string, dimension: number): { needsReindex: boolean; reason?: string } {
    const saved = this.readEmbeddingMeta();
    if (!saved) {
      // No saved meta — first run or legacy DB. If there's existing data
      // in the embedding table, we can't verify compatibility → needs reindex.
      const count = this.count();
      if (count > 0) {
        return {
          needsReindex: true,
          reason: `legacy DB without embedding_meta, ${count} existing vectors — cannot verify compatibility`,
        };
      }
      return { needsReindex: false };
    }

    const reasons: string[] = [];
    if (saved.provider !== provider) reasons.push(`provider: ${saved.provider} → ${provider}`);
    if (saved.model !== model) reasons.push(`model: ${saved.model} → ${model}`);
    if (saved.dimensions !== dimension) reasons.push(`dimensions: ${saved.dimensions} → ${dimension}`);

    if (reasons.length > 0) {
      return { needsReindex: true, reason: reasons.join(', ') };
    }

    return { needsReindex: false };
  }

  /**
   * Persist the current embedding config as meta so future checks can
   * detect config changes and trigger re-indexing.
   */
  saveEmbeddingMeta(provider: string, model: string, dimension: number): void {
    const meta = JSON.stringify({ provider, model, dimensions: dimension });
    this.db.prepare(
      'INSERT INTO embedding_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run('embedding_provider_info', meta);
  }

  /**
   * Drop vector tables (both legacy memory_embeddings and sqlite-vec virtual table)
   * so they can be rebuilt with the correct dimensions after embedding config change.
   * Does NOT delete the metadata rows — only the vectors. Re-indexing will
   * regenerate them.
   */
  dropVectorsForReindex(): number {
    const count = this.count();
    this.db.exec('DELETE FROM memory_embeddings');
    try { this.db.exec('DROP TABLE IF EXISTS vec_memory_embeddings'); } catch { /* may not exist */ }
    return count;
  }

  private readEmbeddingMeta(): { provider: string; model: string; dimensions: number } | null {
    try {
      const row = this.db.prepare(
        'SELECT value FROM embedding_meta WHERE key = ?'
      ).get('embedding_provider_info') as { value: string } | undefined;
      if (!row) return null;
      return JSON.parse(row.value) as { provider: string; model: string; dimensions: number };
    } catch {
      return null;
    }
  }
}

/**
 * Compute cosine similarity between two vectors.
 */
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
