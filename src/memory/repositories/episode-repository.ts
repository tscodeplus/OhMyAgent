import type Database from 'better-sqlite3';

export interface Episode {
  id: string;
  session_id: string;
  summary: string;
  key_points: string | null;
  created_at: string;
}

export interface CreateEpisodeInput {
  id: string;
  session_id: string;
  summary: string;
  key_points?: string | null;
}

export interface UpdateEpisodeInput {
  summary?: string;
  key_points?: string | null;
}

export class EpisodeRepository {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  create(input: CreateEpisodeInput): Episode {
    const stmt = this.db.prepare(`
      INSERT INTO episodes (id, session_id, summary, key_points)
      VALUES (@id, @session_id, @summary, @key_points)
    `);
    stmt.run({
      id: input.id,
      session_id: input.session_id,
      summary: input.summary,
      key_points: input.key_points ?? null,
    });
    return this.findById(input.id)!;
  }

  findById(id: string): Episode | undefined {
    const stmt = this.db.prepare('SELECT * FROM episodes WHERE id = ?');
    const row = stmt.get(id) as Episode | undefined;
    return row ?? undefined;
  }

  findBySessionId(sessionId: string): Episode[] {
    const stmt = this.db.prepare(
      'SELECT * FROM episodes WHERE session_id = ? ORDER BY created_at ASC'
    );
    return stmt.all(sessionId) as Episode[];
  }

  update(id: string, input: UpdateEpisodeInput): Episode | undefined {
    const fields: string[] = [];
    const values: Record<string, unknown> = { id };

    if (input.summary !== undefined) {
      fields.push('summary = @summary');
      values.summary = input.summary;
    }
    if (input.key_points !== undefined) {
      fields.push('key_points = @key_points');
      values.key_points = input.key_points;
    }

    if (fields.length === 0) {
      return this.findById(id);
    }

    const sql = `UPDATE episodes SET ${fields.join(', ')} WHERE id = @id`;
    this.db.prepare(sql).run(values);
    return this.findById(id);
  }

  delete(id: string): boolean {
    const stmt = this.db.prepare('DELETE FROM episodes WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  }

  deleteBySessionId(sessionId: string): number {
    const stmt = this.db.prepare('DELETE FROM episodes WHERE session_id = ?');
    const result = stmt.run(sessionId);
    return result.changes;
  }
}
