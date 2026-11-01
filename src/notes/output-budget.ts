/**
 * Sizing rules for one distillation call, shared by the validator, the prompt and
 * the config schema so the three cannot disagree.
 *
 * The body cap is the number a person edits (`notes.capture.bodyMaxChars`); the
 * output-token budget is **derived** from it rather than configured separately,
 * because the only way a token budget can be wrong is "too small", and the way it
 * fails is not "shorter notes" but a JSON object cut in half — which the parser
 * reports as `invalid_json` and the log then blames on the model.
 *
 * One CJK character is roughly one token, so `bodyMaxChars` is a token estimate and
 * `OVERHEAD_TOKENS` covers the surrounding object (title, summary, fields, tags,
 * evidence) plus the model's own preamble.
 */

/** Default body cap: room for a note holding two aspects of one subject. */
export const BODY_MAX_DEFAULT = 1200;

/** Below this a note cannot hold a command and its caveat; the UI enforces it too. */
export const BODY_MAX_MIN = 200;

/** Past this a "note" is a document, and the review queue stops being readable. */
export const BODY_MAX_MAX = 4000;

/** Envelope around the bodies of one response. */
const OVERHEAD_TOKENS = 400;

/** Below this the request is suspicious for any model, so the floor is not configurable. */
const MIN_OUTPUT_TOKENS = 1200;

/**
 * Above this most flash models refuse the request outright, which would turn a
 * config mistake into a `model_failed` capture rather than a short note.
 */
const MAX_OUTPUT_TOKENS = 8000;

/** Upper bound on drafts per capture, when the config does not say otherwise. */
export const MAX_NOTES_DEFAULT = 3;

/**
 * How much conversation a capture reads, when the config does not say otherwise.
 *
 * These live here, next to the output numbers, because the two budgets are read by
 * the same schema and the same comments: an input budget too small silently loses the
 * *beginning* of a conversation, an output budget too small cuts the JSON.
 */

/** `recent` default: the exchange the user just finished, plus context. */
export const WINDOW_TURNS_DEFAULT = 5;

/**
 * Request-boundary clamp on `turns`. The value arrives over HTTP, and a caller asking
 * for a thousand turns would load the whole table into a prompt.
 */
export const WINDOW_TURNS_MAX = 20;

/**
 * Default input budget, in estimated tokens (~16k Chinese characters, ~64k Latin).
 *
 * It was 4000, which is fine for five turns and *below* a real session: a coding
 * conversation's assistant prose runs 800–2000 tokens per message, so 4000 silently
 * reduced "this conversation" to its last two or three exchanges. The budget is the
 * constraint that actually binds (`turns` rarely does), so it is the one worth raising.
 */
export const WINDOW_TOKEN_DEFAULT = 16000;

/**
 * Hard cap on rows read for a `session` capture. Ten times the default token budget,
 * so the budget trims before the loader does and the truncation is counted rather
 * than silent.
 */
export const WINDOW_MESSAGES_MAX = 400;

/**
 * Output budget for one call: every note may use the whole body cap, plus the
 * response envelope, clamped to a range models actually accept.
 */
export function deriveMaxOutputTokens(bodyMaxChars: number, maxNotes: number): number {
  const bodies = Math.max(1, maxNotes) * Math.max(1, bodyMaxChars);
  return Math.min(MAX_OUTPUT_TOKENS, Math.max(MIN_OUTPUT_TOKENS, bodies + OVERHEAD_TOKENS));
}
