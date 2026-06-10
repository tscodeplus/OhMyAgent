import type Database from 'better-sqlite3';
import type { RetrievalPolicy } from './retrieval-policy.js';

/**
 * CandidateSelector generates a pre-filtered set of memory IDs before
 * vector/FTS scoring, avoiding full-table cosine scans.
 */
export class CandidateSelector {
  constructor(private db: Database.Database) {}

  /**
   * Select candidate memory IDs based on the given policy.
   * Returns all matching IDs, or null if the candidate set is the full table.
   */
  selectIds(policy: RetrievalPolicy): string[] | null {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let narrowed = false;

    // Status filter
    if (policy.activeOnly !== false) {
      conditions.push("m.status = 'active'");
    }

    // Scope filter
    if (policy.access.scope) {
      conditions.push('m.scope = ?');
      params.push(policy.access.scope);
      narrowed = true;
    }

    // ScopeKey filter
    if (policy.access.scopeKey) {
      conditions.push('m.scope_key = ?');
      params.push(policy.access.scopeKey);
      narrowed = true;
    }

    // Kind filter
    if (policy.access.kind) {
      const kinds = Array.isArray(policy.access.kind) ? policy.access.kind : [policy.access.kind];
      conditions.push(`m.kind IN (${kinds.map(() => '?').join(',')})`);
      params.push(...kinds);
      narrowed = true;
    }

    // Agent/visibility filter
    if (policy.access.pool === 'current' && policy.access.agentId) {
      conditions.push('m.agent_id = ?');
      params.push(policy.access.agentId);
      narrowed = true;
    } else if (policy.access.pool === 'shared') {
      conditions.push('m.agent_id IS NULL');
      narrowed = true;
    } else if (policy.access.pool === 'other' && policy.access.agentId) {
      conditions.push("m.agent_id IS NOT NULL AND m.agent_id != ? AND m.visibility = 'shared'");
      params.push(policy.access.agentId);
      narrowed = true;
    } else if (policy.access.agentId) {
      conditions.push("(m.agent_id = ? OR m.agent_id IS NULL OR m.visibility = 'shared')");
      params.push(policy.access.agentId);
      narrowed = true;
    }

    if (!narrowed) return null; // Full active table is handled by the embedding repository.

    const sql = `SELECT m.id FROM memories m WHERE ${conditions.join(' AND ')}`;
    const rows = this.db.prepare(sql).all(...params) as Array<{ id: string }>;
    return rows.map(r => r.id);
  }
}
