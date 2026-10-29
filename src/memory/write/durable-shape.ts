/**
 * Deterministic shape gate for memory candidates (plan §3.2, revision A2).
 *
 * The summarizer prompt asks for "durable user attributes", and the model still
 * returns half-sentences: third-person narration of the session it just read
 * ("用户问过…已告知用户"). A regex cannot judge what is a preference, but it can
 * tell the user's own words from the model's narration of them, and that is all
 * this gate claims to do.
 *
 * Two rules, deliberately unequal:
 *   1. first person (「我…」/「I …」) — the user said it → always pass;
 *   2. not third person (「用户」/`User`) — not narration-shaped → always pass;
 *   3. third person → pass only with an attribute verb in the remainder.
 *
 * Third person is the only rejectable shape, so a real preference phrased
 * without a subject ("pnpm 比 npm 快") is never lost here.
 */

/**
 * No `\b` on the CJK branch: JS `\w` is ASCII-only, so 我/用 are both non-word
 * and there is no boundary between them — `/我\b/` never matches 「我在用」, and
 * an earlier draft of this gate discarded every Chinese candidate (revision A2).
 */
const FIRST_PERSON = /^\s*(?:我|I\b)/;

const THIRD_PERSON = /^(?:用户|User)\s*/;

/** What a third-person sentence must be *about* to be an attribute, not an event. */
const ATTRIBUTE_VERB =
  /(偏好|习惯|喜欢|要求|称呼|希望被称呼|常用|prefers|likes|wants|uses|is|works)/i;

/** True when the candidate is shaped like a durable attribute, not session narration. */
export function isDurableShape(s: string): boolean {
  const value = s ?? '';
  if (FIRST_PERSON.test(value)) return true;
  if (!THIRD_PERSON.test(value)) return true;
  return ATTRIBUTE_VERB.test(value.replace(THIRD_PERSON, ''));
}
