import type Database from 'better-sqlite3';

export interface ApprovalPolicy {
  id: string;
  scope: string;
  scope_key: string;
  target_kind: string;
  pattern_type: string;
  pattern: string;
  effect: string;
  created_by: string | null;
  source: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateApprovalPolicyInput {
  id: string;
  scope: string;
  scope_key: string;
  target_kind: string;
  pattern_type: string;
  pattern: string;
  effect: string;
  created_by?: string | null;
  source?: string | null;
  note?: string | null;
}

export interface UpdateApprovalPolicyInput {
  scope?: string;
  scope_key?: string;
  target_kind?: string;
  pattern_type?: string;
  pattern?: string;
  effect?: string;
  created_by?: string | null;
  source?: string | null;
  note?: string | null;
}

export class ApprovalPolicyRepository {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  create(input: CreateApprovalPolicyInput): ApprovalPolicy {
    const stmt = this.db.prepare(`
      INSERT INTO approval_policies (id, scope, scope_key, target_kind, pattern_type, pattern, effect, created_by, source, note)
      VALUES (@id, @scope, @scope_key, @target_kind, @pattern_type, @pattern, @effect, @created_by, @source, @note)
    `);
    stmt.run({
      id: input.id,
      scope: input.scope,
      scope_key: input.scope_key,
      target_kind: input.target_kind,
      pattern_type: input.pattern_type,
      pattern: input.pattern,
      effect: input.effect,
      created_by: input.created_by ?? null,
      source: input.source ?? null,
      note: input.note ?? null,
    });
    return this.findById(input.id)!;
  }

  findById(id: string): ApprovalPolicy | undefined {
    const stmt = this.db.prepare('SELECT * FROM approval_policies WHERE id = ?');
    const row = stmt.get(id) as ApprovalPolicy | undefined;
    return row ?? undefined;
  }

  findByScope(scope: string, scopeKey: string): ApprovalPolicy[] {
    const stmt = this.db.prepare(
      'SELECT * FROM approval_policies WHERE scope = ? AND scope_key = ? ORDER BY created_at DESC'
    );
    return stmt.all(scope, scopeKey) as ApprovalPolicy[];
  }

  findByTargetKind(targetKind: string): ApprovalPolicy[] {
    const stmt = this.db.prepare(
      'SELECT * FROM approval_policies WHERE target_kind = ? ORDER BY created_at DESC'
    );
    return stmt.all(targetKind) as ApprovalPolicy[];
  }

  update(id: string, input: UpdateApprovalPolicyInput): ApprovalPolicy | undefined {
    const fields: string[] = [];
    const values: Record<string, unknown> = { id };

    if (input.scope !== undefined) {
      fields.push('scope = @scope');
      values.scope = input.scope;
    }
    if (input.scope_key !== undefined) {
      fields.push('scope_key = @scope_key');
      values.scope_key = input.scope_key;
    }
    if (input.target_kind !== undefined) {
      fields.push('target_kind = @target_kind');
      values.target_kind = input.target_kind;
    }
    if (input.pattern_type !== undefined) {
      fields.push('pattern_type = @pattern_type');
      values.pattern_type = input.pattern_type;
    }
    if (input.pattern !== undefined) {
      fields.push('pattern = @pattern');
      values.pattern = input.pattern;
    }
    if (input.effect !== undefined) {
      fields.push('effect = @effect');
      values.effect = input.effect;
    }
    if (input.created_by !== undefined) {
      fields.push('created_by = @created_by');
      values.created_by = input.created_by;
    }
    if (input.source !== undefined) {
      fields.push('source = @source');
      values.source = input.source;
    }
    if (input.note !== undefined) {
      fields.push('note = @note');
      values.note = input.note;
    }

    if (fields.length === 0) {
      return this.findById(id);
    }

    fields.push('updated_at = cast(strftime(\'%s\',\'now\') as integer) * 1000');
    const sql = `UPDATE approval_policies SET ${fields.join(', ')} WHERE id = @id`;
    this.db.prepare(sql).run(values);
    return this.findById(id);
  }

  delete(id: string): boolean {
    const stmt = this.db.prepare('DELETE FROM approval_policies WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  }
}
