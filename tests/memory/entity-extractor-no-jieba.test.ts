/**
 * `extractEntities` with jieba unavailable — the conservative fallback.
 *
 * Without segmentation no word boundary can be proven inside a CJK run, so a
 * surname-shaped candidate is admitted only when both of its neighbours are
 * non-CJK characters. `cutCJK` returning [] is exactly what it does when the
 * native jieba binding cannot be loaded, so mocking it is the honest stand-in.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/memory/fts-tokenizer', () => ({
  cutCJK: () => [],
}));

import { extractEntities } from '../../src/memory/entity-extractor';

describe('extractEntities without jieba', () => {
  it('drops a name it cannot prove the boundaries of', () => {
    // 王 is a surname and 王小明 is a real name, but inside a CJK run the old
    // regex could only guess where it ends.
    expect(extractEntities('王小明是工程师')).toEqual([]);
    expect(extractEntities('如何称呼张照奇')).toEqual([]);
    expect(extractEntities('发了一张图片')).toEqual([]);
  });

  it('keeps a candidate delimited by non-CJK characters', () => {
    expect(extractEntities('"张伟"是我的朋友')).toEqual([
      { entity: '张伟', relationType: 'MENTIONED', confidence: 0.75 },
    ]);
  });

  it('never throws when nothing can be segmented', () => {
    for (const text of ['', 'API and TypeScript', '张照奇']) {
      expect(() => extractEntities(text)).not.toThrow();
    }
  });
});
