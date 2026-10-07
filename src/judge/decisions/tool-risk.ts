/**
 * Decision point `tool.risk` (kernel M3, plan §6 point 12, impl doc §4.8).
 *
 * After a risky command that policy ALLOWS (a remembered approval, an allow
 * policy, an allowlist match) is about to run, judge whether the user actually
 * asked for this operation. ONE noul per evaluation.
 *
 * ONE-WAY FUSE (the task contract narrows the impl doc's §4.8 exemption):
 * the verdict may ONLY tighten approval — P(asked) <= {@link NOT_ASKED_PROBABILITY}
 * forces the approval card even though policy let the command through.
 * P(asked) >= 0.85 does NOT exempt anything (never auto-approve, never weaken
 * an approval requirement); every other verdict — gray, fallback, low P — keeps
 * the current behavior. The judgment can therefore only add approval cards,
 * never remove them.
 *
 * Fallback: tighten = false — the risky-but-allowed command flows through
 * unchanged (current behavior, byte-equal).
 */

import { defineDecision, noul, type DecisionOutcome, type DecisionSpec } from '../types.js';
import type { JudgeEngine } from '../engine.js';
import { currentJudgeEngine } from '../engine-lookup.js';

export const TOOL_RISK_POINT_ID = 'tool.risk';

/** P(asked) at or below which the approval requirement is tightened (ask again). */
export const NOT_ASKED_PROBABILITY = 0.3;

/** Command text capped into the judge state (impl doc §4.8: 任务句 + 命令行 + 规则名). */
export const TOOL_RISK_COMMAND_MAX = 300;

const ASKED_QUESTION = noul('did the user explicitly ask for this operation in this session?', {
  true: 'the turn goal or earlier messages clearly requested exactly this kind of operation',
  false: 'the agent decided on this operation on its own; the user never requested it',
});

export const toolRiskSpec: DecisionSpec = defineDecision({
  id: TOOL_RISK_POINT_ID,
  version: 1,
  questions: { 'risk.asked': ASKED_QUESTION },
  buildState: (raw: unknown): { taskHint: string; command: string } => {
    // engine.decide passes the whole DecisionInput — unwrap `state`.
    const call = raw as { state?: unknown } | undefined;
    const input = ((call && typeof call === 'object' && 'state' in call ? call.state : raw) ??
      {}) as Partial<{ taskHint: string; command: string }>;
    return {
      taskHint: typeof input.taskHint === 'string' ? input.taskHint.slice(0, 200) : '',
      command:
        typeof input.command === 'string' ? input.command.slice(0, TOOL_RISK_COMMAND_MAX) : '',
    };
  },
  policy: ((answers) => {
    const answer = answers['risk.asked'] as { type?: string; probability?: number } | undefined;
    if (answer?.type === 'noul' && typeof answer.probability === 'number') {
      if (answer.probability <= NOT_ASKED_PROBABILITY) {
        return { action: 'ask' } as DecisionOutcome; // tighten: send the approval card after all
      }
    }
    // Anything else — gray, high P(asked), insufficient confidence — keeps the
    // current allowed flow. NEVER auto-approve.
    return { action: 'none' } as DecisionOutcome;
  }) as DecisionSpec['policy'],
  fallback: { action: 'none' },
});

export interface JudgeToolRiskResult {
  asked: boolean;
  /**
   * True only when judged+active AND the user most likely never asked for
   * this command: the hook must fall back into the approval flow (tighten).
   * Every other result — shadow/off/fallback/gray/explicit user request —
   * leaves the current allowed behavior untouched.
   */
  tighten?: boolean;
}

/**
 * Judge a risky-but-policy-allowed shell command (hook, called from
 * `before-tool-call.ts` at the policy-allow branch). STRICT no-op: engine
 * absent, mode off, or caller skipped at the mode check → no call.
 */
export async function judgeToolRisk(input: {
  engine?: JudgeEngine;
  sessionId?: string;
  command: string;
  taskHint?: string;
}): Promise<JudgeToolRiskResult> {
  const engine = input.engine ?? currentJudgeEngine();
  if (!engine) return { asked: false };
  if (engine.modeFor(TOOL_RISK_POINT_ID) === 'off') return { asked: false };

  const verdict = await engine.decideMany(toolRiskSpec, {
    state: {
      taskHint: input.taskHint ?? '',
      command: input.command.slice(0, TOOL_RISK_COMMAND_MAX),
    },
    sessionId: input.sessionId,
  });
  if (verdict.source !== 'judge' || verdict.mode !== 'active') return { asked: true };
  if (verdict.outcome.action !== 'ask') return { asked: true }; // tighten-only contract
  return { asked: true, tighten: true };
}
