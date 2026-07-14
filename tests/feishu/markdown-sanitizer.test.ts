import { describe, it, expect } from 'vitest';
import { fixFeishuBold, fixFeishuMarkdown } from '../../extensions/channel-feishu/render/markdown-sanitizer.js';

const ZWSP = '​';

// Shorthand: marker with inner and outer CJK content
function boldInner(c: string) { return `**${ZWSP}${c}${ZWSP}**`; }
function italicInner(c: string) { return `*${ZWSP}${c}${ZWSP}*`; }
function strikeInner(c: string) { return `~~${ZWSP}${c}${ZWSP}~~`; }

describe('fixFeishuMarkdown', () => {
  // ─── Bold (**) ───

  it('keeps Latin-only bold unchanged', () => {
    expect(fixFeishuMarkdown('**hello**')).toBe('**hello**');
  });

  it('keeps ** with spaces inside unchanged (already sanitized)', () => {
    expect(fixFeishuMarkdown(`**${ZWSP}text${ZWSP}**`)).toBe(`**${ZWSP}text${ZWSP}**`);
  });

  it('adds ZWSP between ** and Chinese quotes (inner only, Latin outer)', () => {
    const input = '**"找得到"**';
    const expected = `**${ZWSP}"找得到"${ZWSP}**`;
    expect(fixFeishuMarkdown(input)).toBe(expected);
  });

  it('handles multiple bold spans in one text', () => {
    const input = '**hello** and **"world"**';
    const expected = `**hello** and **${ZWSP}"world"${ZWSP}**`;
    expect(fixFeishuMarkdown(input)).toBe(expected);
  });

  it('handles mixed CJK and Latin boundary (CJK start, Latin end)', () => {
    const input = '**明天hello**';
    const expected = `**${ZWSP}明天hello**`;
    expect(fixFeishuMarkdown(input)).toBe(expected);
  });

  it('handles mixed Latin and CJK boundary (Latin start, CJK end)', () => {
    const input = '**hello明天**';
    const expected = `**hello明天${ZWSP}**`;
    expect(fixFeishuMarkdown(input)).toBe(expected);
  });

  it('adds ZWSP before ** when preceded by CJK character', () => {
    const input = '切换到**bypass**模式';
    const expected = `切换到${ZWSP}**bypass**${ZWSP}模式`;
    expect(fixFeishuMarkdown(input)).toBe(expected);
  });

  it('adds ZWSP after ** when followed by CJK character', () => {
    const input = '**bypass**模式';
    const expected = `**bypass**${ZWSP}模式`;
    expect(fixFeishuMarkdown(input)).toBe(expected);
  });

  it('does not add ZWSP when spaces already separate CJK from **', () => {
    const input = '切换到 **bypass** 模式';
    expect(fixFeishuMarkdown(input)).toBe(input);
  });

  it('is idempotent with outer CJK chars', () => {
    const input = '切换到**bypass**模式';
    const first = fixFeishuMarkdown(input);
    const second = fixFeishuMarkdown(first);
    expect(second).toBe(first);
  });

  // ─── Italic (*) ───

  it('keeps Latin-only italic unchanged', () => {
    expect(fixFeishuMarkdown('*hello*')).toBe('*hello*');
  });

  it('adds inner ZWSP between * and CJK content', () => {
    const input = '*中文斜体*';
    const expected = `*${ZWSP}中文斜体${ZWSP}*`;
    expect(fixFeishuMarkdown(input)).toBe(expected);
  });

  it('adds inner + outer ZWSP around * when CJK surrounds everything', () => {
    const input = '这是一段*斜体*文字';
    const expected = `这是一段${ZWSP}*${ZWSP}斜体${ZWSP}*${ZWSP}文字`;
    expect(fixFeishuMarkdown(input)).toBe(expected);
  });

  it('does not confuse italic * with bold **', () => {
    const input = '**bold** and *italic*';
    const expected = `**bold** and *italic*`;
    expect(fixFeishuMarkdown(input)).toBe(expected);
  });

  it('is idempotent for italic', () => {
    const input = '一段*中文*斜体*文字*测试';
    const first = fixFeishuMarkdown(input);
    const second = fixFeishuMarkdown(first);
    expect(second).toBe(first);
  });

  // ─── Strikethrough (~~) ───

  it('keeps Latin-only strikethrough unchanged', () => {
    expect(fixFeishuMarkdown('~~strikethrough~~')).toBe('~~strikethrough~~');
  });

  it('adds inner ZWSP between ~~ and CJK content', () => {
    const input = '~~删除的文字~~';
    const expected = `~~${ZWSP}删除的文字${ZWSP}~~`;
    expect(fixFeishuMarkdown(input)).toBe(expected);
  });

  it('adds inner + outer ZWSP around ~~ when CJK surrounds everything', () => {
    const input = '这段内容~~已删除~~请忽略';
    const expected = `这段内容${ZWSP}~~${ZWSP}已删除${ZWSP}~~${ZWSP}请忽略`;
    expect(fixFeishuMarkdown(input)).toBe(expected);
  });

  it('is idempotent for strikethrough', () => {
    const input = '文本~~删除线~~更多';
    const first = fixFeishuMarkdown(input);
    const second = fixFeishuMarkdown(first);
    expect(second).toBe(first);
  });

  // ─── Mixed markers ───

  it('handles bold + italic + strikethrough in same text', () => {
    const input = '**粗体**和*斜体*和~~删除线~~混排';
    const result = fixFeishuMarkdown(input);
    // All CJK content → inner ZWSP for each marker
    expect(result).toContain(boldInner('粗体'));
    expect(result).toContain(italicInner('斜体'));
    expect(result).toContain(strikeInner('删除线'));
    // Bold is at string start — no leading ZWSP
    expect(result).not.toMatch(/^​/);
    // Bold followed by CJK → outer ZWSP between ** and 和
    expect(result).toContain(`**${ZWSP}和`);
    // Strikethrough followed by CJK → outer ZWSP between ~~ and 混
    expect(result).toContain(`~~${ZWSP}混`);
    // CJK on both sides of italic → outer ZWSP around *
    expect(result).toContain(`${ZWSP}*${ZWSP}斜体${ZWSP}*${ZWSP}`);
  });

  it('does not modify text without any markers', () => {
    expect(fixFeishuMarkdown('plain text 普通文本')).toBe('plain text 普通文本');
  });
});

// ─── Backward compatibility: fixFeishuBold ───

describe('fixFeishuBold (deprecated alias)', () => {
  it('delegates to fixFeishuMarkdown', () => {
    const input = '切换到**bypass**模式';
    expect(fixFeishuBold(input)).toBe(fixFeishuMarkdown(input));
  });

  it('is idempotent', () => {
    const input = '**"text"**';
    const first = fixFeishuBold(input);
    const second = fixFeishuBold(first);
    expect(second).toBe(first);
  });
});
