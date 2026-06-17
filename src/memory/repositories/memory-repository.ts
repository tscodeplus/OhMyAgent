import type Database from 'better-sqlite3';

export interface Memory {
  id: string;
  scope: string;
  scope_key: string;
  kind: string;
  content: string;
  metadata: string | null;
  agent_id: string | null;
  visibility: string;
  status: string;
  supersedes_id: string | null;
  source_channel: string | null;
  source_message_id: string | null;
  confidence: number;
  invalidated_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateMemoryInput {
  id: string;
  scope: string;
  scope_key: string;
  kind: string;
  content: string;
  metadata?: string | null;
  agent_id?: string | null;
  visibility?: string;
  status?: string;
  supersedes_id?: string | null;
  source_channel?: string | null;
  source_message_id?: string | null;
  confidence?: number;
}

export interface UpdateMemoryInput {
  scope?: string;
  scope_key?: string;
  kind?: string;
  content?: string;
  metadata?: string | null;
  agent_id?: string | null;
  visibility?: string;
  status?: string;
  supersedes_id?: string | null;
  source_channel?: string | null;
  source_message_id?: string | null;
  confidence?: number;
  invalidated_at?: string | null;
}

export class MemoryRepository {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Run `fn` inside a single synchronous SQLite transaction. All statements
   * commit together or roll back together. `fn` MUST be synchronous —
   * better-sqlite3 cannot span a transaction across an await — so any async
   * work (embedding/LLM calls) must complete before calling this.
   */
  runInTransaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  create(input: CreateMemoryInput): Memory {
    const stmt = this.db.prepare(`
      INSERT INTO memories (id, scope, scope_key, kind, content, metadata, agent_id, visibility, status, supersedes_id, source_channel, source_message_id, confidence)
      VALUES (@id, @scope, @scope_key, @kind, @content, @metadata, @agent_id, @visibility, @status, @supersedes_id, @source_channel, @source_message_id, @confidence)
    `);
    stmt.run({
      id: input.id,
      scope: input.scope,
      scope_key: input.scope_key,
      kind: input.kind,
      content: input.content,
      metadata: input.metadata ?? null,
      agent_id: input.agent_id ?? null,
      visibility: input.visibility ?? 'shared',
      status: input.status ?? 'active',
      supersedes_id: input.supersedes_id ?? null,
      source_channel: input.source_channel ?? null,
      source_message_id: input.source_message_id ?? null,
      confidence: input.confidence ?? 1.0,
    });
    return this.findById(input.id)!;
  }

  /**
   * Find a memory by ID — returns ALL statuses (active, superseded, deleted).
   * This is the governance-tool lookup path.
   */
  findById(id: string): Memory | undefined {
    const stmt = this.db.prepare('SELECT * FROM memories WHERE id = ?');
    const row = stmt.get(id) as Memory | undefined;
    return row ?? undefined;
  }

  /**
   * Batch lookup by IDs. Use to avoid N+1 queries when iterating over
   * search results (e.g. dedup checks in MemoryWriter).
   */
  findByIds(ids: string[]): Memory[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const stmt = this.db.prepare(`SELECT * FROM memories WHERE id IN (${placeholders})`);
    return stmt.all(ids) as Memory[];
  }

  /**
   * Find active memory by ID. Use for retrieval paths that should not see inactive records.
   */
  findActiveById(id: string): Memory | undefined {
    const stmt = this.db.prepare("SELECT * FROM memories WHERE id = ? AND status = 'active'");
    const row = stmt.get(id) as Memory | undefined;
    return row ?? undefined;
  }

  /**
   * Find all memories by scope (active only), regardless of scope_key.
   */
  findAllByScope(scope: string): Memory[] {
    const stmt = this.db.prepare(
      "SELECT * FROM memories WHERE scope = ? AND status = 'active' ORDER BY created_at ASC"
    );
    return stmt.all(scope) as Memory[];
  }

  findByScope(scope: string, scopeKey: string, options?: { includeInactive?: boolean }): Memory[] {
    const statusFilter = options?.includeInactive
      ? ''
      : "AND status = 'active'";
    const stmt = this.db.prepare(
      `SELECT * FROM memories WHERE scope = ? AND scope_key = ? ${statusFilter} ORDER BY created_at DESC`
    );
    return stmt.all(scope, scopeKey) as Memory[];
  }

  findByScopeAndKind(scope: string, scopeKey: string, kind: string, options?: { includeInactive?: boolean }): Memory[] {
    const statusFilter = options?.includeInactive
      ? ''
      : "AND status = 'active'";
    const stmt = this.db.prepare(
      `SELECT * FROM memories WHERE scope = ? AND scope_key = ? AND kind = ? ${statusFilter} ORDER BY created_at DESC`
    );
    return stmt.all(scope, scopeKey, kind) as Memory[];
  }

  findByScopeKind(scope: string, kind: string, options?: { includeInactive?: boolean }): Memory[] {
    const statusFilter = options?.includeInactive
      ? ''
      : "AND status = 'active'";
    const stmt = this.db.prepare(
      `SELECT * FROM memories WHERE scope = ? AND kind = ? ${statusFilter} ORDER BY created_at DESC`
    );
    return stmt.all(scope, kind) as Memory[];
  }

  searchByContent(query: string, scope?: string, scopeKey?: string, options?: { includeInactive?: boolean }): Memory[] {
    let sql = 'SELECT * FROM memories WHERE content LIKE ?';
    const params: unknown[] = [`%${query}%`];

    if (!options?.includeInactive) {
      sql += " AND status = 'active'";
    }

    if (scope !== undefined && scopeKey !== undefined) {
      sql += ' AND scope = ? AND scope_key = ?';
      params.push(scope, scopeKey);
    } else if (scope !== undefined) {
      sql += ' AND scope = ?';
      params.push(scope);
    }

    sql += ' ORDER BY updated_at DESC';
    const stmt = this.db.prepare(sql);
    return stmt.all(...params) as Memory[];
  }

  update(id: string, input: UpdateMemoryInput): Memory | undefined {
    const fields: string[] = [];
    const values: Record<string, unknown> = { id };

    if (input.scope !== undefined) { fields.push('scope = @scope'); values.scope = input.scope; }
    if (input.scope_key !== undefined) { fields.push('scope_key = @scope_key'); values.scope_key = input.scope_key; }
    if (input.kind !== undefined) { fields.push('kind = @kind'); values.kind = input.kind; }
    if (input.content !== undefined) { fields.push('content = @content'); values.content = input.content; }
    if (input.metadata !== undefined) { fields.push('metadata = @metadata'); values.metadata = input.metadata; }
    if (input.agent_id !== undefined) { fields.push('agent_id = @agent_id'); values.agent_id = input.agent_id; }
    if (input.visibility !== undefined) { fields.push('visibility = @visibility'); values.visibility = input.visibility; }
    if (input.status !== undefined) { fields.push('status = @status'); values.status = input.status; }
    if (input.supersedes_id !== undefined) { fields.push('supersedes_id = @supersedes_id'); values.supersedes_id = input.supersedes_id; }
    if (input.source_channel !== undefined) { fields.push('source_channel = @source_channel'); values.source_channel = input.source_channel; }
    if (input.source_message_id !== undefined) { fields.push('source_message_id = @source_message_id'); values.source_message_id = input.source_message_id; }
    if (input.confidence !== undefined) { fields.push('confidence = @confidence'); values.confidence = input.confidence; }
    if (input.invalidated_at !== undefined) { fields.push('invalidated_at = @invalidated_at'); values.invalidated_at = input.invalidated_at; }

    if (fields.length === 0) {
      return this.findById(id);
    }

    fields.push('updated_at = cast(strftime(\'%s\',\'now\') as integer) * 1000');
    const sql = `UPDATE memories SET ${fields.join(', ')} WHERE id = @id`;
    this.db.prepare(sql).run(values);
    return this.findById(id);
  }

  /** Physical delete — only for hygiene purge. */
  delete(id: string): boolean {
    const stmt = this.db.prepare('DELETE FROM memories WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  }

  /**
   * Soft delete: marks memory as deleted but retains the row for audit.
   *
   * Note: FTS entries for soft-deleted memories persist because the FTS5 table
   * uses content=memories (external content). Physical row deletion is required
   * to trigger FTS cleanup via triggers. The recall pipeline handles this via
   * JOIN with m.status='active' — inactive entries never appear in results.
   */
  softDelete(id: string): boolean {
    const stmt = this.db.prepare(
      "UPDATE memories SET status = 'deleted', invalidated_at = cast(strftime('%s','now') as integer) * 1000, updated_at = cast(strftime('%s','now') as integer) * 1000 WHERE id = ? AND status = 'active'"
    );
    const result = stmt.run(id);
    return result.changes > 0;
  }

  /**
   * Mark oldId as superseded by newId. Old preference is superseded, not deleted.
   *
   * After calling: supersedes_id on the NEW row = oldId.
   * Read as: "newId supersedes oldId" (supersedes_id on row X = the ID that X supersedes).
   * To find what supersedes a given memory, use findSuperseding().
   */
  supersede(oldId: string, newId: string): boolean {
    const updated = this.db.prepare(
      "UPDATE memories SET status = 'superseded', supersedes_id = NULL, invalidated_at = cast(strftime('%s','now') as integer) * 1000, updated_at = cast(strftime('%s','now') as integer) * 1000 WHERE id = ? AND status = 'active'"
    ).run(oldId);
    if (updated.changes > 0) {
      this.db.prepare(
        "UPDATE memories SET supersedes_id = ? WHERE id = ?"
      ).run(oldId, newId);
      return true;
    }
    return false;
  }

  /**
   * Find the memory that supersedes the given one (reverse lookup).
   */
  findSuperseding(supersededId: string): Memory | undefined {
    const stmt = this.db.prepare("SELECT * FROM memories WHERE supersedes_id = ? AND status = 'active'");
    const row = stmt.get(supersededId) as Memory | undefined;
    return row ?? undefined;
  }

  deleteByScope(scope: string, scopeKey: string): number {
    const stmt = this.db.prepare('DELETE FROM memories WHERE scope = ? AND scope_key = ?');
    const result = stmt.run(scope, scopeKey);
    return result.changes;
  }

  upsert(input: { id: string; scope: string; scope_key: string; kind: string; content: string; metadata?: string | null }): Memory {
    const existing = this.findById(input.id);
    if (existing) {
      // Reset to active if previously soft-deleted/superseded
      this.db.prepare(`
        UPDATE memories SET content = ?, metadata = ?, status = 'active', invalidated_at = NULL, updated_at = cast(strftime('%s','now') as integer) * 1000
        WHERE id = ?
      `).run(input.content, input.metadata ?? null, input.id);
      return this.findById(input.id)!;
    }
    return this.create({
      id: input.id,
      scope: input.scope,
      scope_key: input.scope_key,
      kind: input.kind,
      content: input.content,
      metadata: input.metadata ?? null,
    });
  }

  /**
   * Find an exact duplicate by scope_key + kind + content.
   */
  findExactMatch(scope: string, scopeKey: string, kind: string, content: string): Memory | undefined {
    const stmt = this.db.prepare(
      "SELECT * FROM memories WHERE scope = ? AND scope_key = ? AND kind = ? AND content = ? AND status = 'active' LIMIT 1",
    );
    const row = stmt.get(scope, scopeKey, kind, content) as Memory | undefined;
    return row ?? undefined;
  }
}
