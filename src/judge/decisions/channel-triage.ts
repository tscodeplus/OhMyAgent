/**
 * Decision point `channel.triage` (kernel M4, plan §6 point 14, impl doc
 * §4.10): group-chat message entrance pre-judgment — before the channel
 * extension's @-mention baseline gate decides whether the agent responds at
 * all, ONE decideMany answers:
 *
 *   1. `triage.addressed` (noul) — read FIRST: is this group message
 *      addressed at the agent (mention / reply / clearly directed)?
 *   2. `triage.action` (choice) — when the message probably does NOT address
 *      the agent: respond / ignore / defer.
 *
 * Fallback: `defer` — byte-equal to the existing gating behavior (@-mention
 * baseline). Applied only in active mode (`defer` in shadow/off/unanswered),
 * so mode shadow/off is the current behavior by construction.
 */

import { choice, defineDecision, noul, type DecisionSpec } from '../types.js';
import type { JudgeEngine } from '../engine.js';
import { currentJudgeEngine } from '../engine-lookup.js';

export const CHANNEL_TRIAGE_POINT_ID = 'channel.triage';

/** Message text cap carried into the judge state (plan §7.4 minimized state). */
export const TRIAGE_TEXT_MAX = 500;

/** noul P(addressed) at or above which the message is answered regardless of the choice. */
export const TRIAGE_ADDRESSED_PROBABILITY = 0.85;
/** noul P(addressed) at or below which the choice verdict rules the gate. */
export const TRIAGE_NOT_ADDRESSED_PROBABILITY = 0.3;

/**
 * Hook-level latency budget for the group-message gate (impl doc §9 row 6:
 * the interactive entrance must stay inside p95 < 1s). When the judge cannot
 * answer in time the verdict falls back → current gate behavior.
 */
export const TRIAGE_LATENCY_BUDGET_MS = 1000;

export interface ChannelTriageState {
  /** First 500 chars of the group message text. */
  text: string;
  /** Always 'group' — the point only runs on group messages. */
  chatType: 'group';
  /** Caller-known mention signal (@-mention / reply-to-bot), when any. */
  mentionedBot: boolean;
}

const ADDRESSED_QUESTION = noul(
  'does this group message address the agent or expect a reply from it?',
  {
    true: 'the message @-mentions the agent, replies to it, or is clearly directed at it',
    false: 'the message is addressed to other group members; the agent is not expected to reply',
  },
);

const ACTION_QUESTION = choice('should the agent respond to this group message?', {
  respond: 'the message is relevant enough for the agent to join and answer',
  ignore: 'the agent should stay silent on this message',
  defer: 'follow the default group gating rule (@-mention) without a judgment',
});

export const channelTriageSpec: DecisionSpec = defineDecision({
  id: CHANNEL_TRIAGE_POINT_ID,
  version: 1,
  questions: {
    'triage.addressed': ADDRESSED_QUESTION,
    'triage.action': ACTION_QUESTION,
  },
  buildState: (raw: unknown): ChannelTriageState => {
    // engine.decide passes the whole DecisionInput — unwrap `state`.
    const call = raw as { state?: unknown } | undefined;
    const input = ((call && typeof call === 'object' && 'state' in call ? call.state : raw) ??
      {}) as Partial<ChannelTriageState>;
    return {
      text: typeof input.text === 'string' ? input.text.slice(0, TRIAGE_TEXT_MAX) : '',
      chatType: 'group',
      mentionedBot: input.mentionedBot === true,
    };
  },
  // Applied in active mode only (impl doc §4.10: read the noul FIRST — a
  // confidently addressed message is answered no matter the choice; a
  // confidently unaddressed message falls to the choice; gray → defer).
  policy: ((answers) => {
    const addressed = answers['triage.addressed'] as
      { type?: string; probability?: number } | undefined;
    if (addressed?.type === 'noul' && typeof addressed.probability === 'number') {
      if (addressed.probability >= TRIAGE_ADDRESSED_PROBABILITY) {
        return { action: 'proceed' };
      }
      if (addressed.probability <= TRIAGE_NOT_ADDRESSED_PROBABILITY) {
        const action = answers['triage.action'] as { type?: string; choice?: string } | undefined;
        if (action?.type === 'choice') {
          if (action.choice === 'respond') return { action: 'proceed' };
          if (action.choice === 'ignore') return { action: 'discard' };
        }
      }
    }
    return { action: 'none' }; // defer — current gate behavior
  }) as DecisionSpec['policy'],
  fallback: { action: 'none' }, // defer = current gate behavior
});

export type TriageDecision = 'respond' | 'silent' | 'defer';

/**
 * Judge the group-message entrance gate (hook — called from the channel
 * extensions' gating branch). STRICT no-op: engine absent, mode off, or an
 * aborted call → 'defer' (the pre-judge gate behavior). The engine decides
 * the mode; shadow/off/gray/fallback verdicts also collapse to 'defer' here.
 *
 * The judge call is bounded by {@link TRIAGE_LATENCY_BUDGET_MS} so the
 * interactive gate never waits the full chain timeout (impl doc §9 row 6).
 */
export async function judgeChannelGroupTriage(input: {
  engine?: JudgeEngine;
  sessionId?: string;
  text: string;
  mentionedBot: boolean;
}): Promise<TriageDecision> {
  const engine = input.engine ?? currentJudgeEngine();
  if (!engine) return 'defer';
  if (engine.modeFor(CHANNEL_TRIAGE_POINT_ID) === 'off') return 'defer';

  if (typeof AbortController !== 'function') return 'defer';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TRIAGE_LATENCY_BUDGET_MS);
  try {
    const verdict = await engine.decideMany(
      channelTriageSpec,
      {
        state: {
          text: input.text.slice(0, TRIAGE_TEXT_MAX),
          chatType: 'group',
          mentionedBot: input.mentionedBot,
        },
        sessionId: input.sessionId,
      },
      controller.signal,
    );
    if (verdict.source !== 'judge' || verdict.mode !== 'active') return 'defer';
    switch (verdict.outcome.action) {
      case 'proceed':
        return 'respond';
      case 'discard':
        return 'silent';
      default:
        return 'defer';
    }
  } catch {
    return 'defer';
  } finally {
    clearTimeout(timer);
  }
}
