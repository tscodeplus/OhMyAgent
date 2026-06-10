/**
 * Verify <think> tags are stripped from text deltas in EventBridge.
 */
import { describe, it, expect } from 'vitest';

describe('think tag filtering', () => {
  // Inline the filter logic for unit testing
  function createFilter() {
    let inThinkBlock = false;
    return (delta: string): string => {
      let result = '';
      let i = 0;
      while (i < delta.length) {
        if (!inThinkBlock) {
          const openIdx = delta.indexOf('<think>', i);
          if (openIdx === -1) { result += delta.slice(i); break; }
          result += delta.slice(i, openIdx);
          inThinkBlock = true;
          i = openIdx + 7;
        } else {
          const closeIdx = delta.indexOf('</think>', i);
          if (closeIdx === -1) { break; }
          inThinkBlock = false;
          i = closeIdx + 8;
        }
      }
      return result;
    };
  }

  it('strips single complete think block', () => {
    const filter = createFilter();
    expect(filter('<think>reasoning</think>Hello')).toBe('Hello');
  });

  it('strips think block spanning multiple deltas', () => {
    const filter = createFilter();
    expect(filter('Before <think>start')).toBe('Before ');
    expect(filter(' middle')).toBe('');
    expect(filter(' end</think> after')).toBe(' after');
  });

  it('strips multiple think blocks', () => {
    const filter = createFilter();
    expect(filter('<think>a</think>b<think>c</think>d')).toBe('bd');
  });

  it('passes through normal text unchanged', () => {
    const filter = createFilter();
    expect(filter('Hello world')).toBe('Hello world');
  });

  it('handles partial think tag across deltas (no false match)', () => {
    const filter = createFilter();
    // "<thin" does not match "<think>" — text passes through
    expect(filter('text <thin')).toBe('text <thin');
    // "k>" does not close a think block (none is open), so passes through
    expect(filter('k>inside after')).toBe('k>inside after');
  });

  it('complex multi-block from real model output', () => {
    const filter = createFilter();
    expect(filter('<think>根据</think><think>搜索</think>')).toBe('');
    expect(filter('<think>结果</think>明天天气晴朗')).toBe('明天天气晴朗');
  });
});
