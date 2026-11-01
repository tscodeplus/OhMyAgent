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
 * These live here, next to the output numbers, because the same schema and the same
 * comments read both: an input window too narrow silently loses the *beginning* of a
 * conversation, an output budget too small cuts the JSON mid-object.
 *
 * There is deliberately **no token budget** for the window. It was the constraint that
 * actually bound while `turns` rarely did, and every value it could take was wrong in a
 * way nobody could see: too small turned "this conversation" into its last two
 * exchanges, 16k never fired (real captures estimated 405–774 tokens), and for a model
 * with a 1M-token window it was off by two orders of magnitude. A model's capacity is
 * the model's business; what we read is either the session or a character count the
 * user typed.
 */

/** `recent` default, used only when a caller asks for `recent` without a turn count. */
export const WINDOW_TURNS_DEFAULT = 5;

/**
 * Request-boundary clamp on `turns`. The value arrives over HTTP, and a caller asking
 * for a thousand turns would load the whole table into a prompt.
 */
export const WINDOW_TURNS_MAX = 20;

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
