import type Database from 'better-sqlite3';

export interface Message {
  id: string;
  session_id: string;
  role: string;
  content: string;
  tool_call_id: string | null;
  created_at: string;
  metadata: string | null;
}

export interface CreateMessageInput {
  id: string;
  session_id: string;
  role: string;
  content: string;
  tool_call_id?: string | null;
  metadata?: string | null;
  /** Override created_at (defaults to Date.now()). Use agent message timestamp for correct ordering. */
  created_at?: number;
}

export interface UpdateMessageInput {
  role?: string;
  content?: string;
  tool_call_id?: string | null;
  metadata?: string | null;
}

export class MessageRepository {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  create(input: CreateMessageInput): Message {
    const stmt = this.db.prepare(`
      INSERT INTO messages (id, session_id, role, content, tool_call_id, metadata, created_at)
      VALUES (@id, @session_id, @role, @content, @tool_call_id, @metadata, @created_at)
    `);
    stmt.run({
      id: input.id,
      session_id: input.session_id,
      role: input.role,
      content: input.content,
      tool_call_id: input.tool_call_id ?? null,
      metadata: input.metadata ?? null,
      created_at: input.created_at ?? Date.now(),
    });
    return this.findById(input.id)!;
  }

  findById(id: string): Message | undefined {
    const stmt = this.db.prepare('SELECT * FROM messages WHERE id = ?');
    const row = stmt.get(id) as Message | undefined;
    return row ?? undefined;
  }

  findBySessionId(sessionId: string, limit: number = 50, offset: number = 0): Message[] {
    const stmt = this.db.prepare(
      'SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC LIMIT ? OFFSET ?'
    );
    return stmt.all(sessionId, limit, offset) as Message[];
  }

  findBySessionIdDesc(sessionId: string, limit: number = 50, offset: number = 0): Message[] {
    const stmt = this.db.prepare(
      'SELECT * FROM messages WHERE session_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
    );
    return stmt.all(sessionId, limit, offset) as Message[];
  }

  update(id: string, input: UpdateMessageInput): Message | undefined {
    const fields: string[] = [];
    const values: Record<string, unknown> = { id };

    if (input.role !== undefined) {
      fields.push('role = @role');
      values.role = input.role;
    }
    if (input.content !== undefined) {
      fields.push('content = @content');
      values.content = input.content;
    }
    if (input.tool_call_id !== undefined) {
      fields.push('tool_call_id = @tool_call_id');
      values.tool_call_id = input.tool_call_id;
    }
    if (input.metadata !== undefined) {
      fields.push('metadata = @metadata');
      values.metadata = input.metadata;
    }

    if (fields.length === 0) {
      return this.findById(id);
    }

    const sql = `UPDATE messages SET ${fields.join(', ')} WHERE id = @id`;
    this.db.prepare(sql).run(values);
    return this.findById(id);
  }

  delete(id: string): boolean {
    const stmt = this.db.prepare('DELETE FROM messages WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  }

  deleteBySessionId(sessionId: string): number {
    const stmt = this.db.prepare('DELETE FROM messages WHERE session_id = ?');
    const result = stmt.run(sessionId);
    return result.changes;
  }

  countBySessionId(sessionId: string): number {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM messages WHERE session_id = ?');
    const row = stmt.get(sessionId) as { count: number };
    return row.count;
  }
}
