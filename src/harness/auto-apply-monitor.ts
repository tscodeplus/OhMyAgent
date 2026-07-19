// ---------------------------------------------------------------------------
// Self-Harness System — Auto-Apply Monitor / Rollback Service
// ---------------------------------------------------------------------------
// Watches proposals applied via auto_apply approval rules. Accumulates
// activation metrics across an observation window and automatically
// rolls back (git revert) if success rate or error rate thresholds
// are breached.
// ---------------------------------------------------------------------------

import { AutoRollbackConfig } from './types.js';
import { execSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Internal data structures
// ---------------------------------------------------------------------------

interface ActiveMonitor {
  proposalId: string;
  skillId: string | null;
  agentId: string | null;
  config: AutoRollbackConfig;
  commitHash: string;
  appliedAt: number;
  activationCount: number;
  baselineMetrics: { successRate: number; errorRate: number };
}

interface ActivationResult {
  success: boolean;
  errorCount: number;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// AutoApplyMonitor
// ---------------------------------------------------------------------------

export class AutoApplyMonitor {
  private monitors = new Map<string, ActiveMonitor>();
  private cumSuccesses = new Map<string, number>();
  private cumErrors = new Map<string, number>();

  /** Register a newly applied proposal for observation. */
  watch(
    proposalId: string,
    skillId: string | null,
    agentId: string | null,
    config: AutoRollbackConfig,
    commitHash: string,
  ): void {
    const monitor: ActiveMonitor = {
      proposalId,
      skillId,
      agentId,
      config,
      commitHash,
      appliedAt: Date.now(),
      activationCount: 0,
      baselineMetrics: { successRate: 1.0, errorRate: 0 },
    };
    this.monitors.set(proposalId, monitor);
    this.cumSuccesses.set(proposalId, 0);
    this.cumErrors.set(proposalId, 0);
  }

  /** Record an activation result and trigger evaluation when the observation
   *  window is reached. */
  onActivationComplete(
    skillId: string | null,
    agentId: string | null,
    result: ActivationResult,
  ): void {
    for (const [proposalId, monitor] of this.monitors) {
      if (skillId !== null && monitor.skillId !== skillId) continue;
      if (agentId !== null && monitor.agentId !== agentId) continue;

      monitor.activationCount++;

      const prevCumSuccesses = this.cumSuccesses.get(proposalId) ?? 0;
      const prevCumErrors = this.cumErrors.get(proposalId) ?? 0;
      const newCumSuccesses = prevCumSuccesses + (result.success ? 1 : 0);
      const newCumErrors = prevCumErrors + result.errorCount;

      this.cumSuccesses.set(proposalId, newCumSuccesses);
      this.cumErrors.set(proposalId, newCumErrors);

      monitor.baselineMetrics.successRate =
        newCumSuccesses / monitor.activationCount;
      monitor.baselineMetrics.errorRate =
        newCumErrors / monitor.activationCount;

      if (monitor.activationCount >= monitor.config.observationWindow) {
        this.evaluate(proposalId);
      }
    }
  }

  /** Compare current running metrics against the baseline — rollback if
   *  either threshold is breached, otherwise remove the monitor. */
  private evaluate(proposalId: string): void {
    const monitor = this.monitors.get(proposalId);
    if (!monitor) return;

    const { config, baselineMetrics } = monitor;

    if (baselineMetrics.successRate < config.satisfactionThreshold) {
      this.rollback(
        proposalId,
        `Success rate ${(baselineMetrics.successRate * 100).toFixed(1)}%` +
          ` below threshold ${(config.satisfactionThreshold * 100).toFixed(1)}%`,
      );
      return;
    }

    // Baseline error rate is 0 (the pre-apply state), so any positive error
    // rate after multiplying by the configured multiplier triggers rollback.
    const initialBaselineErrorRate = 0;
    if (
      baselineMetrics.errorRate >
      initialBaselineErrorRate * config.errorRateMultiplier
    ) {
      this.rollback(
        proposalId,
        `Error rate ${(baselineMetrics.errorRate * 100).toFixed(1)}%` +
          ` exceeds baseline multiplier ${config.errorRateMultiplier}`,
      );
      return;
    }

    // Observation passed — clean up
    this.monitors.delete(proposalId);
    this.cumSuccesses.delete(proposalId);
    this.cumErrors.delete(proposalId);
  }

  /** Execute a git revert and remove the monitor. */
  private rollback(proposalId: string, reason: string): void {
    const monitor = this.monitors.get(proposalId);
    if (!monitor) return;

    try {
      execSync(`git revert ${monitor.commitHash} --no-edit`, {
        cwd: process.cwd(),
      });
      console.log(
        `[AutoApplyMonitor] Rolled back proposal ${proposalId}: ${reason}`,
      );
    } catch (err) {
      console.error(
        `[AutoApplyMonitor] Failed to rollback proposal ${proposalId}:`,
        err,
      );
    }

    this.monitors.delete(proposalId);
    this.cumSuccesses.delete(proposalId);
    this.cumErrors.delete(proposalId);
  }

  /** List currently active monitors (for reporting / dashboard). */
  getActiveMonitors(): Array<{
    proposalId: string;
    activationCount: number;
    observationWindow: number;
  }> {
    return Array.from(this.monitors.values()).map((m) => ({
      proposalId: m.proposalId,
      activationCount: m.activationCount,
      observationWindow: m.config.observationWindow,
    }));
  }
}
