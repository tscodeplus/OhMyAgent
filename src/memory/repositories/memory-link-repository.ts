import type Database from 'better-sqlite3';

export interface MemoryLink {
  id: string;
  source_memory_id: string;
  target_entity: string;
  relation_type: string;
  confidence: number;
  created_at: string;
}

export interface CreateMemoryLinkInput {
  id: string;
  source_memory_id: string;
  target_entity: string;
  relation_type: string;
  confidence?: number;
}

export class MemoryLinkRepository {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  create(input: CreateMemoryLinkInput): MemoryLink {
    const stmt = this.db.prepare(`
      INSERT INTO memory_links (id, source_memory_id, target_entity, relation_type, confidence)
      VALUES (@id, @source_memory_id, @target_entity, @relation_type, @confidence)
    `);
    stmt.run({
      id: input.id,
      source_memory_id: input.source_memory_id,
      target_entity: input.target_entity,
      relation_type: input.relation_type,
      confidence: input.confidence ?? 1.0,
    });
    return this.findById(input.id)!;
  }

  findById(id: string): MemoryLink | undefined {
    const stmt = this.db.prepare('SELECT * FROM memory_links WHERE id = ?');
    return stmt.get(id) as MemoryLink | undefined;
  }

  /** Find all links pointing to a given entity. */
  findByEntity(entity: string): MemoryLink[] {
    const stmt = this.db.prepare(
      'SELECT * FROM memory_links WHERE target_entity = ? ORDER BY confidence DESC',
    );
    return stmt.all(entity) as MemoryLink[];
  }

  /** Find all links originating from a given memory. */
  findByMemory(memoryId: string): MemoryLink[] {
    const stmt = this.db.prepare(
      'SELECT * FROM memory_links WHERE source_memory_id = ?',
    );
    return stmt.all(memoryId) as MemoryLink[];
  }

  /** Find distinct memory IDs linked to a given entity, excluding the source. */
  findRelatedMemoryIds(entity: string, excludeMemoryId: string): string[] {
    const stmt = this.db.prepare(
      'SELECT DISTINCT source_memory_id FROM memory_links WHERE target_entity = ? AND source_memory_id != ?',
    );
    const rows = stmt.all(entity, excludeMemoryId) as { source_memory_id: string }[];
    return rows.map(r => r.source_memory_id);
  }

  /** Find entities linked from a set of memory IDs. */
  findEntitiesByMemoryIds(memoryIds: string[]): { target_entity: string; source_memory_id: string; confidence: number }[] {
    if (memoryIds.length === 0) return [];
    const placeholders = memoryIds.map(() => '?').join(',');
    const stmt = this.db.prepare(
      `SELECT target_entity, source_memory_id, confidence FROM memory_links WHERE source_memory_id IN (${placeholders})`,
    );
    return stmt.all(...memoryIds) as any[];
  }

  deleteByMemory(memoryId: string): number {
    const stmt = this.db.prepare('DELETE FROM memory_links WHERE source_memory_id = ?');
    const result = stmt.run(memoryId);
    return result.changes;
  }

  /** Count links for a given entity. */
  countByEntity(entity: string): number {
    const stmt = this.db.prepare(
      'SELECT COUNT(DISTINCT source_memory_id) as cnt FROM memory_links WHERE target_entity = ?',
    );
    const row = stmt.get(entity) as { cnt: number } | undefined;
    return row?.cnt ?? 0;
  }
}
