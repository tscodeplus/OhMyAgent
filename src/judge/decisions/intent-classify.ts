/**
 * Decision point `intent.classify` (phase-1 M1, plan §6 point 3, impl doc §4.3).
 *
 * Judge upgrade of the regex `src/agent/intent.ts` logic. The regex floor is
 * UNTOUCHED and stays the reconciliation baseline:
 *
 *   one `decideMany` call, two questions over a shared state:
 *     - `message.domain` — choice over the six IntentDomain values plus the
 *       `other` escape hatch (a choice always needs a winner, plan §7.2);
 *     - `message.thinkingNeed` — score(trivial/normal/hard), surfaced in the
 *       Verdict answers for the hook to decide on (phase-1 default: thinking is
 *       NOT changed — no "dynamic thinking allowed" config exists yet).
 *
 * Reconciliation policy (impl doc §4.3): winner === regex domain → regex;
 * winner != regex && confidence >= 0.7 → judge; otherwise → regex. `route`
 * choice values are one of the six domains, `other`, or the `regex-floor`
 * sentinel (regex is the floor — the hook keeps the current behavior).
 *
 * Hard constraint honored in the hook (src/judge/decisions/intent-classify.ts →
 * `judgeIntentAtTurnStart`, awaited in AgentService.execute()): the synchronous
 * `isToolVisibleForIntent` consumers in the tool pipeline are never made async.
 */

import {
  choice,
  defineDecision,
  score,
  type DecisionOutcome,
  type DecisionSpec,
} from '../types.js';
import { detectIntentDomain, type IntentDomain } from '../../agent/intent.js';

export const INTENT_CLASSIFY_POINT_ID = 'intent.classify';

/** Fields a choice says may be an intent domain; `other` is the escape hatch. */
export const INTENT_DOMAIN_CHOICES = [
  'code',
  'web',
  'multimedia',
  'memory',
  'project-management',
  'bare-chat',
  'other',
] as const;

export interface IntentClassifyState {
  /** Message body, truncated. */
  message: string;
  /** Regex floor for the same message (detectIntentDomain result). */
  regexDomain?: string;
}

export const INTENT_CLASSIFY_SPEC_ID = INTENT_CLASSIFY_POINT_ID;

const DOMAIN_QUESTION = choice('Which intent domain does this user message belong to?', {
  code: 'writing, fixing, building or running code, tests, git, compilation',
  web: 'web search, lookup, browsing, fetching pages or news',
  multimedia: 'generating or describing images, video, speech, transcription',
  memory: 'remembering, recalling, storing or forgetting information',
  'project-management': 'todos, tasks, schedules, reminders, planning',
  'bare-chat': 'greetings, thanks, small talk with no task at all',
  other: 'none of the listed domains fits — escape hatch for anything else',
});

const THINKING_QUESTION = score('How much thinking does answering this message need?', [
  'trivial',
  'normal',
  'hard',
]);

/** Judge-choice confidence at which the judge may overrule the regex floor. */
export const INTENT_OVERRIDE_CONFIDENCE = 0.7;

/** Route sentinel: no judged override — the hook keeps the regex floor behavior. */
export const ROUTE_REGEX_FLOOR = 'regex-floor';

function intentClassifyPolicy(
  answers: Record<string, unknown>,
  ctx: { input: { state: unknown } },
): DecisionOutcome {
  const answer = answers['message.domain'] as
    { type?: string; choice?: string; confidence?: number } | undefined;
  if (!answer || answer.type !== 'choice' || typeof answer.choice !== 'string') {
    return { action: 'route', choice: ROUTE_REGEX_FLOOR };
  }
  const winner = answer.choice;
  const judgedConfidence = typeof answer.confidence === 'number' ? answer.confidence : 0;
  const regexDomain =
    typeof (ctx.input.state as IntentClassifyState | undefined)?.regexDomain === 'string'
      ? ((ctx.input.state as IntentClassifyState).regexDomain as string)
      : undefined;
  if (winner === regexDomain) return { action: 'route', choice: winner };
  if (judgedConfidence >= INTENT_OVERRIDE_CONFIDENCE) {
    return { action: 'route', choice: winner };
  }
  return { action: 'route', choice: regexDomain ?? ROUTE_REGEX_FLOOR };
}

/**
 * Fallback = no judged override (`regex-floor`): without a verdict the current
 * regex behavior stands, byte-for-byte.
 */
export const intentClassifySpec: DecisionSpec = defineDecision({
  id: INTENT_CLASSIFY_POINT_ID,
  version: 1,
  questions: {
    'message.domain': DOMAIN_QUESTION,
    'message.thinkingNeed': THINKING_QUESTION,
  },
  buildState: (raw: unknown): IntentClassifyState => {
    // engine.decide passes the whole DecisionInput — unwrap `state`.
    const call = raw as { state?: unknown } | undefined;
    const input = ((call && typeof call === 'object' && 'state' in call ? call.state : raw) ??
      {}) as Partial<IntentClassifyState>;
    return {
      message: typeof input.message === 'string' ? input.message.slice(0, 500) : '',
      ...(typeof input.regexDomain === 'string' ? { regexDomain: input.regexDomain } : {}),
    };
  },
  policy: intentClassifyPolicy as DecisionSpec['policy'],
  fallback: { action: 'route', choice: ROUTE_REGEX_FLOOR },
});

/**
 * Map a judged/registered route choice onto the narrowing override:
 * - a real IntentDomain → that domain narrows;
 * - `other` → the judge is confident nothing narrows ('none');
 * - `regex-floor` (fallback path) → no override at all, regex stays.
 */
export function mapIntentRouteChoice(routeChoice: string): IntentDomain | 'none' | undefined {
  if (routeChoice === ROUTE_REGEX_FLOOR) return undefined;
  if (routeChoice === 'other') return 'none';
  if (routeChoice === 'code') return 'code';
  if (routeChoice === 'web') return 'web';
  if (routeChoice === 'multimedia') return 'multimedia';
  if (routeChoice === 'memory') return 'memory';
  if (routeChoice === 'project-management') return 'project-management';
  if (routeChoice === 'bare-chat') return 'bare-chat';
  return undefined;
}

export interface JudgeIntentAtTurnStartResult {
  /** True when a judge call was made (shadow or active — ledger has a line). */
  asked: boolean;
  /**
   * `active` + judged only: `IntentDomain` to narrow with, `'none'` when the
   * judge confidently says nothing fits, `undefined` whenever the regex floor
   * applies (shadow / fallback / low-confidence / unparseable).
   */
  override?: IntentDomain | 'none';
}

/**
 * Turn-start judged intent (hook, phase-1 M1). Awaited in the async turn
 * assembly flow (AgentService.execute); the synchronous tool-pipeline
 * `isToolVisibleForIntent` consumers stay untouched — the factory reads the
 * override from the turn context when assembling the tool surface.
 *
 * STRICT no-op: engine absent or point mode 'off' → no call, no ledger line.
 * Shadow → asks + ledger but always `override: undefined` (zero behavior change).
 */
export async function judgeIntentAtTurnStart(input: {
  engine?: import('../engine.js').JudgeEngine;
  message: string;
  sessionId?: string;
}): Promise<JudgeIntentAtTurnStartResult> {
  const engine = input.engine;
  if (!engine || !input.message) return { asked: false };
  if (engine.modeFor(INTENT_CLASSIFY_POINT_ID) === 'off') return { asked: false };

  const regexMatch = detectIntentDomain(input.message);
  const verdict = await engine.decideMany(intentClassifySpec, {
    state: {
      message: input.message.slice(0, 500),
      regexDomain: regexMatch?.domain,
    },
    sessionId: input.sessionId,
  });
  if (verdict.source !== 'judge' || verdict.mode !== 'active') return { asked: true };
  if (verdict.outcome.action !== 'route') return { asked: true };
  return { asked: true, override: mapIntentRouteChoice(verdict.outcome.choice) };
}
