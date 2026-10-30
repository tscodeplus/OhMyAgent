/**
 * Deterministic durability check for memory candidates (plan §3.3).
 *
 * A memory candidate is only worth keeping when it is an attribute of the
 * user/agent/project that still holds in another session and cannot be rebuilt
 * from L0 with one `session_search`. Some candidates fail that test in a way a
 * regex can *prove*: a cached directory listing, a narrative of a past event, or
 * this task's output format. Those are the only ones this module rejects.
 *
 * Negative list only — there is no positive scorer here. Every rule below is a
 * refutable pattern: it names a shape that CANNOT be a long-term attribute, and
 * anything it does not match is `unknown` (pass through). The asymmetry is
 * deliberate, because the two errors do not cost the same: a false rejection
 * loses a real preference forever (the summarizer window is incremental — the
 * message is not replayed), while a false pass just leaves one more row for
 * hygiene and the worth gate to look at. So only enumerable patterns may be
 * rejected, and the list must stay short enough to keep that true.
 *
 * The list is bilingual on purpose: `memory.output_language: Auto` follows the
 * conversation language, so candidates come back in whatever language the chat
 * used — a Chinese-only list would not filter an English session at all.
 */

export type Durability = 'durable' | 'volatile' | 'unknown';

/**
 * Count/enumeration of a path or directory — a cached `ls`, with no cache
 * invalidation behind it. Bilingual: `there are 4 files under E:\Excel`.
 */
const ENUMERATION_CN = /目录下当前有|\d+\s*个文件|共\s*\d+\s*条/;
const ENUMERATION_EN = /\b\d+\s+files?\b.*\b(?:in|under|at)\b/i;

/** A concrete calendar date and an event that already happened (narrative). */
const CONCRETE_DATE = /\d{4}-\d{2}-\d{2}/;
const PAST_EVENT = /问过|说过|助手|回复|asked|said|assistant/i;

/**
 * This task's output requirement. Two notes on the shape:
 *
 * 1. A `本次/这个/以上` qualifier is NOT required. The motivating case
 *    ("用户要求回复控制在20词以内") has none, and a candidate that carries 回复 also
 *    matches `detectTopic() === 'communication_style'`, which keeps it as a
 *    `preference` — i.e. permanent. Requiring the qualifier would make it the
 *    one candidate of the four that lives forever.
 * 2. A numeric quantity IS required. An earlier revision matched `输出|格式` on
 *    its own, which rejected durable preferences phrased around output
 *    ("用中文输出", "用 Markdown 格式输出"). A false rejection is unrecoverable
 *    and a false pass only costs one row, so the pattern stays on the side that
 *    can be proven: a length budget is a task spec, a format name is a habit.
 */
const TASK_OUTPUT_CN = /控制在?\s*\d+\s*(?:词|字)|\d+\s*(?:词|字)(?:以内|内)/;
/**
 * English output budget. The verb list is wider than the Chinese one because
 * English states the same requirement with `keep`/`limit`/`write` far more often
 * than with `output`/`format` — the motivating row this rule exists for is
 * literally `User prefers concise, short replies — keep responses under 20
 * words.`, which the narrower `/output|format|reply|respond|answer/` version
 * classified as `unknown`.
 *
 * The trailing alternation covers the postfix form (`20 words max`, `20 words
 * under`), which is the other half of the same miss: `under` was not in the
 * quantifier list, so `keep responses under 20 words` failed on both branches.
 */
const TASK_OUTPUT_EN =
  /(?:output|format|repl(?:y|ies)|responses?|answers?|keep|write|limit)[^.]{0,40}\b\d+\s+(?:words?|characters?|chars?)\b|\b\d+\s+(?:words?|characters?|chars?)\b[^.]{0,20}\b(?:max|maximum|or less|limit|under|below|within)\b/i;

/**
 * Classify how long a candidate can stay true.
 *
 * `volatile` MUST NOT be persisted; `durable` and `unknown` continue down the
 * pipeline. `durable` is never returned today — it is the slot a positive
 * scorer would fill, and the plan deliberately has none.
 */
export function assessDurability(text: string): Durability {
  const value = text ?? '';
  if (ENUMERATION_CN.test(value) || ENUMERATION_EN.test(value)) return 'volatile';
  if (CONCRETE_DATE.test(value) && PAST_EVENT.test(value)) return 'volatile';
  if (TASK_OUTPUT_CN.test(value) || TASK_OUTPUT_EN.test(value)) return 'volatile';
  return 'unknown';
}
