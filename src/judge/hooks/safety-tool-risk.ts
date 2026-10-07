/**
 * Hook for kernel M3 decision point `tool.risk` (impl doc §4.8): the
 * tighten-only judged check that runs at the approval-gating path after a
 * risky shell command was allowed by policy (remembered approval / allow
 * policy / allowlist match).
 *
 * ONE-WAY FUSE: the verdict may ONLY tighten approval — "the user most likely
 * never asked" forces the approval card after all. Every other result —
 * gray, fallback, engine absent, mode off, low-risk command, judged "asked" —
 * keeps the current allow flow. The judgment can therefore only ADD approval
 * cards: it can never auto-approve or weaken an approval requirement, and it
 * can never fail open (failing open here would mean skipping a card that
 * policy still requires, which only the tighten=true path can cause — it is
 * driven by a judged verdict, not by a judge failure).
 *
 * Callers: `src/agent/before-tool-call.ts` (legacy shell gate + PolicyCenter
 * path). The judge call is awaited inside the already-async beforeToolCall
 * hook — no floating promises.
 */

import { assessCommandRisk } from '../../tools/shell-command-policy.js';
import { TOOL_RISK_POINT_ID, judgeToolRisk } from '../decisions/tool-risk.js';
import { getTurnTaskHint } from '../../agent/agent-context.js';
import type { JudgeEngine } from '../engine.js';

export interface TightenToolRiskInput {
  /** Live engine, or the present-only getter (`deps.judgeGet`) used by callers. */
  engine?: JudgeEngine | (() => JudgeEngine | undefined);
  sessionId?: string;
  /** The tightening check applies to shell commands only. */
  toolName: string;
  command?: string;
  /** Where the check runs — for ledger-adjacent log lines only. */
  source?: string;
  logger?: {
    warn: (...args: any[]) => void;
    info: (...args: any[]) => void;
  };
}

/**
 * Return true when the judged check says the risky-but-allowed shell command
 * must fall back into the approval-card flow (tighten). Never throws; every
 * skip path (engine absent, mode off, non-shell, low risk, judge failure,
 * verdict that is not an explicit "not asked") returns false and keeps the
 * current allow flow byte-equal.
 */
export async function maybeTightenShellApproval(input: TightenToolRiskInput): Promise<boolean> {
  if (input.toolName !== 'shell') return false;
  let engine: JudgeEngine | undefined;
  try {
    engine = typeof input.engine === 'function' ? input.engine() : input.engine;
  } catch (err) {
    input.logger?.warn({ err }, 'tool.risk engine getter threw — keeping allow flow');
    return false;
  }
  if (!engine) return false;
  if (engine.modeFor(TOOL_RISK_POINT_ID) === 'off') return false;
  const command = input.command ?? '';
  if (assessCommandRisk(command) === 'low') return false;
  try {
    const judgedRisk = await judgeToolRisk({
      engine,
      sessionId: input.sessionId,
      command,
      taskHint: input.sessionId ? getTurnTaskHint(input.sessionId) : undefined,
    });
    if (judgedRisk.tighten) {
      input.logger?.info(
        { sessionId: input.sessionId, command: command.slice(0, 80), source: input.source },
        'tool.risk judged — tightening allowed risky command into approval flow',
      );
      return true;
    }
  } catch (err) {
    input.logger?.warn({ err }, 'tool.risk judged check failed — keeping allow flow');
  }
  return false;
}
