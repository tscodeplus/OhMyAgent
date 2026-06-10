import type Database from 'better-sqlite3';

export interface CreateProcessedMessageInput {
  source: string;
  message_id: string;
  event_type: string;
  session_key?: string | null;
  metadata?: string | null;
}

export class ProcessedMessageRepository {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  createIfAbsent(input: CreateProcessedMessageInput): boolean {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO processed_messages (source, message_id, event_type, session_key, metadata)
      VALUES (@source, @message_id, @event_type, @session_key, @metadata)
    `);
    const result = stmt.run({
      source: input.source,
      message_id: input.message_id,
      event_type: input.event_type,
      session_key: input.session_key ?? null,
      metadata: input.metadata ?? null,
    });
    return result.changes > 0;
  }

  has(source: string, messageId: string): boolean {
    const stmt = this.db.prepare('SELECT 1 FROM processed_messages WHERE source = ? AND message_id = ? LIMIT 1');
    return Boolean(stmt.get(source, messageId));
  }
}
