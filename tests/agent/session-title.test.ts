import { describe, it, expect } from 'vitest';
import { vi, beforeEach } from 'vitest';

// Mock the LLM entrypoint so generateSessionTitle tests don't hit the network.
const mockCompleteSimple = vi.fn();
vi.mock('@earendil-works/pi-ai', () => ({
  completeSimple: (...args: any[]) => mockCompleteSimple(...args),
}));

import { completeSimple } from '@earendil-works/pi-ai';
import {
  buildTitlePrompt,
  cleanTitleInput,
  fallbackTitle,
  generateSessionTitle,
  isPlaceholderTitle,
  MAX_TITLE_WIDTH,
  MIN_TITLE_CHARS,
  parseSessionMetadata,
  parseTitleResponse,
  titleCharCount,
  titleWidth,
  truncateTitle,
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

describe('titleWidth', () => {
  it('counts CJK as 2 columns and half-width as 1', () => {
    expect(titleWidth('帮我写个脚本')).toBe(12);
    expect(titleWidth('Fix login')).toBe(9);
    expect(titleWidth('Ubuntu 26.04.1发布了吗')).toBe(22);
  });

  it('keeps mixed-script titles within the budget', () => {
    expect(titleWidth('Ubuntu 26.04.1发布了吗')).toBeLessThanOrEqual(MAX_TITLE_WIDTH);
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
    expect(prompt).toContain('24 display columns');
  });

  it('includes a mixed-script few-shot example', () => {
    const { prompt } = buildTitlePrompt('随便聊聊天');
    expect(prompt).toContain('Ubuntu 26.04.1发布了吗');
  });
});

describe('parseTitleResponse', () => {
  it('parses a JSON title', () => {
    expect(parseTitleResponse('{"title":"Fix login button"}')).toEqual({
      title: 'Fix login button',
      overTolerance: false,
    });
  });

  it('parses fenced JSON and prose-wrapped JSON', () => {
    expect(parseTitleResponse('```json\n{"title":"帮我写个脚本"}\n```')).toEqual({
      title: '帮我写个脚本',
      overTolerance: false,
    });
    expect(parseTitleResponse('Here you go: {"title":"Fix login"}')).toEqual({
      title: 'Fix login',
      overTolerance: false,
    });
  });

  it('rejects titles shorter than the char floor or unparseable', () => {
    expect(parseTitleResponse('{"title":"ab"}')).toBeNull();
    expect(parseTitleResponse('{"title":""}')).toBeNull();
    expect(parseTitleResponse('no title here')).toBeNull();
  });

  it('accepts mixed-script titles that a pure char count would reject', () => {
    // 17 chars — over the old 15-char limit, but only 22 columns.
    const result = parseTitleResponse('{"title":"Ubuntu 26.04.1发布了吗"}');
    expect(result).toEqual({ title: 'Ubuntu 26.04.1发布了吗', overTolerance: false });
  });

  it('accepts slightly-overflowing titles inside the tolerance band', () => {
    const thirtyCols = 'abcdefghijklmnopqrstuvwxyz1234'; // exactly 30 columns
    expect(titleWidth(thirtyCols)).toBe(30);
    expect(parseTitleResponse(`{"title":"${thirtyCols}"}`)).toEqual({
      title: thirtyCols,
      overTolerance: false,
    });
  });

  it('truncates over-tolerance titles and flags them', () => {
    const long = 'a very long conversation title about many things at once';
    const result = parseTitleResponse(`{"title":"${long}"}`);
    expect(result).not.toBeNull();
    expect(result!.overTolerance).toBe(true);
    expect(titleWidth(result!.title)).toBeLessThanOrEqual(MAX_TITLE_WIDTH);
    expect(result!.title).toBe('a very long conversation'); // exactly 24 columns
  });

  it('truncates long CJK titles to the width budget', () => {
    const result = parseTitleResponse('{"title":"帮我写一个非常非常长的Python脚本用于数据处理"}');
    expect(result!.overTolerance).toBe(true);
    expect(titleWidth(result!.title)).toBeLessThanOrEqual(MAX_TITLE_WIDTH);
    // The trailing "Py" run stub is backed off to the CJK phrase (22 columns).
    expect(result!.title).toBe('帮我写一个非常非常长的');
  });
});

describe('truncateTitle', () => {
  it('prefers cutting at sentence punctuation', () => {
    expect(truncateTitle('Fix the bug, then run all the tests in CI')).toBe('Fix the bug');
  });

  it('never splits version-number runs when a run start is wide enough', () => {
    const result = truncateTitle('Ubuntu 26.04.1-release-notes changelog details');
    expect(result).toBe('Ubuntu');
  });

  it('returns short input untouched', () => {
    expect(truncateTitle('短标题')).toBe('短标题');
  });
});

describe('fallbackTitle', () => {
  it('uses the first sentence clause when present', () => {
    const result = fallbackTitle('Ubuntu 26.04.1发布了吗，需要根据官方release notes来确认');
    expect(result).toBe('Ubuntu 26.04.1发布了吗');
  });

  it('boundary-truncates clause-less messages within the width budget', () => {
    const result = fallbackTitle('<system-reminder>x</system-reminder> 帮我写一个非常长的Python脚本用于数据处理');
    expect(result).not.toBeNull();
    expect(titleWidth(result!)).toBeLessThanOrEqual(MAX_TITLE_WIDTH);
    expect(titleCharCount(result!)).toBeGreaterThanOrEqual(MIN_TITLE_CHARS);
    expect(result).toBe('帮我写一个非常长的Python');
  });

  it('does not treat version dots as clause boundaries', () => {
    const result = fallbackTitle('对比 3.2 和 3.3 的性能');
    expect(result).toBe('对比 3.2 和 3.3 的性能');
  });

  it('returns null for empty input', () => {
    expect(fallbackTitle('   ')).toBeNull();
    expect(fallbackTitle('<system-reminder>only tags</system-reminder>')).toBeNull();
  });
});

describe('generateSessionTitle', () => {
  const model = { provider: 'agnes', id: 'agnes-2.0-flash', api: 'openai-completions' };

  beforeEach(() => {
    mockCompleteSimple.mockReset();
  });

  it('forwards the provider apiKey into the LLM call options', async () => {
    mockCompleteSimple.mockResolvedValue({
      stopReason: 'stop',
      content: [{ type: 'text', text: '{"title":"帮我写脚本"}' }],
    });

    const title = await generateSessionTitle({ model, message: '帮我写一个 Python 脚本', apiKey: 'sk-test' });

    expect(title).toBe('帮我写脚本');
    expect(mockCompleteSimple).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ apiKey: 'sk-test' }),
    );
  });

  it('keeps a mixed-script title without a compression retry', async () => {
    mockCompleteSimple.mockResolvedValue({
      stopReason: 'stop',
      content: [{ type: 'text', text: '{"title":"Ubuntu 26.04.1发布了吗"}' }],
    });

    const title = await generateSessionTitle({ model, message: 'Ubuntu 26.04.1发布了吗，需要根据官方release notes来确认' });

    expect(title).toBe('Ubuntu 26.04.1发布了吗');
    expect(mockCompleteSimple).toHaveBeenCalledTimes(1);
  });

  it('retries once to compress over-tolerance titles and accepts the compressed one', async () => {
    mockCompleteSimple
      .mockResolvedValueOnce({
        stopReason: 'stop',
        content: [{ type: 'text', text: '{"title":"a very long conversation title about many things at once"}' }],
      })
      .mockResolvedValueOnce({
        stopReason: 'stop',
        content: [{ type: 'text', text: '{"title":"Long chat topic"}' }],
      });

    const title = await generateSessionTitle({ model, message: 'a very long message' });

    expect(title).toBe('Long chat topic');
    expect(mockCompleteSimple).toHaveBeenCalledTimes(2);
    // The retry continues the conversation: user -> assistant -> compress ask.
    const retryMessages = mockCompleteSimple.mock.calls[1][1].messages;
    expect(retryMessages).toHaveLength(3);
    expect(retryMessages[2].content).toContain('too long');
  });

  it('settles for the locally truncated title when the compression retry also overflows', async () => {
    mockCompleteSimple
      .mockResolvedValueOnce({
        stopReason: 'stop',
        content: [{ type: 'text', text: '{"title":"a very long conversation title about many things at once"}' }],
      })
      .mockResolvedValueOnce({
        stopReason: 'stop',
        content: [{ type: 'text', text: '{"title":"another extremely long title that keeps rambling on and on"}' }],
      });

    const title = await generateSessionTitle({ model, message: 'a very long message' });

    expect(title).toBe('a very long conversation');
    expect(titleWidth(title!)).toBeLessThanOrEqual(MAX_TITLE_WIDTH);
  });

  it('falls back to the first message when the LLM call fails (e.g. missing apiKey)', async () => {
    mockCompleteSimple.mockRejectedValue(new Error('No API key for provider: agnes'));

    const title = await generateSessionTitle({ model, message: '北京今天是什么天气' });

    expect(title).toBe('北京今天是什么天气');
  });

  it('falls back to the first message when the LLM returns unparseable output', async () => {
    mockCompleteSimple.mockResolvedValue({
      stopReason: 'error',
      content: [],
    });

    const title = await generateSessionTitle({ model, message: '帮我写个脚本' });

    expect(title).toBe('帮我写个脚本');
  });
});
