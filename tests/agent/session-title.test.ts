import { describe, it, expect } from 'vitest';
import {
  buildTitlePrompt,
  cleanTitleInput,
  fallbackTitle,
  isPlaceholderTitle,
  MAX_TITLE_LENGTH,
  MIN_TITLE_LENGTH,
  parseSessionMetadata,
  parseTitleResponse,
  titleCharCount,
} from '../../src/agent/session-title';

describe('isPlaceholderTitle', () => {
  it('treats missing titles as placeholders', () => {
    expect(isPlaceholderTitle(undefined)).toBe(true);
    expect(isPlaceholderTitle(null)).toBe(true);
    expect(isPlaceholderTitle('')).toBe(true);
  });

  it('recognizes default placeholder titles', () => {
    expect(isPlaceholderTitle('New Chat')).toBe(true);
    expect(isPlaceholderTitle('New Chat1')).toBe(true);
    expect(isPlaceholderTitle('新对话')).toBe(true);
    expect(isPlaceholderTitle('新对话3')).toBe(true);
    expect(isPlaceholderTitle('对话')).toBe(true);
    expect(isPlaceholderTitle('对话12')).toBe(true);
    expect(isPlaceholderTitle('Conversation')).toBe(true);
  });

  it('keeps real/user-renamed titles', () => {
    expect(isPlaceholderTitle('Fix login button')).toBe(false);
    expect(isPlaceholderTitle('帮我写一个 Python 脚本')).toBe(false);
  });
});

describe('parseSessionMetadata', () => {
  it('parses valid metadata and tolerates garbage', () => {
    expect(parseSessionMetadata('{"title":"Fix login"}')).toEqual({ title: 'Fix login' });
    expect(parseSessionMetadata(null)).toEqual({});
    expect(parseSessionMetadata('not json')).toEqual({});
    expect(parseSessionMetadata('[]')).toEqual({});
  });
});

describe('titleCharCount', () => {
  it('counts non-whitespace characters', () => {
    expect(titleCharCount('Fix login')).toBe(8);
    expect(titleCharCount('帮我写个脚本')).toBe(6);
    expect(titleCharCount('  a  b ')).toBe(2);
  });
});

describe('cleanTitleInput', () => {
  it('strips system reminders and injected timestamps', () => {
    const cleaned = cleanTitleInput(
      '<system-reminder>remember</system-reminder>\n[当前时间:2026-08-14]\n  帮我写 一个 脚本  ',
    );
    expect(cleaned).toBe('帮我写 一个 脚本');
  });

  it('caps input length', () => {
    const long = 'x'.repeat(2000);
    expect(cleanTitleInput(long).length).toBeLessThanOrEqual(500);
  });
});

describe('buildTitlePrompt', () => {
  it('embeds the message and demands the same language', () => {
    const { systemPrompt, prompt } = buildTitlePrompt('帮我写个脚本');
    expect(systemPrompt).toContain('titling');
    expect(prompt).toContain('帮我写个脚本');
    expect(prompt).toContain('SAME LANGUAGE');
    expect(prompt).toContain('3 to 15 characters');
  });
});

describe('parseTitleResponse', () => {
  it('parses a JSON title', () => {
    expect(parseTitleResponse('{"title":"Fix login button"}')).toBe('Fix login button');
  });

  it('parses fenced JSON and prose-wrapped JSON', () => {
    expect(parseTitleResponse('```json\n{"title":"帮我写个脚本"}\n```')).toBe('帮我写个脚本');
    expect(parseTitleResponse('Here you go: {"title":"Fix login"}')).toBe('Fix login');
  });

  it('rejects titles outside the 3-15 char bounds', () => {
    expect(parseTitleResponse('{"title":"ab"}')).toBeNull();
    expect(parseTitleResponse('{"title":""}')).toBeNull();
    expect(parseTitleResponse('no title here')).toBeNull();
  });

  it('truncates overly long titles at a word boundary', () => {
    const long = 'a very long conversation title about many things at once';
    const result = parseTitleResponse(`{"title":"${long}"}`);
    expect(result).not.toBeNull();
    expect(titleCharCount(result!)).toBeLessThanOrEqual(MAX_TITLE_LENGTH);
    expect(result).toBe('a very long'); // word-boundary cut
  });

  it('truncates long CJK titles to 15 characters', () => {
    const result = parseTitleResponse('{"title":"帮我写一个非常非常长的Python脚本用于数据处理"}');
    expect(titleCharCount(result!)).toBe(MAX_TITLE_LENGTH);
    expect(titleCharCount(result!)).toBeLessThanOrEqual(15);
  });
});

describe('fallbackTitle', () => {
  it('truncates the cleaned message to 15 chars', () => {
    const result = fallbackTitle('<system-reminder>x</system-reminder> 帮我写一个非常长的Python脚本用于数据处理');
    expect(result).not.toBeNull();
    expect(titleCharCount(result!)).toBeLessThanOrEqual(MAX_TITLE_LENGTH);
    expect(result!.length).toBeGreaterThanOrEqual(MIN_TITLE_LENGTH);
  });

  it('returns null for empty input', () => {
    expect(fallbackTitle('   ')).toBeNull();
    expect(fallbackTitle('<system-reminder>only tags</system-reminder>')).toBeNull();
  });
});
