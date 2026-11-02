/**
 * The two text rules the notes layer shares, pinned where they are defined.
 *
 * Both of these used to exist twice with different answers, and the difference was
 * invisible: the capture ledger and the window priced the same conversation two ways,
 * and a title and a summary fell back to different values when the material held no
 * line of its own. So the assertions here are mostly about *agreement* — one estimate
 * for both callers, one fallback for both callers — not about the arithmetic, which is
 * a deliberate guess either way.
 */

import { describe, it, expect } from 'vitest';
import { estimateTokens, firstMeaningfulLine } from '../../src/notes/text.js';
import { estimateTokens as windowEstimateTokens } from '../../src/notes/window.js';

describe('notes token estimate', () => {
  it('prices CJK at ~2 chars/token and latin at ~4', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('中文四字')).toBe(2);
  });

  it('counts every CJK range either former copy knew, not just one', () => {
    // The union: CJK punctuation and fullwidth forms (`window.ts` knew these),
    // Hangul syllables (`capture.ts` knew these), kana and ideographs (both).
    // Each pair is charged as CJK, i.e. one token, where a latin-only reading
    // would have called four fullwidth characters one token's worth of text.
    expect(estimateTokens('，。、')).toBe(2);
    expect(estimateTokens('한국어')).toBe(2);
    expect(estimateTokens('カナ')).toBe(1);
    expect(estimateTokens('ＡＢ')).toBe(1);
    expect(estimateTokens('ｱｲ')).toBe(1);
    expect(estimateTokens('豈更')).toBe(1);
    // An emoji is outside every CJK range: it is priced as latin, as it always was.
    expect(estimateTokens('\u{1F600}')).toBe(1);
  });

  it('is the same function the window uses, not a second copy of it', () => {
    // The whole point of `text.ts`: `token_est` on the capture ledger and `tokenEst`
    // on the resolved window are two readings of one number. If someone reintroduces
    // a local estimate, this comparison is what fails.
    const sample = 'npx vitest run tests/notes，然后再跑全量的한국어 ＡＢ';
    expect(windowEstimateTokens(sample)).toBe(estimateTokens(sample));
  });
});

describe('firstMeaningfulLine', () => {
  it('takes the first line with words, skipping markdown furniture and blanks', () => {
    expect(firstMeaningfulLine('## 端口占用排查\n\n正文')).toBe('端口占用排查');
    expect(firstMeaningfulLine('\n\n> 引用的一行\n第二行')).toBe('引用的一行');
    expect(firstMeaningfulLine('  plain  ')).toBe('plain');
  });

  it('answers with the shared fallback when no line holds words', () => {
    // `###`, `---` and `>` are the shapes a dropped divider or fence takes; the
    // default answer is nothing, so the title and the summary agree on what a
    // wordless line means instead of inventing a placeholder name.
    expect(firstMeaningfulLine('###\n\n---\n>')).toBe('');
    expect(firstMeaningfulLine('')).toBe('');
    // An explicit fallback is still honoured — it is the caller's decision to make.
    expect(firstMeaningfulLine('---', 'no words')).toBe('no words');
  });

  it('does not cap the line: the title and the summary cap it differently', () => {
    // A shared cap here would have to be the smaller of the two (60 for a title,
    // 120 for a summary), so the caller slices. 100 characters survive intact.
    const line = '一'.repeat(100);
    expect(firstMeaningfulLine(line)).toBe(line);
  });
});
