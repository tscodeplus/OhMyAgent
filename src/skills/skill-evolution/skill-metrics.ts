/**
 * Skill Metrics Service (P1-4)
 *
 * Collects skill usage data for feedback-driven improvement.
 * Tracks skill activations, tool calls, success rates, and durations.
 *
 * Usage:
 *   const metrics = new SkillMetricsService(db);
 *   metrics.recordActivation(skillId, sessionId, message);
 *   metrics.recordCompletion(skillId, sessionId, success, durationMs, toolCalls);
 *   const stats = metrics.getStats(skillId);
 */

import type Database from 'better-sqlite3';
import { generateId } from '../../shared/ids.js';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface SkillFeedbackRecord {
  id: string;
  skill_id: string;
  session_id: string;
  task_message: string;
  tool_calls_json: string | null;
  success: number | null; // 0/1 or null (unknown)
  duration_ms: number | null;
  created_at: string;
}

export interface SkillUsageStats {
  skillId: string;
  /** Total number of activations */
  totalActivations: number;
  /** Number of completed tasks with inferred success */
  completedTasks: number;
  /** Success rate (0-100) for tasks where success could be inferred */
  successRate: number | null;
  /** Average duration in milliseconds */
  avgDurationMs: number | null;
  /** Most frequently used tools */
  topTools: Array<{ name: string; count: number }>;
  /** Recent feedback (last 20 records) */
  recentFeedback: Array<{
    message: string;
    success: number | null;
    durationMs: number | null;
    createdAt: string;
  }>;
}

export interface GlobalSkillStats {
  /** Total feedback records across all skills */
  totalRecords: number;
  /** Per-skill stats */
  skills: SkillUsageStats[];
}

// ── Satisfaction Inference ─────────────────────────────────────────────────────

/**
 * Lightweight heuristic to infer user satisfaction from follow-up messages.
 *
 * Satisfied signals:
 *   - Message contains "谢谢/不错/OK/很好/太好了/thanks/great/nice/perfect"
 * Unsatisfied signals:
 *   - Message contains "不对/重新/错了/不行/wrong/incorrect/redo/again"
 */
export function inferSatisfaction(followUpMessage: string | null): number | null {
  if (!followUpMessage) return null;

  const satisfiedPattern = /谢谢|太好了|不错|很好|很棒|OK|好的|完美|搞定|可以了|thanks|great|nice|perfect|awesome|thank you|works/i;
  const unsatisfiedPattern = /不对|重新|错了|不行|不是|不要|取消|wrong|incorrect|redo|again|not working|bad|error/i;

  if (satisfiedPattern.test(followUpMessage)) return 1;
  if (unsatisfiedPattern.test(followUpMessage)) return 0;
  return null;
}

// ── Metrics Service ────────────────────────────────────────────────────────────

export class SkillMetricsService {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Record a skill activation event.
   */
  recordActivation(
    skillId: string,
    sessionId: string,
    taskMessage: string,
  ): string {
    const id = `skf-${generateId()}`;
    const stmt = this.db.prepare(`
      INSERT INTO skill_feedback (id, skill_id, session_id, task_message)
      VALUES (@id, @skill_id, @session_id, @task_message)
    `);
    stmt.run({
      id,
      skill_id: skillId,
      session_id: sessionId,
      task_message: taskMessage,
    });
    return id;
  }

  /**
   * Record a skill completion event (updates the activation record).
   */
  recordCompletion(
    id: string,
    success: number | null,
    durationMs: number,
    toolCalls: Array<{ name: string; args?: unknown }>,
  ): void {
    const stmt = this.db.prepare(`
      UPDATE skill_feedback
      SET success = @success, duration_ms = @duration_ms, tool_calls_json = @tool_calls_json
      WHERE id = @id
    `);
    stmt.run({
      id,
      success,
      duration_ms: durationMs,
      tool_calls_json: JSON.stringify(toolCalls.map(tc => tc.name)),
    });
  }

  /**
   * Get usage statistics for a specific skill.
   */
  getStats(skillId: string): SkillUsageStats | null {
    const row = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        COUNT(CASE WHEN success IS NOT NULL THEN 1 END) as completed,
        ROUND(AVG(CASE WHEN success = 1 THEN 100.0 ELSE 0.0 END)) as success_rate,
        ROUND(AVG(duration_ms)) as avg_duration
      FROM skill_feedback
      WHERE skill_id = ?
    `).get(skillId) as {
      total: number;
      completed: number;
      success_rate: number | null;
      avg_duration: number | null;
    } | undefined;

    if (!row || row.total === 0) return null;

    // Top tools
    const topTools = this.db.prepare(`
      SELECT tool_calls_json FROM skill_feedback
      WHERE skill_id = ? AND tool_calls_json IS NOT NULL
      ORDER BY created_at DESC LIMIT 100
    `).all(skillId) as Array<{ tool_calls_json: string }>;

    const toolCounts = new Map<string, number>();
    for (const record of topTools) {
      try {
        const tools: string[] = JSON.parse(record.tool_calls_json);
        for (const t of tools) {
          toolCounts.set(t, (toolCounts.get(t) ?? 0) + 1);
        }
      } catch { /* ignore malformed JSON */ }
    }

    const sortedTools = [...toolCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, count]) => ({ name, count }));

    // Recent feedback
    const recent = this.db.prepare(`
      SELECT task_message as message, success, duration_ms, created_at
      FROM skill_feedback
      WHERE skill_id = ?
      ORDER BY created_at DESC LIMIT 20
    `).all(skillId) as Array<{
      message: string;
      success: number | null;
      duration_ms: number | null;
      created_at: string;
    }>;

    return {
      skillId,
      totalActivations: row.total,
      completedTasks: row.completed,
      successRate: row.success_rate,
      avgDurationMs: row.avg_duration,
      topTools: sortedTools,
      recentFeedback: recent.map(r => ({
        message: r.message.length > 100 ? r.message.slice(0, 100) + '…' : r.message,
        success: r.success,
        durationMs: r.duration_ms,
        createdAt: r.created_at,
      })),
    };
  }

  /**
   * Get global statistics across all skills.
   */
  getGlobalStats(): GlobalSkillStats {
    const rows = this.db.prepare(`
      SELECT skill_id, COUNT(*) as cnt
      FROM skill_feedback
      GROUP BY skill_id
      ORDER BY cnt DESC
    `).all() as Array<{ skill_id: string; cnt: number }>;

    const skills = rows
      .map(r => this.getStats(r.skill_id))
      .filter((s): s is SkillUsageStats => s !== null);

    const totalRecords = skills.reduce((sum, s) => sum + s.totalActivations, 0);

    return { totalRecords, skills };
  }

  /**
   * Get feedback records for a skill (paginated).
   */
  getFeedback(
    skillId: string,
    limit: number = 50,
    offset: number = 0,
  ): Array<SkillFeedbackRecord> {
    return this.db.prepare(`
      SELECT * FROM skill_feedback
      WHERE skill_id = ?
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(skillId, limit, offset) as SkillFeedbackRecord[];
  }

  /**
   * Get the count of feedback records for a skill.
   */
  getFeedbackCount(skillId: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) as cnt FROM skill_feedback WHERE skill_id = ?
    `).get(skillId) as { cnt: number } | undefined;
    return row?.cnt ?? 0;
  }
}
