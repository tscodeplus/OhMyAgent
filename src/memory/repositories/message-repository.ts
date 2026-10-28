import type Database from 'better-sqlite3';
import { deleteMessageFts, deleteSessionMessageFts, syncMessageJiebaFts } from '../fts.js';

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
  /** Told about every user message row {@link create} writes. See {@link onUserMessage}. */
  private readonly userMessageListeners: Array<(message: Message) => void> = [];

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Register a listener for newly stored user messages.
   *
   * This is the seam the share-curation trigger hangs on (plan §6 K2-5, third
   * entry point — `src/memory/knowledge/share-trigger.ts`): Feishu, Telegram,
   * WeChat, QQ and the WebUI all reach the `messages` table through this one call
   * (`AgentService.persistMessages`), so a trigger registered here covers every
   * channel without a hook in any of them — and without a hook on the turn path,
   * where it would sit between the user's message and their reply.
   *
   * Listeners run after the row exists, synchronously, and their exceptions are
   * swallowed: the message is already stored, so a knowledge page is never a
   * reason for a turn to fail. Take `ShareCurationTrigger.observeUserMessage` as
   * the model — it only enqueues, and does the real work off the reply path.
   */
  onUserMessage(listener: (message: Message) => void): void {
    this.userMessageListeners.push(listener);
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
    const created = this.findById(input.id)!;
    // Keep messages_fts_jieba in step with the row: unified search and the
    // knowledge graph read it, and the index used to be written only once
    // (migration-v10 backfill), so every later message was invisible to search.
    syncMessageJiebaFts(this.db, 'insert', created);
    if (created.role === 'user') this.notifyUserMessage(created);
    return created;
  }

  /** Told after the row is committed; a listener that throws cannot fail the write. */
  private notifyUserMessage(message: Message): void {
    for (const listener of this.userMessageListeners) {
      try {
        listener(message);
      } catch {
        // Swallowed on purpose — see onUserMessage.
      }
    }
  }

  findById(id: string): Message | undefined {
    const stmt = this.db.prepare('SELECT * FROM messages WHERE id = ?');
    const row = stmt.get(id) as Message | undefined;
    return row ?? undefined;
  }

  findBySessionId(sessionId: string, limit: number = 50, offset: number = 0): Message[] {
    const stmt = this.db.prepare(
      'SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC LIMIT ? OFFSET ?',
    );
    return stmt.all(sessionId, limit, offset) as Message[];
  }

  findBySessionIdDesc(sessionId: string, limit: number = 50, offset: number = 0): Message[] {
    const stmt = this.db.prepare(
      'SELECT * FROM messages WHERE session_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
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
    const updated = this.findById(id);
    if (updated && (input.content !== undefined || input.role !== undefined)) {
      syncMessageJiebaFts(this.db, 'update', updated);
    }
    return updated;
  }

  delete(id: string): boolean {
    const stmt = this.db.prepare('DELETE FROM messages WHERE id = ?');
    const result = stmt.run(id);
    if (result.changes > 0) deleteMessageFts(this.db, id);
    return result.changes > 0;
  }

  deleteBySessionId(sessionId: string): number {
    const stmt = this.db.prepare('DELETE FROM messages WHERE session_id = ?');
    const result = stmt.run(sessionId);
    if (result.changes > 0) deleteSessionMessageFts(this.db, sessionId);
    return result.changes;
  }

  countBySessionId(sessionId: string): number {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM messages WHERE session_id = ?');
    const row = stmt.get(sessionId) as { count: number };
    return row.count;
  }
}
