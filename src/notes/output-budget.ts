/**
 * Sizing rules for one distillation call, shared by the validator, the prompt and
 * the config schema so the three cannot disagree.
 *
 * The body cap is the number a person edits (`notes.capture.bodyMaxChars`), and it
 * works in the two places a cap can work: the prompt states it, and the validator
 * rejects a body that exceeds it (`too_long`, per note, so it never costs the whole
 * capture). Neither of those truncates anything — they ask for a shorter note and
 * say so.
 *
 * There is deliberately **no derived output-token budget**. It used to be
 * `bodyMaxChars x maxNotes + 400`, and it was arithmetic pretending to be a
 * measurement: one CJK character is roughly one token, but the response is not only
 * bodies (title, summary, fields, tags, evidence), the model's preamble is not
 * zero, and a reasoning model spends from the *same* `max_tokens` pool before it
 * writes a character. So the number was wrong in an unpredictable direction, and
 * the failure it produced — a JSON object cut mid-object — is reported by the parser
 * as `invalid_json`, i.e. blamed on the model. Omitting `max_tokens` hands the
 * decision to the gateway, which at least knows the model; `finish_reason: 'length'`
 * then makes a truncation visible instead of silent.
 */

/** Default body cap: room for a note holding two aspects of one subject. */
export const BODY_MAX_DEFAULT = 1200;

/** Below this a note cannot hold a command and its caveat; the UI enforces it too. */
export const BODY_MAX_MIN = 200;

/** Past this a "note" is a document, and the review queue stops being readable. */
export const BODY_MAX_MAX = 4000;

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
