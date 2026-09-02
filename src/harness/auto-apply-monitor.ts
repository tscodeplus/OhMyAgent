// ---------------------------------------------------------------------------
// Self-Harness System — Auto-Apply Monitor / Rollback Service
// ---------------------------------------------------------------------------
// Watches proposals applied via auto_apply approval rules. Accumulates
// activation metrics across an observation window and automatically
// rolls back (git revert) if success rate or error rate thresholds
// are breached.
//
// Monitors are persisted to a JSON state file so that auto-applied
// changes stay supervised across process restarts.
// ---------------------------------------------------------------------------

import { AutoRollbackConfig } from './types.js';
import { execFile } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import pino from 'pino';

const logger = pino();

/** Pre-apply baseline metrics used to judge post-apply regression. */
export interface MonitorBaseline {
  errorRate: number;
}

export interface ActivationResult {
  success: boolean;
  errorCount: number;
  durationMs: number;
}

interface PersistedMonitor {
  proposalId: string;
  skillId: string | null;
  agentId: string | null;
  config: AutoRollbackConfig;
  commitHash: string;
  appliedAt: number;
  activationCount: number;
  baseline: MonitorBaseline;
  cumSuccesses: number;
  cumErrors: number;
  /** Number of failed git-revert attempts so far (absent on old state files). */
  rollbackAttempts?: number;
  /** Set once rollback attempts are exhausted — manual intervention required. */
  rollbackFailed?: boolean;
}

const DEFAULT_STATE_PATH = 'data/harness-monitors.json';
/** Absolute error-rate floor used when no real baseline is available. */
const ERROR_RATE_FLOOR = 0.15;
/** Number of failed revert attempts before a monitor is marked rollbackFailed. */
const MAX_ROLLBACK_ATTEMPTS = 3;

function execFileAsync(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd: process.cwd() }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout.toString());
    });
  });
}

export class AutoApplyMonitor {
  private monitors = new Map<string, PersistedMonitor>();
  /** Proposal ids whose git revert is currently in flight — makes rollback
   *  idempotent when evaluate() fires again before a revert resolves. */
  private reverting = new Set<string>();
  private readonly statePath: string;

  constructor(statePath: string = DEFAULT_STATE_PATH) {
    this.statePath = statePath;
  }

  /**
   * Restore monitors persisted by a previous process (called once at boot).
   * Monitors whose git commit no longer exists are dropped.
   */
  async loadState(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.statePath, 'utf-8');
    } catch {
      return; // no state file yet — first run
    }
    try {
      const parsed = JSON.parse(raw) as { monitors?: PersistedMonitor[] };
      const list = Array.isArray(parsed.monitors) ? parsed.monitors : [];
      for (const item of list) {
        if (!item || typeof item.proposalId !== 'string') continue;
        // Drop monitors whose commit no longer exists in the repo.
        try {
          await execFileAsync('git', ['cat-file', '-e', `${item.commitHash}^{commit}`]);
        } catch {
          logger.warn(
            { proposalId: item.proposalId },
            '[AutoApplyMonitor] dropped monitor with missing commit',
          );
          continue;
        }
        // Tolerate old state files: baseline used to carry a successRate
        // field (now removed) and rollbackAttempts/rollbackFailed may be
        // absent — both are optional / defaulted at use sites.
        const baseline: MonitorBaseline = {
          errorRate: typeof item.baseline?.errorRate === 'number' ? item.baseline.errorRate : 0,
        };
        this.monitors.set(item.proposalId, { ...item, baseline });
      }
      logger.info({ restored: this.monitors.size }, '[AutoApplyMonitor] state restored');
    } catch (err) {
      logger.warn({ err }, '[AutoApplyMonitor] failed to parse state file');
    }
  }

  /** Register a newly applied proposal for observation. */
  watch(
    proposalId: string,
    skillId: string | null,
    agentId: string | null,
    config: AutoRollbackConfig,
    commitHash: string,
    baseline: MonitorBaseline = { errorRate: 0 },
  ): void {
    const monitor: PersistedMonitor = {
      proposalId,
      skillId,
      agentId,
      config,
      commitHash,
      appliedAt: Date.now(),
      activationCount: 0,
      baseline,
      cumSuccesses: 0,
      cumErrors: 0,
    };
    this.monitors.set(proposalId, monitor);
    void this.saveState();
  }

  /** Record an activation result and trigger evaluation when the observation
   *  window is reached. */
  onActivationComplete(
    skillId: string | null,
    agentId: string | null,
    result: ActivationResult,
  ): void {
    for (const monitor of this.monitors.values()) {
      // Strict two-way match: a monitor scoped to a skill/agent only counts
      // activations of that exact skill/agent; a null monitor (no context)
      // only counts null activations. This prevents cross-session pollution.
      if (monitor.skillId !== skillId) continue;
      if (monitor.agentId !== agentId) continue;

      monitor.activationCount++;
      monitor.cumSuccesses += result.success ? 1 : 0;
      monitor.cumErrors += result.errorCount;

      if (monitor.activationCount >= monitor.config.observationWindow) {
        this.evaluate(monitor.proposalId);
      }
    }
    void this.saveState();
  }

  /** Compare current running metrics against the baseline — rollback if
   *  either threshold is breached, otherwise remove the monitor. */
  private evaluate(proposalId: string): void {
    const monitor = this.monitors.get(proposalId);
    if (!monitor) return;

    // A monitor whose revert attempts are exhausted is kept for visibility
    // until manual intervention — do not keep hammering git.
    if (monitor.rollbackFailed) return;

    const { config, baseline } = monitor;
    const successRate = monitor.cumSuccesses / monitor.activationCount;
    const errorRate = monitor.cumErrors / monitor.activationCount;

    // Condition 1: success rate fell below the threshold.
    if (successRate < config.satisfactionThreshold) {
      void this.rollback(
        proposalId,
        `Success rate ${(successRate * 100).toFixed(1)}%` +
          ` below threshold ${(config.satisfactionThreshold * 100).toFixed(1)}%`,
      );
      return;
    }

    // Condition 2: error rate exceeds the baseline scaled by the multiplier.
    // A small absolute floor keeps the check meaningful when no real baseline
    // was available (a single spurious error must not trigger a revert).
    const errorThreshold = Math.max(
      baseline.errorRate * config.errorRateMultiplier,
      ERROR_RATE_FLOOR,
    );
    if (errorRate > errorThreshold) {
      void this.rollback(
        proposalId,
        `Error rate ${(errorRate * 100).toFixed(1)}%` +
          ` exceeds threshold ${(errorThreshold * 100).toFixed(1)}%`,
      );
      return;
    }

    // Observation passed — remove permanently.
    this.monitors.delete(proposalId);
  }

  /** Execute a git revert; the monitor is only removed once the revert
   *  actually succeeds, so a failed revert never leaves the change
   *  unsupervised. A failed attempt keeps the monitor and is retried on the
   *  next evaluation, until MAX_ROLLBACK_ATTEMPTS is reached. */
  private async rollback(proposalId: string, reason: string): Promise<void> {
    const monitor = this.monitors.get(proposalId);
    // reverting guard: concurrent evaluate() calls (back-to-back activations
    // before the revert resolves) must not issue a second revert of the same
    // commit — git would reject it and the failure would inflate the attempt
    // count.
    if (!monitor || this.reverting.has(proposalId)) return;
    this.reverting.add(proposalId);

    try {
      await execFileAsync('git', ['revert', monitor.commitHash, '--no-edit']);
      logger.info(`[AutoApplyMonitor] Rolled back proposal ${proposalId}: ${reason}`);
      this.monitors.delete(proposalId);
      await this.saveState();
    } catch (err) {
      monitor.rollbackAttempts = (monitor.rollbackAttempts ?? 0) + 1;
      if (monitor.rollbackAttempts >= MAX_ROLLBACK_ATTEMPTS) {
        monitor.rollbackFailed = true;
        logger.error(
          { err, proposalId, attempts: monitor.rollbackAttempts },
          '[AutoApplyMonitor] rollback failed after 3 attempts — manual intervention required',
        );
      } else {
        logger.warn(
          { err, proposalId, attempts: monitor.rollbackAttempts },
          '[AutoApplyMonitor] rollback failed, will retry on next evaluation',
        );
      }
      await this.saveState();
    } finally {
      this.reverting.delete(proposalId);
    }
  }

  /** List currently active monitors (for reporting / dashboard). */
  getActiveMonitors(): Array<{
    proposalId: string;
    activationCount: number;
    observationWindow: number;
    rollbackAttempts?: number;
    rollbackFailed?: boolean;
  }> {
    return Array.from(this.monitors.values()).map((m) => ({
      proposalId: m.proposalId,
      activationCount: m.activationCount,
      observationWindow: m.config.observationWindow,
      rollbackAttempts: m.rollbackAttempts,
      rollbackFailed: m.rollbackFailed,
    }));
  }

  /** Whether a revert is currently in flight for the proposal. The
   *  in-flight guard only clears after the rollback chain fully settles
   *  (including the saveState IO), so tests can wait for it before firing
   *  the next activation instead of racing the filesystem. */
  isReverting(proposalId: string): boolean {
    return this.reverting.has(proposalId);
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  private async saveState(): Promise<void> {
    try {
      await mkdir(dirname(this.statePath), { recursive: true });
      await writeFile(
        this.statePath,
        JSON.stringify({ monitors: Array.from(this.monitors.values()) }, null, 2),
        'utf-8',
      );
    } catch (err) {
      logger.error({ err }, '[AutoApplyMonitor] failed to persist monitor state');
    }
  }
}
