/**
 * Judge autopilot runtime (impl doc §7 automation) — wires the pure gates in
 * `src/judge/autopilot.ts` to the ledger files, config.yaml and the hot-reload
 * path. Fully automatic: promotion and demotion rely exclusively on the
 * shadow-agreement statistical gates — no human confirmation anywhere.
 *
 * Managed-set invariant: only points the autopilot promoted itself may be
 * auto-demoted; points the user pinned active in config.yaml are never touched.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig } from './types.js';
import type { JudgeSectionConfig, JudgeMode } from '../judge/types.js';
import {
  collectLedger,
  runAudit,
  type AuditDecision,
  type LedgerLike,
  type PointStats,
} from '../judge/autopilot.js';
import { loadConfig } from './config.js';
import { mutateConfigYaml, readConfigObject, applyConfigObject } from './webui/yaml-mutation.js';

/** Durable record of what the autopilot manages (survives restarts). */
interface AutopilotState {
  managed: Record<string, { promotedAt: string; demotedAt?: string }>;
}

/** Structural logger subset — accepts pino Logger or FastifyBaseLogger. */
export interface AutopilotLogger {
  debug(msg: string, ...o: unknown[]): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
}

interface AutopilotDeps {
  /** Ledger base directory (same as JudgeLedger's). */
  ledgerDir: string;
  /** Judge section at wiring time (startup gate only — audits themselves
   * always re-read the LIVE config via getConfig()). */
  judge: JudgeSectionConfig | undefined;
  /** LIVE config snapshot at audit time (never a wiring-time copy — the user
   * may pin points active/shadow in the UI while the autopilot is running).
   * NOTE: must not be the same import as a boot-critical loadConfig call
   * count assertion (bootstrap test) — audits are infrequent by design. */
  getConfig: () => AppConfig;
  onConfigSaved: (newConfig: AppConfig) => void;
  logger: AutopilotLogger;
  /** Interval between audits. Default 6h. */
  intervalMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

const STATE_FILE = 'autopilot.json';

function readState(dir: string): AutopilotState {
  try {
    const raw = JSON.parse(readFileSync(join(dir, STATE_FILE), 'utf8')) as AutopilotState;
    if (raw && typeof raw.managed === 'object' && raw.managed !== null)
      return { managed: raw.managed };
  } catch {
    /* first run / corrupt file → start empty */
  }
  return { managed: {} };
}

function writeState(dir: string, state: AutopilotState, logger?: AutopilotLogger): void {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  } catch (err) {
    logger?.warn({ err }, 'Judge autopilot state write failed (non-fatal)');
  }
}

/** Effective mode per point (`modes[pointId] ?? modes.default ?? 'shadow'`). */
export function effectiveModes(judge: JudgeSectionConfig | undefined): Record<string, JudgeMode> {
  const modes: Record<string, JudgeMode> = { default: judge?.modes?.default ?? 'shadow' };
  for (const [point, mode] of Object.entries(judge?.modes ?? {})) {
    if (point !== 'default') modes[point] = mode;
  }
  return modes;
}

export interface AutopilotReport {
  ranAt: string;
  promote: string[];
  demote: string[];
  managed: Record<string, { promotedAt: string; demotedAt?: string }>;
  report: Awaited<ReturnType<typeof runAudit>>['report'];
}

/** One audit pass — used by the interval timer, the manual trigger route and
 * the WebUI telemetry panel (apply:false → dry run, config untouched). */
export async function auditOnce(
  deps: AutopilotDeps,
  opts?: { apply?: boolean },
): Promise<AutopilotReport> {
  const apply = opts?.apply ?? true;
  const now = deps.now ?? (() => Date.now());
  const judgeNow = deps.getConfig().judge;
  if (!judgeNow?.enabled) {
    // Kernel disabled (hot-reload race or user off-switch): complete no-op —
    // never touch modes behind a globally disabled kernel.
    return {
      ranAt: new Date(now()).toISOString(),
      promote: [],
      demote: [],
      managed: readState(deps.ledgerDir).managed,
      report: [],
    };
  }
  const { stats, entries } = collectLedger(deps.ledgerDir);
  const appConfig = deps.getConfig();
  const current = effectiveModes(appConfig.judge);
  const state = readState(deps.ledgerDir);
  const decision: AuditDecision = runAudit({
    stats,
    entries,
    currentModes: current,
    managed: state.managed,
  });

  // Dry run (WebUI telemetry panel): report only, never touch config.
  if (!apply) {
    return {
      ranAt: new Date(now()).toISOString(),
      promote: decision.promote,
      demote: decision.demote,
      managed: state.managed,
      report: decision.report,
    };
  }

  let configChanged = false;
  let nextManaged = { ...state.managed };

  if (decision.promote.length > 0 || decision.demote.length > 0) {
    await mutateConfigYaml((doc) => {
      const existing = readConfigObject(doc);
      const judgeYaml = (existing.judge ?? {}) as Record<string, unknown>;
      const modesYaml = (judgeYaml.modes ?? {}) as Record<string, unknown>;
      for (const pointId of decision.promote) {
        modesYaml[pointId] = 'active';
        nextManaged = {
          ...nextManaged,
          [pointId]: { promotedAt: new Date(now()).toISOString() },
        };
      }
      for (const pointId of decision.demote) {
        modesYaml[pointId] = 'shadow';
        const prev = nextManaged[pointId];
        nextManaged = {
          ...nextManaged,
          [pointId]: {
            promotedAt: prev?.promotedAt ?? '',
            demotedAt: new Date(now()).toISOString(),
          },
        };
      }
      existing.judge = { ...judgeYaml, modes: modesYaml };
      applyConfigObject(doc, existing);
      configChanged = true;
    });
  }

  if (configChanged) {
    writeState(deps.ledgerDir, { managed: nextManaged }, deps.logger);
    // Same hot-reload path the WebUI judge routes use — rebuilds the engine
    // with the new modes without a process restart.
    deps.onConfigSaved(loadConfig());
  }

  for (const point of decision.report) {
    if (point.decision !== 'hold') {
      deps.logger.info(
        {
          pointId: point.pointId,
          decision: point.decision,
          samples: point.stats.total,
          comparable: point.stats.comparable,
          reasons: point.reasons,
        },
        `Judge autopilot ${point.decision}d decision point`,
      );
    }
  }

  return {
    ranAt: new Date(now()).toISOString(),
    promote: decision.promote,
    demote: decision.demote,
    managed: nextManaged,
    report: decision.report,
  };
}

/**
 * Start the autopilot loop. Returns a stop function. Inert (no timer) when the
 * judge section is absent or disabled — the whole kernel stays off with it.
 */
export function startJudgeAutopilot(deps: AutopilotDeps): () => void {
  if (!deps.judge?.enabled) {
    deps.logger.debug('Judge autopilot not started (kernel disabled)');
    return () => {};
  }
  const intervalMs = deps.intervalMs ?? 6 * 60 * 60 * 1000;
  // First pass shortly after boot: existing shadow history may already satisfy
  // the gates (e.g. after an offline evaluation period).
  const initial = setTimeout(
    () =>
      void auditOnce(deps).catch((err: unknown) =>
        deps.logger.warn({ err }, 'Judge autopilot audit failed'),
      ),
    30_000,
  );
  const timer = setInterval(
    () =>
      void auditOnce(deps).catch((err: unknown) =>
        deps.logger.warn({ err }, 'Judge autopilot audit failed'),
      ),
    intervalMs,
  );
  timer.unref?.();
  initial.unref?.();
  deps.logger.info(
    { intervalMs },
    'Judge autopilot started (statistical gates only, no human confirmation)',
  );
  return () => {
    clearTimeout(initial);
    clearInterval(timer);
  };
}

/** Re-export for the manual-trigger route. */
export { auditOnce as runAuditOnce };
export type { PointStats, LedgerLike };
