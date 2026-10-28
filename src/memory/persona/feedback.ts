/**
 * Persona feedback loop — the three K4 signals and the contradiction closing
 * they trigger.
 *
 * Signals are written into the EXISTING `memory_observation_events` table (no
 * new table), one row per signal with a `weight` in `details` so a consumer can
 * rank them without a second lookup:
 *
 *   persona.rejected        weight 1 — the user rejected a persona-derived claim
 *                                      ("不对 / 不是这样 / 我没说过")
 *   persona.contradicted    weight 2 — a new preference memory conflicts with
 *                                      the current persona value
 *   persona.manual_override weight 3 — the user edited the persona in the WebUI;
 *                                      highest weight, it overrides everything
 *
 * `persona.rejected` is a JUDGED signal: it goes through the judge kernel's
 * classifier channel (`persona.rejection` decision point, `judge:` config,
 * shadow/active modes). There is deliberately no regex fallback — "不是这个意思"
 * is not a rejection, and a pattern that guesses turns the feedback channel into
 * noise. When the kernel is inert (no `judge:` section → no engine) or the point
 * is `off`, NOTHING is recorded for that signal; `persona.contradicted` and
 * `persona.manual_override` keep working because they need no classifier.
 *
 * Closing: a persona field changing value closes the memories that carried the
 * OLD value — `MemoryRepository.supersede(old, new)` (sets `invalidated_at` and
 * `status='superseded'` on the old row and `supersedes_id` on the new one). The
 * same mechanism the memory layer already runs, reused rather than duplicated;
 * `resolveSupersedingPersonaMemories()` is the one implementation, called by the
 * distiller (field changed) and by the manual-override path (field typed over).
 */

import type Database from 'better-sqlite3';
import type { Logger } from 'pino';
import type { Memory } from '../repositories/memory-repository.js';
import { PERSONA_MEMORY_ID } from '../persona-store.js';
import type { UserPersona } from '../persona-model.js';
import { truncate } from '../../shared/truncation.js';
import {
  choice,
  defineDecision,
  type DecisionOutcome,
  type DecisionSpec,
} from '../../judge/types.js';
import { currentJudgeEngine } from '../../judge/engine-lookup.js';
import type { JudgeEngine } from '../../judge/engine.js';
import {
  diffPersonaFields,
  memoryMentionsValue,
  type PersonaFieldDiff,
  type PersonaFieldValue,
  type PersonaOutputDiff,
} from './provenance-query.js';

export type PersonaFeedbackEvent =
  'persona.rejected' | 'persona.contradicted' | 'persona.manual_override';

/** Fixed weights (plan §6 K4.2: increasing, manual override highest). */
export const PERSONA_FEEDBACK_WEIGHTS: Record<PersonaFeedbackEvent, number> = {
  'persona.rejected': 1,
  'persona.contradicted': 2,
  'persona.manual_override': 3,
};

// ---------------------------------------------------------------------------
// persona.rejection — the judged channel
// ---------------------------------------------------------------------------

export const PERSONA_REJECTION_POINT_ID = 'persona.rejection';

export const REJECTION_REJECTED = 'rejected';
export const REJECTION_NOT_REJECTED = 'not-rejected';

/** State carried to the judge (bounded; the reply is context, not evidence). */
export const REJECTION_MESSAGE_MAX = 400;
export const REJECTION_ASSISTANT_MAX = 400;

const REJECTION_QUESTION = choice(
  'Is the user rejecting the persona claim the assistant just made about them?',
  {
    [REJECTION_REJECTED]:
      'the user says the claim about their preferences, habits or history is wrong or was never said (不对 / 不是这样 / 我没说过)',
    [REJECTION_NOT_REJECTED]:
      'a correction of one detail, an objection to the task rather than to the persona claim, a question, or plain agreement',
  },
);

function rejectionPolicy(answers: Record<string, unknown>): DecisionOutcome {
  const answer = answers['persona.rejection'] as { type?: string; choice?: string } | undefined;
  if (!answer || answer.type !== 'choice' || typeof answer.choice !== 'string') {
    return { action: 'none' };
  }
  return { action: 'route', choice: answer.choice };
}

/**
 * `persona.rejection` decision spec. Fallback is `{ action: 'none' }`: without a
 * judgment nothing is recorded — recording is the behavior change, so it must
 * only happen on a judged, active verdict.
 */
export const personaRejectionSpec: DecisionSpec = defineDecision({
  id: PERSONA_REJECTION_POINT_ID,
  version: 1,
  questions: { 'persona.rejection': REJECTION_QUESTION },
  buildState: (raw: unknown) => {
    // engine.decide passes the whole DecisionInput — unwrap `state`.
    const call = raw as { state?: unknown } | undefined;
    const input = ((call && typeof call === 'object' && 'state' in call ? call.state : raw) ??
      {}) as { userMessage?: unknown; assistantText?: unknown };
    return {
      userMessage:
        typeof input.userMessage === 'string'
          ? input.userMessage.slice(0, REJECTION_MESSAGE_MAX)
          : '',
      assistantText:
        typeof input.assistantText === 'string'
          ? input.assistantText.slice(0, REJECTION_ASSISTANT_MAX)
          : '',
    };
  },
  policy: rejectionPolicy as DecisionSpec['policy'],
  fallback: { action: 'none' },
});

export interface PersonaRejectionInput {
  /** The user's reply that may be rejecting the persona claim. */
  userMessage: string;
  /** The assistant reply that stated the persona claim (best available context). */
  assistantText?: string;
  sessionId?: string;
  /** Test/integration seam; production resolves the live kernel. */
  engine?: JudgeEngine;
  judgeGet?: () => JudgeEngine | undefined;
}

export interface PersonaRejectionResult {
  /** The judge was asked (mode not 'off' and an engine exists). */
  asked: boolean;
  /** A `persona.rejected` event row was written. */
  recorded: boolean;
}

// ---------------------------------------------------------------------------
// Closing — the shared supersede path
// ---------------------------------------------------------------------------

/** The slice of `MemoryRepository` the closing path needs. */
export interface PersonaMemoryStore {
  findByScopeKind(scope: string, kind: string): Memory[];
  /**
   * Marks `oldId` superseded by `newId` (status + invalidated_at on the old
   * row, supersedes_id on the new one). Absent on read-only/test stubs — the
   * closing step is then skipped instead of failing.
   */
  supersede?(oldId: string, newId: string): boolean;
}

export interface CloseSupersededPersonaMemoriesInput {
  memoryStore: PersonaMemoryStore;
  /** The value the persona no longer holds. */
  from: PersonaFieldValue | undefined;
  /** The value it holds now (memory carriers of it become the successor). */
  to: PersonaFieldValue | undefined;
}

export interface CloseSupersededPersonaMemoriesResult {
  /** Memory ids closed as superseded by this call. */
  closedIds: string[];
  /** The row that now carries the new value (the persona row when none does). */
  successorId: string | null;
}

/**
 * Close the active preference memories that carried `from` but not `to`.
 *
 * Successor: the newest active preference memory that mentions the new value;
 * when the new value has no memory behind it (a WebUI manual override, or a
 * field the LLM reworded), the persona row `__persona__` is the successor —
 * it is a `memories` row and it does carry the value now.
 *
 * Returns `{ closedIds: [] }` when the store cannot supersede (read-only stub).
 */
export function resolveSupersedingPersonaMemories(
  input: CloseSupersededPersonaMemoriesInput,
): CloseSupersededPersonaMemoriesResult {
  const store = input.memoryStore;
  if (!store.supersede) return { closedIds: [], successorId: null };

  const preferences = store.findByScopeKind('user', 'preference');
  const oldCarriers = preferences.filter(
    (memory) =>
      memory.status === 'active' &&
      memoryMentionsValue(memory.content, input.from) &&
      !memoryMentionsValue(memory.content, input.to),
  );
  if (oldCarriers.length === 0) return { closedIds: [], successorId: null };

  const newCarrier = preferences
    .filter((memory) => memory.status === 'active' && memoryMentionsValue(memory.content, input.to))
    .sort((a, b) => parseTimestamp(b.updated_at) - parseTimestamp(a.updated_at))[0];
  const successorId = newCarrier?.id ?? PERSONA_MEMORY_ID;

  const closedIds: string[] = [];
  for (const old of oldCarriers) {
    if (old.id === successorId) continue;
    if (store.supersede(old.id, successorId)) closedIds.push(old.id);
  }
  return { closedIds, successorId };
}

function parseTimestamp(value: string): number {
  if (!value) return 0;
  if (/^\d+$/.test(value)) return Number(value);
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

export interface PersonaManualOverrideInput {
  /** Persona before the edit (null when none was stored yet). */
  before: UserPersona | null;
  /** Persona after the edit. */
  after: UserPersona;
  /** Operator/channel label recorded with the event (default 'webui'). */
  source?: string;
}

export interface PersonaManualOverrideResult {
  /** Fields whose value the edit changed. */
  fields: string[];
  /** Memory ids closed because they carried the replaced value. */
  closedIds: string[];
  /** True when an event row was written (false when the edit changed nothing). */
  recorded: boolean;
}

export interface PersonaContradictionInput {
  /** The new preference memory that conflicts with the persona. */
  memoryId: string;
  /** Its text. */
  content: string;
  /** Persona field it conflicts with, when the caller knows it. */
  field?: string;
  /** The persona value it conflicts with, when the caller knows it. */
  personaValue?: string;
}

export interface PersonaFeedbackOptions {
  logger?: Pick<Logger, 'debug' | 'warn'>;
}

/**
 * Writes persona feedback events and closes contradicted memories.
 *
 * Construct it only while `memory.persona.enabled` is true — every entry point
 * is then inert by construction (no persona, no feedback loop).
 */
export class PersonaFeedback {
  constructor(
    private readonly db: Database.Database,
    private readonly memoryStore: PersonaMemoryStore,
    private readonly options: PersonaFeedbackOptions = {},
  ) {}

  /**
   * Judge a user reply for persona rejection and record `persona.rejected`.
   *
   * Strict no-op (`{ asked: false, recorded: false }`) when the judge kernel is
   * inert or the point mode is `off`; no row is written for a shadow-mode or
   * fallback verdict either — only a judged, active `rejected` choice records.
   */
  async recordRejection(input: PersonaRejectionInput): Promise<PersonaRejectionResult> {
    const engine = input.engine ?? input.judgeGet?.() ?? currentJudgeEngine();
    if (!engine) return { asked: false, recorded: false };
    if (engine.modeFor(PERSONA_REJECTION_POINT_ID) === 'off') {
      return { asked: false, recorded: false };
    }

    const verdict = await engine.decideMany(personaRejectionSpec, {
      state: { userMessage: input.userMessage, assistantText: input.assistantText ?? '' },
      sessionId: input.sessionId,
    });
    if (verdict.source !== 'judge' || verdict.mode !== 'active') {
      return { asked: true, recorded: false };
    }
    if (verdict.outcome.action !== 'route' || verdict.outcome.choice !== REJECTION_REJECTED) {
      return { asked: true, recorded: false };
    }

    const recorded = this.insert('persona.rejected', {
      sessionId: input.sessionId ?? null,
      message: truncate(input.userMessage, 200),
      judgeId: verdict.judgeId,
    });
    return { asked: true, recorded };
  }

  /**
   * Record a WebUI persona edit and close the memories that carried the values
   * the edit replaced.
   */
  recordManualOverride(input: PersonaManualOverrideInput): PersonaManualOverrideResult {
    const diff: PersonaOutputDiff = diffPersonaFields(input.before, input.after);
    const fields = Object.keys(diff);
    if (fields.length === 0) return { fields, closedIds: [], recorded: false };

    const closedIds: string[] = [];
    for (const field of fields) {
      const change: PersonaFieldDiff = diff[field];
      closedIds.push(
        ...resolveSupersedingPersonaMemories({
          memoryStore: this.memoryStore,
          from: change.from,
          to: change.to,
        }).closedIds,
      );
    }

    const recorded = this.insert('persona.manual_override', {
      source: input.source ?? 'webui',
      fields,
      diff,
      closedMemoryIds: closedIds,
    });
    return { fields, closedIds, recorded };
  }

  /**
   * Record that a new preference memory conflicts with the persona. The
   * supersede itself already ran in the memory write path (`PreferenceConflict
   * Resolver`); this is the observation the operator/WebUI needs to see that
   * the persona is now behind reality.
   */
  recordContradiction(input: PersonaContradictionInput): boolean {
    return this.insert('persona.contradicted', {
      memoryId: input.memoryId,
      field: input.field ?? null,
      personaValue: input.personaValue ?? null,
      content: truncate(input.content, 200),
    });
  }

  private insert(event: PersonaFeedbackEvent, details: Record<string, unknown>): boolean {
    const payload = JSON.stringify({ ...details, weight: PERSONA_FEEDBACK_WEIGHTS[event] });
    try {
      this.db
        .prepare('INSERT INTO memory_observation_events (event, details) VALUES (?, ?)')
        .run(event, payload);
      return true;
    } catch (err) {
      // Feedback must never break the chat/persona path it is observing.
      this.options.logger?.warn({ err, event }, 'Failed to record persona feedback event');
      return false;
    }
  }
}
