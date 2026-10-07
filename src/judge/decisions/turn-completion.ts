/**
 * Decision point `turn.completion` (kernel M3, plan §6 point 11, impl doc §4.7).
 *
 * End-of-turn check: did the closing statement cite any verification result
 * (test / command output / file check)? One noul over the last assistant text;
 * P(no verification) >= {@link NO_VERIFICATION_PROBABILITY} → at most ONE
 * steering nudge per turn (the hook runs it as a `followUp` continuation card
 * from `AgentService.execute()` — no pi-mono changes).
 *
 * Rule floor: the check only runs for turns that actually executed tools — a
 * no-tool conversational turn has nothing to verify and is never judged.
 *
 * Fallback: no nudge (current behavior exactly).
 */

import { defineDecision, noul, type DecisionOutcome, type DecisionSpec } from '../types.js';
import type { JudgeEngine } from '../engine.js';
import { currentJudgeEngine } from '../engine-lookup.js';

export const TURN_COMPLETION_POINT_ID = 'turn.completion';

/** P(no verification cited) at or above which the nudge fires (impl doc §4.7: ≥ 0.8). */
export const NO_VERIFICATION_PROBABILITY = 0.8;

/** Last assistant text capped into the judge state (state minimization). */
export const COMPLETION_TEXT_MAX = 800;

const COMPLETION_QUESTION = noul('does the agent cite any verification result before closing?', {
  true: 'the closing statement explicitly references a check: a passing command/test, output that matched expectations, or a verified file/state',
  false: 'the closing statement claims completion/done with no cited check or evidence',
});

export const turnCompletionSpec: DecisionSpec = defineDecision({
  id: TURN_COMPLETION_POINT_ID,
  version: 1,
  questions: { 'completion.verified': COMPLETION_QUESTION },
  buildState: (raw: unknown): { lastAssistantText: string; hadToolCalls: boolean } => {
    // engine.decide passes the whole DecisionInput — unwrap `state`.
    const call = raw as { state?: unknown } | undefined;
    const input = ((call && typeof call === 'object' && 'state' in call ? call.state : raw) ??
      {}) as Partial<{ lastAssistantText: string; hadToolCalls: boolean }>;
    return {
      lastAssistantText:
        typeof input.lastAssistantText === 'string'
          ? input.lastAssistantText.slice(0, COMPLETION_TEXT_MAX)
          : '',
      hadToolCalls: input.hadToolCalls === true,
    };
  },
  policy: ((answers) => {
    const answer = answers['completion.verified'] as
      { type?: string; probability?: number } | undefined;
    if (answer?.type === 'noul' && typeof answer.probability === 'number') {
      // noul "true" = verification cited → P(no verification) = 1 - probability.
      if (1 - answer.probability >= NO_VERIFICATION_PROBABILITY) {
        return {
          action: 'steer',
          message:
            '(completion check) Your last reply closed the work without citing any verification ' +
            'result. If a check is still possible quickly (run the test, re-read the file, confirm ' +
            'the output), do it and report the result with a fact-check; otherwise state explicitly ' +
            'that this turn was NOT verified and how the user can verify it.',
        } as DecisionOutcome;
      }
    }
    return { action: 'none' } as DecisionOutcome;
  }) as DecisionSpec['policy'],
  fallback: { action: 'none' },
});

export interface JudgeTurnCompletionResult {
  asked: boolean;
  /** Active+judged only: the nudge message to run as one continuation card. */
  nudgedMessage?: string;
}

/** Extract the last assistant text from an agent transcript (first-party caller helper). */
export function lastAssistantTextOf(
  messages: readonly { role: string; content: unknown }[],
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== 'assistant') continue;
    const blocks = message.content;
    if (typeof blocks === 'string') return blocks;
    if (Array.isArray(blocks)) {
      const text = (blocks as { type?: string; text?: string }[])
        .filter((b) => b?.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text!)
        .join('\n')
        .trim();
      if (text) return text;
    }
  }
  return '';
}

/**
 * Judge the turn's closing statement (hook, called from `AgentService.execute()`
 * after the turn settles). STRICT no-op: engine absent, mode off, a turn with
 * no tool calls, or an empty closing text → no call, no ledger line.
 */
export async function judgeTurnCompletion(input: {
  engine?: JudgeEngine;
  sessionId: string;
  /** Last assistant message text (the closing statement). */
  lastAssistantText: string;
  /** Rule floor: only turns with at least one executed tool call are judged. */
  hadToolCalls: boolean;
}): Promise<JudgeTurnCompletionResult> {
  const engine = input.engine ?? currentJudgeEngine();
  if (!engine) return { asked: false };
  if (engine.modeFor(TURN_COMPLETION_POINT_ID) === 'off') return { asked: false };
  if (!input.hadToolCalls) return { asked: false };
  const text = input.lastAssistantText.trim();
  if (!text) return { asked: false };

  const verdict = await engine.decideMany(turnCompletionSpec, {
    state: {
      lastAssistantText: text.slice(0, COMPLETION_TEXT_MAX),
      hadToolCalls: true,
    },
    sessionId: input.sessionId,
  });
  if (verdict.source !== 'judge' || verdict.mode !== 'active') return { asked: true };
  if (verdict.outcome.action !== 'steer') return { asked: true };
  return { asked: true, nudgedMessage: verdict.outcome.message };
}
