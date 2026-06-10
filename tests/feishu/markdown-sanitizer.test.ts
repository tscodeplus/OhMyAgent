import { describe, it, expect } from 'vitest';
import { fixFeishuBold } from '../../extensions/channel-feishu/render/markdown-sanitizer.js';

const ZWSP = '​';

describe('fixFeishuBold', () => {
  it('keeps Latin-only bold unchanged', () => {
    expect(fixFeishuBold('**hello**')).toBe('**hello**');
  });

  it('keeps ** with spaces inside unchanged (already sanitized)', () => {
    expect(fixFeishuBold(`**${ZWSP}text${ZWSP}**`)).toBe(`**${ZWSP}text${ZWSP}**`);
  });

  it('adds ZWSP between ** and Chinese quotes', () => {
    const input = '**“找得到”**';
    const expected = `**${ZWSP}“找得到”${ZWSP}**`;
    expect(fixFeishuBold(input)).toBe(expected);
  });

  it('adds ZWSP between ** and corner brackets', () => {
    const input = '**「求搭子」网站**';
    const expected = `**${ZWSP}「求搭子」网站${ZWSP}**`;
    expect(fixFeishuBold(input)).toBe(expected);
  });

  it('adds ZWSP between ** and fullwidth parentheses', () => {
    const input = '**明天（5月18日·周一）**';
    const expected = `**${ZWSP}明天（5月18日·周一）${ZWSP}**`;
    expect(fixFeishuBold(input)).toBe(expected);
  });

  it('handles multiple bold spans in one text', () => {
    const input = '**hello** and **“world”**';
    const expected = `**hello** and **${ZWSP}“world”${ZWSP}**`;
    expect(fixFeishuBold(input)).toBe(expected);
  });

  it('handles mixed CJK and Latin boundary (CJK start, Latin end)', () => {
    const input = '**明天hello**';
    const expected = `**${ZWSP}明天hello**`; // start is CJK, end is Latin
    expect(fixFeishuBold(input)).toBe(expected);
  });

  it('handles mixed Latin and CJK boundary (Latin start, CJK end)', () => {
    const input = '**hello明天**';
    const expected = `**hello明天${ZWSP}**`; // start is Latin, end is CJK
    expect(fixFeishuBold(input)).toBe(expected);
  });

  it('does not modify text without bold markers', () => {
    expect(fixFeishuBold('plain text')).toBe('plain text');
  });

  it('is idempotent', () => {
    const input = '**“text”**';
    const first = fixFeishuBold(input);
    const second = fixFeishuBold(first);
    expect(second).toBe(first);
  });
});
