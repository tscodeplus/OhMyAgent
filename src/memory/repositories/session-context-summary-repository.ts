import type Database from 'better-sqlite3';

export interface SessionContextSummary {
  session_id: string;
  agent_id: string;
  summary: string;
  covered_through_ms: number;
  created_at: string;
  updated_at: string;
}

export interface UpsertSessionContextSummaryInput {
  sessionId: string;
  agentId?: string;
  summary: string;
  /** Instant the summary was written: rows created after this are uncovered. */
  coveredThroughMs: number;
}

/**
 * The compression summary a cold session resumes from.
 *
 * Context compression replaces the older half of a transcript with an LLM
 * summary; without this table that summary existed only inside the process that
 * produced it, so a restart, a runtime eviction or an MCP tool-set change left
 * the next turn rebuilding context from raw rows it could not know had already
 * been summarized. The row also carries `covered_through_ms`, which is what lets
 * the reload ask for the *uncovered* tail rather than a guessed row count.
 */
export class SessionContextSummaryRepository {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  find(sessionId: string, agentId = 'default'): SessionContextSummary | undefined {
    const stmt = this.db.prepare(
      'SELECT * FROM session_context_summaries WHERE session_id = ? AND agent_id = ?',
    );
    return stmt.get(sessionId, agentId) as SessionContextSummary | undefined;
  }

  upsert(input: UpsertSessionContextSummaryInput): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO session_context_summaries
           (session_id, agent_id, summary, covered_through_ms, created_at, updated_at)
         VALUES (@session_id, @agent_id, @summary, @covered_through_ms, @created_at, @updated_at)
         ON CONFLICT(session_id, agent_id) DO UPDATE SET
           summary = excluded.summary,
           covered_through_ms = excluded.covered_through_ms,
           updated_at = excluded.updated_at`,
      )
      .run({
        session_id: input.sessionId,
        agent_id: input.agentId ?? 'default',
        summary: input.summary,
        covered_through_ms: input.coveredThroughMs,
        created_at: String(now),
        updated_at: String(now),
      });
  }

  deleteBySession(sessionId: string): void {
    this.db.prepare('DELETE FROM session_context_summaries WHERE session_id = ?').run(sessionId);
  }
}
