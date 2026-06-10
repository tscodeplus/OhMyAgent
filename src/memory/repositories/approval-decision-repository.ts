import type Database from 'better-sqlite3';

export interface ApprovalDecision {
  id: string;
  request_id: string;
  decided_by: string;
  decision: string;
  decision_scope: string | null;
  comment: string | null;
  created_at: string;
}

export interface CreateApprovalDecisionInput {
  id: string;
  request_id: string;
  decided_by: string;
  decision: string;
  decision_scope?: string | null;
  comment?: string | null;
}

export class ApprovalDecisionRepository {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  create(input: CreateApprovalDecisionInput): ApprovalDecision {
    const stmt = this.db.prepare(`
      INSERT INTO approval_decisions (id, request_id, decided_by, decision, decision_scope, comment)
      VALUES (@id, @request_id, @decided_by, @decision, @decision_scope, @comment)
    `);
    stmt.run({
      id: input.id,
      request_id: input.request_id,
      decided_by: input.decided_by,
      decision: input.decision,
      decision_scope: input.decision_scope ?? null,
      comment: input.comment ?? null,
    });
    return this.findById(input.id)!;
  }

  findById(id: string): ApprovalDecision | undefined {
    const stmt = this.db.prepare('SELECT * FROM approval_decisions WHERE id = ?');
    const row = stmt.get(id) as ApprovalDecision | undefined;
    return row ?? undefined;
  }

  findByRequestId(requestId: string): ApprovalDecision[] {
    const stmt = this.db.prepare(
      'SELECT * FROM approval_decisions WHERE request_id = ? ORDER BY created_at ASC'
    );
    return stmt.all(requestId) as ApprovalDecision[];
  }

  findLatestByRequestId(requestId: string): ApprovalDecision | undefined {
    const stmt = this.db.prepare(
      'SELECT * FROM approval_decisions WHERE request_id = ? ORDER BY created_at DESC LIMIT 1'
    );
    const row = stmt.get(requestId) as ApprovalDecision | undefined;
    return row ?? undefined;
  }

  delete(id: string): boolean {
    const stmt = this.db.prepare('DELETE FROM approval_decisions WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  }

  deleteByRequestId(requestId: string): number {
    const stmt = this.db.prepare('DELETE FROM approval_decisions WHERE request_id = ?');
    const result = stmt.run(requestId);
    return result.changes;
  }
}
