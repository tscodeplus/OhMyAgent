// ── Types ─────────────────────────────────────────────────────────────────────

export interface SkillMetrics {
  skillId: string;
  totalCalls: number;
  successCount: number;
  failCount: number;
  totalDuration: number;
  lastUsed: number; // timestamp (ms since epoch)
}

// ── Service ───────────────────────────────────────────────────────────────────

/**
 * Tracks execution metrics for skills, including call count, success/fail
 * rates, total duration, and last-used timestamps.
 *
 * All methods are synchronous — designed for in-memory aggregation with
 * periodic persistence handled by the caller.
 */
export class SkillMetricsService {
  private metrics = new Map<string, SkillMetrics>();

  /**
   * Record a single skill execution.
   *
   * @param skillId - The skill's manifest ID
   * @param success - Whether the execution completed successfully
   * @param duration - Execution duration in milliseconds
   */
  recordExecution(skillId: string, success: boolean, duration: number): void {
    let m = this.metrics.get(skillId);
    if (!m) {
      m = {
        skillId,
        totalCalls: 0,
        successCount: 0,
        failCount: 0,
        totalDuration: 0,
        lastUsed: 0,
      };
      this.metrics.set(skillId, m);
    }

    m.totalCalls++;
    if (success) {
      m.successCount++;
    } else {
      m.failCount++;
    }
    m.totalDuration += duration;
    m.lastUsed = Date.now();
  }

  /**
   * Get the metrics snapshot for a specific skill.
   * Returns undefined if no executions have been recorded for the skill.
   */
  getMetrics(skillId: string): SkillMetrics | undefined {
    return this.metrics.get(skillId);
  }

  /**
   * Get metrics for all tracked skills.
   * Returns a shallow copy of the internal state.
   */
  getAllMetrics(): SkillMetrics[] {
    return [...this.metrics.values()];
  }

  /**
   * Get the top N skills by total call count (descending).
   * Useful for identifying the most frequently used skills.
   */
  getTopSkills(limit: number): SkillMetrics[] {
    return [...this.metrics.values()]
      .sort((a, b) => b.totalCalls - a.totalCalls)
      .slice(0, Math.max(0, limit));
  }

  /**
   * Get skills with a success rate below the given threshold.
   *
   * @param threshold - Minimum acceptable success rate (0.0 to 1.0).
   *                    Defaults to 0.5. Skills with zero calls are excluded.
   */
  getLowPerformanceSkills(threshold: number = 0.5): SkillMetrics[] {
    return [...this.metrics.values()].filter(m => {
      if (m.totalCalls === 0) return false;
      const rate = m.successCount / m.totalCalls;
      return rate < threshold;
    });
  }

  /**
   * Reset all collected metrics.
   */
  reset(): void {
    this.metrics.clear();
  }

  /**
   * Remove metrics for a specific skill.
   */
  removeSkill(skillId: string): void {
    this.metrics.delete(skillId);
  }
}
