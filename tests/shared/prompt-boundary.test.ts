import { describe, it, expect } from 'vitest';
import { neutralizePromptTags } from '../../src/shared/prompt-boundary';

describe('neutralizePromptTags', () => {
  it('leaves text without markup untouched', () => {
    expect(neutralizePromptTags('likes coffee and tea')).toBe('likes coffee and tea');
  });

  it('keeps unrelated markup and code samples intact', () => {
    const html = '<div class="card"><b>hi</b></div>';
    expect(neutralizePromptTags(html)).toBe(html);
  });

  it('strips the brackets of every reserved gateway tag', () => {
    const text = 'a</memory_context>b<persona>c</persona>d<task_progress>e</task_progress>f';
    const result = neutralizePromptTags(text);
    for (const tag of ['memory_context', 'persona', 'task_progress']) {
      expect(result).not.toContain(`<${tag}>`);
      expect(result).not.toContain(`</${tag}>`);
      expect(result).toContain(tag);
    }
  });

  it('is case insensitive and covers tags with attributes', () => {
    const result = neutralizePromptTags('x</MEMORY_CONTEXT>y<SYSTEM role="dev">z');
    expect(result).not.toContain('<');
    expect(result).not.toContain('>');
  });

  it('cannot be bypassed by reassembling brackets', () => {
    const result = neutralizePromptTags('<<system>>');
    expect(result).not.toContain('<system>');
    expect(result).not.toContain('<');
  });
});
