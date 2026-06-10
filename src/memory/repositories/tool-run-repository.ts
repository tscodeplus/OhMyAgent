import type Database from 'better-sqlite3';

export interface ToolRun {
  id: string;
  session_id: string;
  tool_name: string;
  input: string | null;
  output: string | null;
  status: string;
  duration_ms: number | null;
  error: string | null;
  created_at: string;
  metadata: string | null;
}

export interface CreateToolRunInput {
  id: string;
  session_id: string;
  tool_name: string;
  input?: string | null;
  output?: string | null;
  status: string;
  duration_ms?: number | null;
  error?: string | null;
  metadata?: string | null;
}

export interface UpdateToolRunInput {
  output?: string | null;
  status?: string;
  duration_ms?: number | null;
  error?: string | null;
  metadata?: string | null;
}

export class ToolRunRepository {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  create(input: CreateToolRunInput): ToolRun {
    const stmt = this.db.prepare(`
      INSERT INTO tool_runs (id, session_id, tool_name, input, output, status, duration_ms, error, metadata)
      VALUES (@id, @session_id, @tool_name, @input, @output, @status, @duration_ms, @error, @metadata)
    `);
    stmt.run({
      id: input.id,
      session_id: input.session_id,
      tool_name: input.tool_name,
      input: input.input ?? null,
      output: input.output ?? null,
      status: input.status,
      duration_ms: input.duration_ms ?? null,
      error: input.error ?? null,
      metadata: input.metadata ?? null,
    });
    return this.findById(input.id)!;
  }

  findById(id: string): ToolRun | undefined {
    const stmt = this.db.prepare('SELECT * FROM tool_runs WHERE id = ?');
    const row = stmt.get(id) as ToolRun | undefined;
    return row ?? undefined;
  }

  findBySessionId(sessionId: string): ToolRun[] {
    const stmt = this.db.prepare(
      'SELECT * FROM tool_runs WHERE session_id = ? ORDER BY created_at ASC'
    );
    return stmt.all(sessionId) as ToolRun[];
  }

  findByToolName(toolName: string, limit: number = 50): ToolRun[] {
    const stmt = this.db.prepare(
      'SELECT * FROM tool_runs WHERE tool_name = ? ORDER BY created_at DESC LIMIT ?'
    );
    return stmt.all(toolName, limit) as ToolRun[];
  }

  update(id: string, input: UpdateToolRunInput): ToolRun | undefined {
    const fields: string[] = [];
    const values: Record<string, unknown> = { id };

    if (input.output !== undefined) {
      fields.push('output = @output');
      values.output = input.output;
    }
    if (input.status !== undefined) {
      fields.push('status = @status');
      values.status = input.status;
    }
    if (input.duration_ms !== undefined) {
      fields.push('duration_ms = @duration_ms');
      values.duration_ms = input.duration_ms;
    }
    if (input.error !== undefined) {
      fields.push('error = @error');
      values.error = input.error;
    }
    if (input.metadata !== undefined) {
      fields.push('metadata = @metadata');
      values.metadata = input.metadata;
    }

    if (fields.length === 0) {
      return this.findById(id);
    }

    const sql = `UPDATE tool_runs SET ${fields.join(', ')} WHERE id = @id`;
    this.db.prepare(sql).run(values);
    return this.findById(id);
  }

  delete(id: string): boolean {
    const stmt = this.db.prepare('DELETE FROM tool_runs WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  }

  deleteBySessionId(sessionId: string): number {
    const stmt = this.db.prepare('DELETE FROM tool_runs WHERE session_id = ?');
    const result = stmt.run(sessionId);
    return result.changes;
  }
}
