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
 *
 * Revision F2 (post-implementation review): the noun/verb list was too narrow to
 * cover how identity is actually stated. `用户的名字是张伟`, `用户的时区是 UTC+8`,
 * `用户使用 Windows 11`, `用户正在学习 Rust` and `用户希望被称为 Boss` all failed it and
 * were discarded — and the summarizer window is incremental, so a discarded
 * attribute never comes back. The list now names attribute *slots* (名字/姓名/身份/
 * 职业/时区/语言/…) as well as attributes proper (使用/学习/拥有/住在/有/被称为), which
 * keeps the narration shapes rejected (`用户问过…`, `用户进行了…`, `用户当前处理的
 * 项目根目录包含…`) while admitting the copular and possessive forms.
 *
 * The bias is deliberate and matches `durability.ts`: a false rejection costs a
 * real preference forever, a false pass costs one row that hygiene recycles.
 * Narrative events are handled by the durability gate, not by narrowing this one.
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
  /(偏好|习惯|喜欢|要求|称呼|被称为|叫做|名字|姓名|身份|职业|职位|角色|时区|语言|使用|常用|学习|掌握|拥有|从事|居住|住在|有|prefers|likes|wants|uses|is|has|works|lives|speaks|needs|owns|knows|reads|writes)/i;

/** True when the candidate is shaped like a durable attribute, not session narration. */
export function isDurableShape(s: string): boolean {
  const value = s ?? '';
  if (FIRST_PERSON.test(value)) return true;
  if (!THIRD_PERSON.test(value)) return true;
  return ATTRIBUTE_VERB.test(value.replace(THIRD_PERSON, ''));
}
