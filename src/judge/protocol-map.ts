/**
 * Wire protocol mapping: OhMyAgent question/answer shapes ↔ pi-mono
 * ClassifierQuestion/ClassifierAnswer (src/pi-mono/ai/types.ts), plus the
 * fail-closed answer validation the engine runs before anything touches
 * behavior (plan §7.5 — never silently normalize into "plausible" answers).
 */

import type {
  ClassifierAnswer,
  ClassifierApi,
  ClassifierContext,
  ClassifierModel,
  ClassifierOptions,
  ClassifierQuestion,
  ClassifierResult,
} from '@earendil-works/pi-ai';
import { classifySystemOne, type SystemOneTransport } from '../pi-mono/ai/api/system-one-shared.js';
import { isRecord } from '../pi-mono/ai/api/classifier-shared.js';
import type {
  ChoiceQ,
  JudgeAnswer,
  JudgeEntryConfig,
  JudgeQuestion,
  NoulQ,
  ScoreQ,
} from './types.js';

// ─── Custom relay judges (plan §8.1 `judge.judges`, milestone M5) ──────────

/** Default System One model id a relay judge is assumed to serve (entry `model` overrides). */
export const CUSTOM_JUDGE_DEFAULT_MODEL = 'jev-latest';

/** Classifier api id tagged onto custom `http`-type judge results (open ClassifierApi union). */
export const SYSTEM_ONE_HTTP_API = 'system-one-http';

/**
 * Wire transports for the two custom-judge protocols (plan §8.1 `judges` entries):
 * - `typesafe`: the typesafe-system-one envelope — POST `<baseUrl>/systemone` with
 *   `{ model, state, questions }` (the exact wire OpenCode/OpenRouter serve);
 * - `http`: the plain System One wire — POST `baseUrl` verbatim with
 *   `{ state, questions }`, expecting `{ answers, usage }` back.
 * Both share classifySystemOne's fail-closed answer parsing and never reject.
 */
export function customJudgeTransport(type: JudgeEntryConfig['type']): SystemOneTransport {
  if (type === 'typesafe') {
    return {
      api: 'typesafe-system-one',
      label: 'Custom typesafe relay',
      url: (model) => new URL('systemone', `${model.baseUrl.replace(/\/+$/u, '')}/`),
      payload: (model, request) => ({ model: model.id, ...request }),
      output: (body) => {
        if (!isRecord(body))
          throw new Error('Custom typesafe relay returned an unexpected response');
        return body;
      },
    };
  }
  return {
    api: SYSTEM_ONE_HTTP_API,
    label: 'System One HTTP relay',
    url: (model) => new URL(model.baseUrl),
    payload: (_model, request) => request,
    output: (body) => {
      if (!isRecord(body)) throw new Error('System One HTTP relay returned an unexpected response');
      return body;
    },
  };
}

/** The synthetic classifier model entry a custom judge tier classifies against. */
export function customJudgeModel(entry: JudgeEntryConfig): ClassifierModel<ClassifierApi> {
  return {
    type: 'classifier',
    id: entry.model || CUSTOM_JUDGE_DEFAULT_MODEL,
    name: `Custom judge (${entry.type})`,
    api: customJudgeTransport(entry.type).api,
    provider: 'custom-judge',
    baseUrl: entry.baseUrl ?? '',
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32000,
  };
}

/**
 * Classify through a custom relay judge entry (JudgeResolver builds the tier).
 * `options.apiKey` must already be resolved from the entry's `apiKeyEnv`;
 * classifySystemOne turns a missing key into a `stopReason: "error"` result.
 */
export function classifyCustomJudge(
  entry: JudgeEntryConfig,
  context: ClassifierContext,
  options: ClassifierOptions | undefined,
): Promise<ClassifierResult> {
  return classifySystemOne(
    customJudgeTransport(entry.type),
    customJudgeModel(entry),
    context,
    options,
  );
}

/**
 * OhMyAgent question → pi-mono ClassifierQuestion.
 *
 * - `noul` maps to wire type `bool` (system-one calls the public type `noul`);
 *   when the builder received no criteria, the criteria FIELD IS OMITTED —
 *   never an empty object (system-one-shared spreads the question as-is).
 * - `choice` criteria with `null` description → empty string description.
 */
export function toClassifierQuestion(question: JudgeQuestion): ClassifierQuestion {
  switch (question.type) {
    case 'noul': {
      // Wire shape: public `bool` → TypeSafe noul (system-one-shared spreads
      // the question as-is, so omitting criteria here omits it on the wire).
      const base: {
        type: 'bool';
        instructions: string;
        criteria?: { true: string; false: string };
      } = {
        type: 'bool',
        instructions: question.instructions,
        ...(question.criteria
          ? { criteria: { true: question.criteria.true, false: question.criteria.false } }
          : {}),
      };
      return base as ClassifierQuestion;
    }
    case 'choice': {
      const criteria: Record<string, string> = {};
      for (const [key, description] of Object.entries(question.criteria)) {
        criteria[key] = description ?? '';
      }
      return { type: 'choice', instructions: question.instructions, criteria };
    }
    case 'score':
      return { type: 'score', instructions: question.instructions, criteria: question.criteria };
  }
}

export function toClassifierQuestions(
  questions: Record<string, JudgeQuestion>,
): Record<string, ClassifierQuestion> {
  const out: Record<string, ClassifierQuestion> = {};
  for (const [id, question] of Object.entries(questions)) {
    out[id] = toClassifierQuestion(question);
  }
  return out;
}

/**
 * pi-mono ClassifierAnswer → JudgeAnswer, fail-closed.
 * Returns `undefined` for anything that does not match its question exactly:
 * missing fields, wrong shapes, choice keys outside the question criteria —
 * discarded, never coerced.
 */
export function toJudgeAnswer(
  question: JudgeQuestion,
  answer: ClassifierAnswer | undefined,
): JudgeAnswer | undefined {
  if (!answer) return undefined;
  switch (question.type) {
    case 'noul': {
      if (answer.type !== 'bool') return undefined;
      const p = answer.probability;
      return typeof p === 'number' && Number.isFinite(p)
        ? { type: 'noul', probability: p }
        : undefined;
    }
    case 'choice': {
      if (answer.type !== 'choice') return undefined;
      if (typeof answer.choice !== 'string') return undefined;
      if (!(answer.choice in question.criteria)) return undefined;
      const probabilities: Record<string, number> = {};
      for (const [key, probability] of Object.entries(answer.probabilities ?? {})) {
        if (
          key in question.criteria &&
          typeof probability === 'number' &&
          Number.isFinite(probability)
        ) {
          probabilities[key] = probability;
        }
      }
      const conf = answer.confidence;
      const confidence = typeof conf === 'number' && Number.isFinite(conf) ? conf : undefined;
      if (confidence === undefined) return undefined;
      return { type: 'choice', choice: answer.choice, probabilities, confidence };
    }
    case 'score': {
      if (answer.type !== 'score') return undefined;
      const s = answer.score;
      const conf = answer.confidence;
      if (typeof s !== 'number' || !Number.isFinite(s)) return undefined;
      if (typeof conf !== 'number' || !Number.isFinite(conf)) return undefined;
      return { type: 'score', score: s, confidence: conf };
    }
  }
}

/**
 * Gray-zone detection (cascade escalation trigger, impl doc §3.1 step 6):
 * - noul: probability in the open interval (0.25, 0.75);
 * - choice: confidence < 0.5 (choice is a relative judgment — its confidence is the margin);
 * - score: gray unless confidence >= 0.5.
 */
export function isGrayAnswer(question: JudgeQuestion, answer: JudgeAnswer): boolean {
  // Answer and question types are validated together in validateAnswers(),
  // so the answer discriminant is authoritative here.
  switch (answer.type) {
    case 'noul':
      return answer.probability > 0.25 && answer.probability < 0.75;
    case 'choice':
      return answer.confidence < 0.5;
    case 'score':
      return answer.confidence < 0.5;
  }
}

/** Validate a whole result against a question map. Returns the valid answers and whether any is gray. */
export function validateAnswers(
  questions: Record<string, JudgeQuestion>,
  answers: Record<string, ClassifierAnswer | undefined>,
): { valid: Record<string, JudgeAnswer>; anyGray: boolean } {
  const valid: Record<string, JudgeAnswer> = {};
  let anyGray = false;
  for (const [id, question] of Object.entries(questions)) {
    const answer = toJudgeAnswer(question, answers[id]);
    if (answer === undefined) continue;
    valid[id] = answer;
    if (isGrayAnswer(question, answer)) anyGray = true;
  }
  return { valid, anyGray };
}
