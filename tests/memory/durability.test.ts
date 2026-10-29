/**
 * `assessDurability` — the deterministic negative list (plan §3.3).
 *
 * The four samples in §1 are the acceptance cases; the anti-false-rejection
 * cases below are just as much part of the contract, because dropping a real
 * preference is unrecoverable (the summarizer window is incremental).
 */
import { describe, it, expect } from 'vitest';
import { assessDurability } from '../../src/memory/write/durability.js';

describe('assessDurability: volatile patterns', () => {
  it('rejects a directory listing with a count (CN)', () => {
    expect(assessDurability('E:\\Excel 目录下当前有 4 个 Excel 文件。')).toBe('volatile');
  });

  it('rejects a directory listing with a count (EN)', () => {
    expect(assessDurability('there are 4 files under E:\\Excel')).toBe('volatile');
  });

  it('rejects an enumeration without a directory path (CN)', () => {
    expect(assessDurability('共 12 条待办事项')).toBe('volatile');
  });

  it('rejects a past event pinned to a concrete date', () => {
    expect(
      assessDurability(
        '用户问过"现在是白天还是晚上"（2026-10-08）。助手因无法获取当前时间而无法判断，已告知用户。',
      ),
    ).toBe('volatile');
  });

  it("rejects this task's output requirement (no 本次/以上 qualifier)", () => {
    // Revision A4: the qualifier MUST NOT be required — the sample has none, and
    // it is the one candidate of the four that stays `preference` forever.
    expect(assessDurability('用户要求回复控制在20词以内')).toBe('volatile');
  });

  it('rejects an output requirement that carries a length budget', () => {
    expect(assessDurability('用户希望输出表头三列，正文控制在 30 字以内')).toBe('volatile');
    expect(assessDurability('AS 回复都要在 15 字内')).toBe('volatile');
  });

  it('rejects an output requirement in English', () => {
    expect(assessDurability('Format the output as a table of 50 words')).toBe('volatile');
  });
});

describe('assessDurability: anti-false-rejection cases', () => {
  it.each([
    ['叫我 Boss'],
    ['用 pnpm 不用 npm'],
    ['回复简洁点'],
    ['我在用 pnpm'],
    ['pnpm 比 npm 快'],
    // A format name is a habit, not a task spec. An earlier revision matched
    // `输出|格式` alone and dropped these forever.
    ['用中文输出'],
    ['用 Markdown 格式输出'],
    ['Always answer in Chinese'],
    // Caught by §3.1's kind rule (generic → `fact`, reclaimed by hygiene at 90
    // days) rather than by this gate — a task spec that is not permanent anyway.
    ['用户希望输出文件名、Sheet 数、行数和列数。'],
  ])('keeps a real preference: %s', (text) => {
    expect(assessDurability(text)).toBe('unknown');
  });

  it('keeps a genuine long-term preference that mentions a tool count', () => {
    expect(assessDurability('用户偏好使用 pnpm 作为包管理器')).toBe('unknown');
  });
});

describe('assessDurability: durable is never produced by the negative list', () => {
  it('returns unknown for a plainly durable attribute', () => {
    // The negative list has no positive scorer, so `durable` is unreachable —
    // `unknown` means "not provably transient", which is all this gate claims.
    expect(assessDurability('用户希望被称呼为"老板"')).toBe('unknown');
  });
});
