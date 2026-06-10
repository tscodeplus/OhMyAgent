import type Database from 'better-sqlite3';

export interface ApprovalRequest {
  id: string;
  session_key: string;
  chat_id: string | null;
  thread_id: string | null;
  requester_id: string | null;
  target_kind: string;
  tool_name: string | null;
  command_text: string | null;
  normalized_command: string | null;
  risk_level: string | null;
  reason: string | null;
  status: string;
  decision_mode: string | null;
  policy_scope: string | null;
  card_message_id: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateApprovalRequestInput {
  id: string;
  session_key: string;
  chat_id?: string | null;
  thread_id?: string | null;
  requester_id?: string | null;
  target_kind: string;
  tool_name?: string | null;
  command_text?: string | null;
  normalized_command?: string | null;
  risk_level?: string | null;
  reason?: string | null;
  status?: string;
  decision_mode?: string | null;
  policy_scope?: string | null;
  card_message_id?: string | null;
  expires_at?: string | null;
}

export interface UpdateApprovalRequestInput {
  status?: string;
  decision_mode?: string | null;
  policy_scope?: string | null;
  card_message_id?: string | null;
  expires_at?: string | null;
  risk_level?: string | null;
  reason?: string | null;
}

export class ApprovalRequestRepository {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  create(input: CreateApprovalRequestInput): ApprovalRequest {
    const stmt = this.db.prepare(`
      INSERT INTO approval_requests (
        id, session_key, chat_id, thread_id, requester_id, target_kind,
        tool_name, command_text, normalized_command, risk_level, reason,
        status, decision_mode, policy_scope, card_message_id, expires_at
      )
      VALUES (
        @id, @session_key, @chat_id, @thread_id, @requester_id, @target_kind,
        @tool_name, @command_text, @normalized_command, @risk_level, @reason,
        @status, @decision_mode, @policy_scope, @card_message_id, @expires_at
      )
    `);
    stmt.run({
      id: input.id,
      session_key: input.session_key,
      chat_id: input.chat_id ?? null,
      thread_id: input.thread_id ?? null,
      requester_id: input.requester_id ?? null,
      target_kind: input.target_kind,
      tool_name: input.tool_name ?? null,
      command_text: input.command_text ?? null,
      normalized_command: input.normalized_command ?? null,
      risk_level: input.risk_level ?? null,
      reason: input.reason ?? null,
      status: input.status ?? 'pending',
      decision_mode: input.decision_mode ?? null,
      policy_scope: input.policy_scope ?? null,
      card_message_id: input.card_message_id ?? null,
      expires_at: input.expires_at ?? null,
    });
    return this.findById(input.id)!;
  }

  findById(id: string): ApprovalRequest | undefined {
    const stmt = this.db.prepare('SELECT * FROM approval_requests WHERE id = ?');
    const row = stmt.get(id) as ApprovalRequest | undefined;
    return row ?? undefined;
  }

  findBySessionKey(sessionKey: string): ApprovalRequest[] {
    const stmt = this.db.prepare(
      'SELECT * FROM approval_requests WHERE session_key = ? ORDER BY created_at DESC'
    );
    return stmt.all(sessionKey) as ApprovalRequest[];
  }

  findByStatus(status: string): ApprovalRequest[] {
    const stmt = this.db.prepare(
      'SELECT * FROM approval_requests WHERE status = ? ORDER BY created_at DESC'
    );
    return stmt.all(status) as ApprovalRequest[];
  }

  findPending(): ApprovalRequest[] {
    return this.findByStatus('pending');
  }

  update(id: string, input: UpdateApprovalRequestInput): ApprovalRequest | undefined {
    const fields: string[] = [];
    const values: Record<string, unknown> = { id };

    if (input.status !== undefined) {
      fields.push('status = @status');
      values.status = input.status;
    }
    if (input.decision_mode !== undefined) {
      fields.push('decision_mode = @decision_mode');
      values.decision_mode = input.decision_mode;
    }
    if (input.policy_scope !== undefined) {
      fields.push('policy_scope = @policy_scope');
      values.policy_scope = input.policy_scope;
    }
    if (input.card_message_id !== undefined) {
      fields.push('card_message_id = @card_message_id');
      values.card_message_id = input.card_message_id;
    }
    if (input.expires_at !== undefined) {
      fields.push('expires_at = @expires_at');
      values.expires_at = input.expires_at;
    }
    if (input.risk_level !== undefined) {
      fields.push('risk_level = @risk_level');
      values.risk_level = input.risk_level;
    }
    if (input.reason !== undefined) {
      fields.push('reason = @reason');
      values.reason = input.reason;
    }

    if (fields.length === 0) {
      return this.findById(id);
    }

    fields.push('updated_at = cast(strftime(\'%s\',\'now\') as integer) * 1000');
    const sql = `UPDATE approval_requests SET ${fields.join(', ')} WHERE id = @id`;
    this.db.prepare(sql).run(values);
    return this.findById(id);
  }

  delete(id: string): boolean {
    const stmt = this.db.prepare('DELETE FROM approval_requests WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  }
}
