import type Database from 'better-sqlite3';

export interface Session {
  id: string;
  chat_id: string;
  thread_id: string | null;
  user_id: string;
  created_at: string;
  updated_at: string;
  metadata: string | null;
}

export interface CreateSessionInput {
  id: string;
  chat_id: string;
  thread_id?: string | null;
  user_id: string;
  metadata?: string | null;
}

export interface UpdateSessionInput {
  chat_id?: string;
  thread_id?: string | null;
  user_id?: string;
  metadata?: string | null;
}

export class SessionRepository {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  create(input: CreateSessionInput): Session {
    const stmt = this.db.prepare(`
      INSERT INTO sessions (id, chat_id, thread_id, user_id, metadata)
      VALUES (@id, @chat_id, @thread_id, @user_id, @metadata)
    `);
    stmt.run({
      id: input.id,
      chat_id: input.chat_id,
      thread_id: input.thread_id ?? null,
      user_id: input.user_id,
      metadata: input.metadata ?? null,
    });
    return this.findById(input.id)!;
  }

  findById(id: string): Session | undefined {
    const stmt = this.db.prepare('SELECT * FROM sessions WHERE id = ?');
    const row = stmt.get(id) as Session | undefined;
    return row ?? undefined;
  }

  findByChatId(chatId: string): Session[] {
    const stmt = this.db.prepare('SELECT * FROM sessions WHERE chat_id = ? ORDER BY created_at DESC');
    return stmt.all(chatId) as Session[];
  }

  update(id: string, input: UpdateSessionInput): Session | undefined {
    const fields: string[] = [];
    const values: Record<string, unknown> = { id };

    if (input.chat_id !== undefined) {
      fields.push('chat_id = @chat_id');
      values.chat_id = input.chat_id;
    }
    if (input.thread_id !== undefined) {
      fields.push('thread_id = @thread_id');
      values.thread_id = input.thread_id;
    }
    if (input.user_id !== undefined) {
      fields.push('user_id = @user_id');
      values.user_id = input.user_id;
    }
    if (input.metadata !== undefined) {
      fields.push('metadata = @metadata');
      values.metadata = input.metadata;
    }

    if (fields.length === 0) {
      return this.findById(id);
    }

    fields.push('updated_at = cast(strftime(\'%s\',\'now\') as integer) * 1000');
    const sql = `UPDATE sessions SET ${fields.join(', ')} WHERE id = @id`;
    this.db.prepare(sql).run(values);
    return this.findById(id);
  }

  delete(id: string): boolean {
    const stmt = this.db.prepare('DELETE FROM sessions WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  }

  /** Update the updated_at timestamp without changing other fields. */
  touch(id: string): void {
    this.db.prepare("UPDATE sessions SET updated_at = cast(strftime('%s','now') as integer) * 1000 WHERE id = ?").run(id);
  }

  /** List sessions ordered by most recent activity. */
  listRecent(limit: number = 10): Session[] {
    const stmt = this.db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?');
    return stmt.all(limit) as Session[];
  }
}
