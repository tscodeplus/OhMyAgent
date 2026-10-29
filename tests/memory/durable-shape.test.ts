/**
 * `isDurableShape` — the narration gate (plan §3.2, revision A2).
 *
 * It answers exactly one question: did the user say this in their own words, or
 * is it the model narrating the session it just read? Anything that is not
 * third-person narration passes, so a real preference phrased without a subject
 * is never lost here.
 */
import { describe, it, expect } from 'vitest';
import { isDurableShape } from '../../src/memory/write/durable-shape.js';
import { assessDurability } from '../../src/memory/write/durability.js';

/** What the summarizer actually applies: shape first, then durability. */
function passesDeterministicGates(text: string): boolean {
  return isDurableShape(text) && assessDurability(text) !== 'volatile';
}

describe('isDurableShape', () => {
  it('keeps a third-person sentence that states an attribute', () => {
    expect(isDurableShape('用户偏好简洁回复')).toBe(true);
    expect(isDurableShape('User prefers pnpm')).toBe(true);
    expect(isDurableShape('用户希望被称呼为"老板"')).toBe(true);
  });

  it('drops third-person narration of an event', () => {
    expect(
      isDurableShape(
        '用户问过"现在是白天还是晚上"（2026-10-08）。助手因无法获取当前时间而无法判断，已告知用户。',
      ),
    ).toBe(false);
  });

  it('keeps first-person statements (no \\b on the CJK branch — revision A2)', () => {
    // `/我\b/` never matches 「我在用」 (JS `\w` is ASCII-only), which was the
    // bug that discarded every Chinese candidate in an earlier draft.
    expect(isDurableShape('我在用 pnpm')).toBe(true);
    expect(isDurableShape('I prefer pnpm')).toBe(true);
  });

  it('keeps statements with no subject at all', () => {
    expect(isDurableShape('叫我 Boss')).toBe(true);
    expect(isDurableShape('用 pnpm 不用 npm')).toBe(true);
    expect(isDurableShape('回复简洁点')).toBe(true);
  });

  it("passes a listing-shaped string — that is the durability gate's job", () => {
    // §5's table lists 「E:\Excel 目录下当前有 4 个 Excel 文件」 as dropped, but the
    // shape gate is fail-open by design (it only rejects narration), so the drop
    // happens one step later. Asserted together below.
    expect(isDurableShape('E:\\Excel 目录下当前有 4 个 Excel 文件')).toBe(true);
  });
});

describe('deterministic gates combined (what the parser applies)', () => {
  it('keeps durable candidates', () => {
    expect(passesDeterministicGates('用户偏好简洁回复')).toBe(true);
    expect(passesDeterministicGates('User prefers pnpm')).toBe(true);
  });

  it('drops narration and listings', () => {
    expect(passesDeterministicGates('E:\\Excel 目录下当前有 4 个 Excel 文件')).toBe(false);
    expect(
      passesDeterministicGates(
        '用户问过"现在是白天还是晚上"（2026-10-08）。助手因无法获取当前时间而无法判断，已告知用户。',
      ),
    ).toBe(false);
  });

  it("drops this task's output requirement", () => {
    expect(passesDeterministicGates('用户要求回复控制在20词以内')).toBe(false);
  });
});
