import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';

export interface EmbeddingCacheEntry {
  content_hash: string;
  embedding: Buffer;
  model: string;
  dimension: number;
  created_at: string;
}

export interface EmbeddingCacheRepository {
  get(contentHash: string): EmbeddingCacheEntry | undefined;
  set(entry: EmbeddingCacheEntry): void;
  count(): number;
  trim(maxEntries: number): number;
}

export class EmbeddingCacheRepo implements EmbeddingCacheRepository {
  private readonly db: Database.Database;
  private readonly maxEntries: number;

  constructor(db: Database.Database, maxEntries: number = 10000) {
    this.db = db;
    this.maxEntries = maxEntries;
  }

  get(contentHash: string): EmbeddingCacheEntry | undefined {
    const stmt = this.db.prepare('SELECT * FROM embedding_cache WHERE content_hash = ?');
    const row = stmt.get(contentHash) as EmbeddingCacheEntry | undefined;
    return row ?? undefined;
  }

  set(entry: EmbeddingCacheEntry): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO embedding_cache (content_hash, embedding, model, dimension, created_at)
      VALUES (@content_hash, @embedding, @model, @dimension, @created_at)
    `);
    stmt.run(entry);
    // Trim if over capacity: delete oldest 10%
    if (this.count() > this.maxEntries) {
      this.trim(this.maxEntries);
    }
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM embedding_cache').get() as { cnt: number };
    return row.cnt;
  }

  trim(maxEntries: number): number {
    const excess = this.count() - maxEntries;
    if (excess <= 0) return 0;
    const deleteCount = Math.max(Math.floor(maxEntries * 0.1), excess);
    const result = this.db.prepare(`
      DELETE FROM embedding_cache WHERE content_hash IN (
        SELECT content_hash FROM embedding_cache ORDER BY created_at ASC LIMIT ?
      )
    `).run(deleteCount);
    return result.changes;
  }
}

// Utility functions — exported for MemoryWriter and MemoryRetriever to use

export function hashContent(content: string, model: string): string {
  return createHash('sha256').update(content + '::' + model).digest('hex').slice(0, 32);
}

export function bufferToFloat32Array(buf: Buffer): Float32Array {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
}
