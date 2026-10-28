import { describe, it, expect, afterEach } from 'vitest';
import {
  DEFAULT_MAX_MENTIONS_PER_MEMORY,
  mineMentionedEntities,
} from '../../src/graph/entity-mining';
import { _resetJiebaForTest, _setJiebaForTest } from '../../src/memory/fts-tokenizer';

function names(content: string, maxMentions?: number): string[] {
  return mineMentionedEntities(
    { id: 'm1', content, kind: 'fact', scope: 'user', created_at: '1700000000000' },
    maxMentions === undefined ? {} : { maxMentions },
  ).map((mention) => mention.name);
}

describe('entity-mining: deterministic mention extraction', () => {
  afterEach(() => {
    // The fallback test installs a "jieba unavailable" instance; every other
    // test needs the real one back.
    _resetJiebaForTest();
  });

  it('extracts Latin names and keeps multi-word names whole', () => {
    const mentions = names('We load E:\\Excel with excel-mcp and read it through Power Query.');

    expect(mentions).toContain('Power Query');
    expect(mentions).toContain('excel-mcp');
    expect(mentions).toContain('Excel');
    // Constituents of a phrase are absorbed: "Power" alone would be a second,
    // less specific node for the same thing.
    expect(mentions).not.toContain('Power');
    expect(mentions).not.toContain('Query');
  });

  it('extracts CJK words and joins adjacent tokens into compounds', () => {
    // jieba splits 知识图谱 into 知识|图谱 and 记忆系统 into 记忆系统/记忆|系统;
    // the compound is the node a user searches for, the fragments are not.
    const mentions = names('用户希望把知识图谱接入记忆系统。');

    expect(mentions).toContain('知识图谱');
    expect(mentions).not.toContain('知识');
    expect(mentions).not.toContain('图谱');
    expect(mentions).toContain('记忆系统');
    // Generic words ("用户", "希望") would make every preference memory look alike.
    expect(mentions).not.toContain('用户');
    expect(mentions).not.toContain('希望');
  });

  it('keeps both scripts when a memory mixes them', () => {
    const mentions = names('用 Power Query 读取 Excel 里的 Sheet，Python 脚本不要用。');

    expect(mentions).toContain('Power Query');
    expect(mentions).toContain('Excel');
    expect(mentions).toContain('Sheet');
    expect(mentions).toContain('Python');
  });

  it('deduplicates case-insensitively and keeps the best-trusted spelling', () => {
    const mentions = names('Excel 文件，excel 表格，EXCEL sheet');

    const excel = mentions.filter((name) => name.toLowerCase() === 'excel');
    expect(excel).toEqual(['Excel']);
  });

  it('drops stop-words, single characters and pure numbers', () => {
    expect(names('the user wants a file in the directory with 1 2 3 a b')).toEqual([]);
    expect(names('在 的 了 是 我 有 和 就 不 人 都 一 上 也 很 到 说 要 去 你 会 着')).toEqual([]);
  });

  it('drops markdown/JSON noise but keeps inline identifiers', () => {
    const mentions = names(
      '```json\n{"secret": "noise-block"}\n```\n\n## 说明\n- 使用 `excel-mcp` 读取 https://example.com/very/long/path 。',
    );

    expect(mentions).toContain('excel-mcp');
    expect(mentions).not.toContain('secret');
    expect(mentions).not.toContain('noise-block');
    expect(mentions).not.toContain('example');
  });

  it('caps the result and orders it by confidence then first mention', () => {
    const content =
      'Power Query reads Excel through excel-mcp, and Python writes sqlite-vec embeddings.';

    const capped = mineMentionedEntities({ id: 'm1', content }, { maxMentions: 3 });
    expect(capped).toHaveLength(3);
    for (let index = 1; index < capped.length; index++) {
      expect(capped[index - 1]!.confidence).toBeGreaterThanOrEqual(capped[index]!.confidence);
    }

    const full = mineMentionedEntities({ id: 'm1', content });
    expect(full.length).toBeLessThanOrEqual(DEFAULT_MAX_MENTIONS_PER_MEMORY);
    // A cap only truncates the tail; it never reorders or rewrites names.
    expect(capped.map((mention) => mention.name)).toEqual(
      full.slice(0, 3).map((mention) => mention.name),
    );
  });

  it('is deterministic: same content, same mentions, same order', () => {
    const content =
      'Alice Smith uses Power Query on Excel via excel-mcp; 知识图谱 与 记忆系统 都在 SQLite 里。';

    const first = mineMentionedEntities({ id: 'm1', content });
    const second = mineMentionedEntities({ id: 'm1', content });

    expect(second).toEqual(first);
    expect(names(content)).toEqual(names(content));
    // Confidence bands first (curated 0.9 → phrase 0.85 → identifier 0.8),
    // first-mention order inside a band.
    expect(first.map((mention) => mention.name)).toEqual([
      'Power Query',
      'Excel',
      '知识图谱',
      '记忆系统',
      'SQLite',
      'Alice Smith',
      'excel-mcp',
    ]);
  });

  it('returns nothing for empty, blank or symbol-only content', () => {
    expect(names('')).toEqual([]);
    expect(names('   \n\t ')).toEqual([]);
    expect(names('12345 !!! 🎉 -------')).toEqual([]);
  });

  it('falls back to short Han runs when jieba is unavailable', () => {
    _setJiebaForTest(null);

    // Without a segmenter the word boundaries of a long run are unknown, so only
    // a run short enough to be one compound is kept — guessing at slices would
    // be worse than missing the mention.
    expect(names('实体关系')).toEqual(['实体关系']);
    expect(names('用户希望把知识图谱接入飞书文档')).toEqual(['知识图谱', '飞书']);
  });
});
