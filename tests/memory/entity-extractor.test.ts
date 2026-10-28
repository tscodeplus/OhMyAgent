/**
 * Deterministic entity extraction (`extractEntities`).
 *
 * Two defects measured on a real 712-memory database are pinned here: entities
 * that are mere substrings of ordinary prose (何称 sliced out of 如何称呼, 张图 out
 * of 一张图片, 程师 out of 工程师) and relations asserted from a keyword that
 * appears anywhere in the memory (穿衣建议 —ADVISES→ 周五 at confidence 0.95).
 * The deterministic path may only report mentions, and only where a word
 * boundary proves the candidate is a word.
 *
 * Latin/tech nouns (API, 飞书, Android, Termux, MiMo TTS) are not this path's
 * job — `src/graph/entity-mining.ts` is the producer that mines those into
 * `memory_links`, and its own tests assert them.
 */

import { describe, it, expect } from 'vitest';
import { extractEntities } from '../../src/memory/entity-extractor';

function names(text: string): string[] {
  return extractEntities(text, { scope: 'user' }).map((entity) => entity.entity);
}

describe('extractEntities — mentions only, never a typed relation', () => {
  it('gives every entity MENTIONED, whatever keywords the memory contains', () => {
    const texts = [
      '穿衣建议：周五降温，注意保暖', // 建议 → ADVISES on 周五
      '复杂任务何时会使用子Agent', // 创建 → FOUNDED on 何时
      '发了一张图片', // the source memory said 建议 → ADVISES on 张图
      '如何称呼你', // 何 is a surname → ADVISES on 何称
      '我创立了字节跳动公司，也投资了清华大学实验室', // FOUNDED + INVESTED keywords
      '张伟是这里的顾问，参加了会议，提到过李明', // ADVISES + ATTENDED + MENTIONED
    ];

    for (const text of texts) {
      for (const entity of extractEntities(text, { scope: 'user' })) {
        expect(entity.relationType).toBe('MENTIONED');
      }
    }
  });

  it('does not turn 建议 in a weather answer into an ADVISES expert', () => {
    expect(extractEntities('穿衣建议：周五降温，注意保暖')).toEqual([]);
  });

  it('does not turn 创建 in a question about when to use a sub-agent into a founder', () => {
    expect(extractEntities('复杂任务何时会使用子Agent')).toEqual([]);
  });

  it('keeps the ExtractedEntity shape the callers rely on', () => {
    const [first] = extractEntities('王小明是我的同事', { scope: 'user' });
    expect(Object.keys(first).sort()).toEqual(['confidence', 'entity', 'relationType']);
    expect(first).toEqual({ entity: '王小明', relationType: 'MENTIONED', confidence: 0.75 });
  });
});

describe('extractEntities — a CJK candidate must be a whole jieba token', () => {
  it('rejects 何称, a surname-anchored slice of 如何称呼', () => {
    expect(names('如何称呼')).not.toContain('何称');
    expect(names('如何称呼张照奇')).toEqual([]);
  });

  it('rejects both fragments of an unknown three-character name', () => {
    // jieba cuts 张照奇 as 张照|奇: only 张照 is a word, and 张奇 straddles the cut.
    expect(names('张照奇')).not.toContain('张奇');
    expect(names('张照奇')).not.toContain('张照奇');
  });

  it('rejects 张图 sliced out of 一张图片', () => {
    expect(names('发了一张图片')).not.toContain('张图');
    expect(names('发了一张图片')).toEqual([]);
  });

  it('rejects 程师 sliced out of 工程师, and keeps the real name', () => {
    expect(names('王小明是工程师')).toEqual(['王小明']);
  });

  it('rejects the truncated form instead of preferring it', () => {
    // The old `full.slice(0, -1)` made 王小 out of 王小明, and the prefix dedupe
    // then threw the real name away — the fragment won.
    expect(names('王小明是工程师')).not.toContain('王小');
    expect(names('林小红是我的同事')).toEqual(['林小红']);
  });
});

describe('extractEntities — coverage the tightening must not empty', () => {
  it('keeps two-character names in running text', () => {
    expect(names('李明和张伟一起去了北京')).toEqual(['李明', '张伟']);
  });

  it('keeps names jieba recognises as one token', () => {
    expect(names('欧阳修是我的老师')).toEqual(['欧阳修']);
  });

  it('keeps org-suffix entities', () => {
    expect(names('字节跳动公司是我前雇主')).toEqual(['字节跳动公司']);
    expect(names('清华大学实验室发表了论文')).toEqual(['清华大学实验室']);
  });

  it('does not throw on text it cannot use', () => {
    for (const text of ['', '   ', 'API and TypeScript', '```ts\nconst a = 1;\n```']) {
      expect(() => extractEntities(text)).not.toThrow();
      expect(extractEntities(text)).toEqual([]);
    }
  });
});
