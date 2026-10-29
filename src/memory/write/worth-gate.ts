/**
 * Worth gate for summarizer preference candidates (plan §3.3 point 2).
 *
 * `judgeExperiences()` cannot host this: its input is user messages, while a
 * summarizer candidate is a string the model wrote, so the two shapes do not
 * share a state object. This module bridges the candidates into the EXISTING
 * `memory.worth` decision point instead of defining a new one — a new point
 * would have to be registered in `src/judge/decisions/registry.ts` and declared
 * in `config.yaml`'s modes table, a far larger change than one gate is worth.
 *
 * Mode semantics (the mode is read from the engine, never from config here):
 *   - engine absent or `memory.worth` not `active` (shadow is the default):
 *     candidates pass through unchanged — behavior-neutral, exactly like the
 *     judged gate's shadow handling;
 *   - `active`: only `useful-again` candidates survive. `one-off` (one-time
 *     logistics) and `already-known` are dropped, and so is a fallback verdict
 *     (`MEMORY_WORTH_FALLBACK = { action: 'none' }`): the summarizer window is
 *     incremental, so a judge outage means writing less, never writing noise.
 *
 * Failures never reach the write path: `decideMany` does not reject, and
 * anything thrown here is logged and degraded to "keep the candidates".
 */

import type { Logger } from 'pino';
import type { JudgeEngine } from '../../judge/engine.js';
import { currentJudgeEngine } from '../../judge/engine-lookup.js';
import {
  createMemoryWorthSpec,
  MEMORY_WORTH_POINT_ID,
  memoryWorthKeys,
  type MemoryWorthCandidate,
} from '../../judge/decisions/memory-worth.js';

/** Scenario excerpt carried into the judge state (state minimization, same bound as §4.5). */
const SCENARIO_MAX = 200;

export interface PreferenceWorthGateInput {
  /** Candidates that already passed the shape and durability gates. */
  candidates: string[];
  /** This run's summary text (truncated) — the situation the candidates came from. */
  sessionScenario?: string;
  /** Live engine lookup; falls back to the process-wide resolver. */
  judgeGet?: () => JudgeEngine | undefined;
  /** Session key, for the ledger line's file. */
  sessionId?: string;
  logger?: Pick<Logger, 'debug' | 'warn'>;
}

/**
 * Filter candidates through `memory.worth`. Returns the candidates that may be
 * persisted; returns them all when there is no judgment to apply.
 */
export async function judgePreferenceCandidates(
  input: PreferenceWorthGateInput,
): Promise<string[]> {
  const { candidates } = input;
  if (candidates.length === 0) return candidates;

  try {
    const engine = input.judgeGet?.() ?? currentJudgeEngine();
    if (!engine) return candidates;
    if (engine.modeFor(MEMORY_WORTH_POINT_ID) !== 'active') return candidates;

    const keys = memoryWorthKeys(candidates.length);
    const worthCandidates: MemoryWorthCandidate[] = candidates.map((text, index) => ({
      id: `p${index + 1}`,
      key: keys[index]!,
      text,
    }));
    const verdict = await engine.decideMany(createMemoryWorthSpec(worthCandidates), {
      state: {
        ...(input.sessionScenario
          ? { scenario: input.sessionScenario.slice(0, SCENARIO_MAX) }
          : {}),
        candidates: worthCandidates,
      },
      sessionId: input.sessionId,
    });

    // A mode flip between the check above and the call: apply nothing.
    if (verdict.mode !== 'active') return candidates;
    if (verdict.outcome.action === 'keep-all') return candidates;
    if (verdict.outcome.action !== 'keep') {
      input.logger?.debug(
        {
          sessionId: input.sessionId,
          candidates: worthCandidates.length,
          outcome: verdict.outcome.action,
          source: verdict.source,
        },
        'memory.worth kept no preference candidates',
      );
      return [];
    }
    const keep = new Set(verdict.outcome.ids);
    const kept = worthCandidates.filter((candidate) => keep.has(candidate.id));
    if (kept.length < worthCandidates.length) {
      input.logger?.debug(
        { sessionId: input.sessionId, kept: kept.length, judged: worthCandidates.length },
        'memory.worth dropped preference candidates',
      );
    }
    return kept.map((candidate) => candidate.text);
  } catch (err) {
    input.logger?.warn(
      { err, sessionId: input.sessionId },
      'memory.worth gate failed — keeping candidates (non-fatal)',
    );
    return candidates;
  }
}
