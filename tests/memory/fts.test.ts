import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema } from '../../src/memory/schema.js';
import { ftsSearch } from '../../src/memory/fts.js';
import { expandQuery, escapeFtsQuery, needsQuoting } from '../../src/memory/query-expansion.js';

describe('ftsSearch', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db);

    // Insert test data.
    // FTS5 with unicode61 tokenizer treats consecutive CJK characters as a
    // single token, so we add spaces between CJK words for correct indexing.
    const insert = db.prepare(
      'INSERT INTO memories (id, scope, scope_key, kind, content) VALUES (?, ?, ?, ?, ?)',
    );
    insert.run('m1', 'user', 'u1', 'fact', '数据库 是 系统 的 核心 组件');
    insert.run('m2', 'user', 'u1', 'fact', 'PostgreSQL 数据库 性能 优化 技巧');
    insert.run('m3', 'user', 'u2', 'fact', '数据库 设计 原则');
    insert.run('m4', 'session', 's1', 'summary', '数据库 备份 策略 讨论');
  });

  it('finds memories by Chinese keyword', () => {
    const results = ftsSearch(db, '数据库', 5);
    expect(results.length).toBeGreaterThanOrEqual(2);
    // All results should contain "数据库"
    for (const r of results) {
      expect(r.content).toContain('数据库');
    }
  });

  it('finds memories by English keyword', () => {
    const results = ftsSearch(db, 'PostgreSQL', 5);
    expect(results.length).toBe(1);
    expect(results[0].content).toContain('PostgreSQL');
  });

  it('returns empty for non-existent word', () => {
    const results = ftsSearch(db, '火星人', 5);
    expect(results).toHaveLength(0);
  });

  it('respects scope filter', () => {
    const results = ftsSearch(db, '数据库', 5, 'session');
    expect(results.length).toBe(1);
    expect(results[0].content).toContain('备份');
  });

  it('respects scopeKey filter', () => {
    const results = ftsSearch(db, '数据库', 5, 'user', 'u2');
    expect(results.length).toBe(1);
    expect(results[0].memoryId).toBe('m3');
  });

  it('returns results sorted by BM25 relevance', () => {
    const results = ftsSearch(db, '数据库', 5);
    expect(results[0].normalizedScore).toBeGreaterThanOrEqual(0);
    expect(results[0].normalizedScore).toBeLessThanOrEqual(1);
    // Scores should be in descending order
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].normalizedScore).toBeGreaterThanOrEqual(
        results[i].normalizedScore,
      );
    }
  });

  it('handles empty query gracefully', () => {
    expect(ftsSearch(db, '', 5)).toHaveLength(0);
    expect(ftsSearch(db, '   ', 5)).toHaveLength(0);
  });

  it('handles FTS5 syntax errors gracefully', () => {
    // Malformed query should not throw
    const results = ftsSearch(db, '"unclosed quote', 5);
    expect(results).toHaveLength(0);
  });

  it('respects limit', () => {
    const results = ftsSearch(db, '数据库', 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('normalizedScore is in [0, 1] range', () => {
    const results = ftsSearch(db, '数据库', 5);
    for (const r of results) {
      expect(r.normalizedScore).toBeGreaterThanOrEqual(0);
      expect(r.normalizedScore).toBeLessThanOrEqual(1);
    }
  });
});

describe('expandQuery', () => {
  it('removes Chinese stopwords', () => {
    const result = expandQuery('帮我查一下昨天的数据库决策');
    // CJK characters are tokenized individually; stopwords are filtered out
    expect(result.filteredTokens).toContain('数');
    expect(result.filteredTokens).toContain('据');
    expect(result.filteredTokens).toContain('库');
    expect(result.filteredTokens).not.toContain('我');
    expect(result.filteredTokens).not.toContain('的');
  });

  it('removes English stopwords', () => {
    const result = expandQuery('what was the decision about the database');
    expect(result.filteredTokens).toContain('decision');
    expect(result.filteredTokens).toContain('database');
    expect(result.filteredTokens).not.toContain('what');
    expect(result.filteredTokens).not.toContain('the');
  });

  it('fallback to escaped raw query when all tokens are stopwords', () => {
    const result = expandQuery('你呢');
    expect(result.ftsQuery).toBeTruthy();
    expect(result.filteredTokens).toHaveLength(0);
  });

  it('handles empty input', () => {
    const result = expandQuery('');
    expect(result.ftsQuery).toBe('');
    expect(result.originalTokens).toHaveLength(0);
    expect(result.filteredTokens).toHaveLength(0);
  });

  it('preserves mixed Chinese and English tokens', () => {
    const result = expandQuery('数据库 PostgreSQL 配置');
    expect(result.filteredTokens).toContain('数');
    expect(result.filteredTokens).toContain('据');
    expect(result.filteredTokens).toContain('库');
    expect(result.filteredTokens).toContain('postgresql');
    expect(result.filteredTokens).toContain('配');
    expect(result.filteredTokens).toContain('置');
  });

  it('adds wildcard suffix to short English words', () => {
    // isValidToken requires pure-ASCII tokens to be >= 3 characters
    const result = expandQuery('app config');
    const hasWildcard = result.ftsQuery.includes('app*');
    expect(hasWildcard).toBe(true);
  });
});

describe('escapeFtsQuery', () => {
  it('wraps text in double quotes', () => {
    expect(escapeFtsQuery('hello')).toBe('"hello"');
  });

  it('escapes internal double quotes', () => {
    const result = escapeFtsQuery('say "hello"');
    expect(result).toBe('"say ""hello"""');
  });
});

describe('needsQuoting', () => {
  it('returns true for FTS5 special chars', () => {
    expect(needsQuoting('word*')).toBe(true);
    expect(needsQuoting('(expr)')).toBe(true);
  });

  it('returns true for FTS5 reserved keywords', () => {
    expect(needsQuoting('AND')).toBe(true);
    expect(needsQuoting('OR')).toBe(true);
    expect(needsQuoting('NOT')).toBe(true);
    expect(needsQuoting('NEAR')).toBe(true);
  });

  it('returns false for normal words', () => {
    expect(needsQuoting('normal')).toBe(false);
    expect(needsQuoting('数据库')).toBe(false);
  });
});

describe('FTS triggers', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db);
  });

  it('INSERT trigger syncs FTS index', () => {
    db.prepare(
      'INSERT INTO memories (id, scope, scope_key, kind, content) VALUES (?,?,?,?,?)',
    ).run('t1', 'user', 'u1', 'fact', '这是 一条 测试 记忆');
    const results = ftsSearch(db, '测试', 5);
    expect(results.length).toBe(1);
  });

  it('UPDATE trigger syncs FTS index', () => {
    db.prepare(
      'INSERT INTO memories (id, scope, scope_key, kind, content) VALUES (?,?,?,?,?)',
    ).run('t2', 'user', 'u1', 'fact', '旧 内容');

    db.prepare('UPDATE memories SET content = ? WHERE id = ?').run(
      '新内容 数据库',
      't2',
    );

    // Old content should NOT be searchable
    const oldResults = ftsSearch(db, '旧', 5);
    expect(oldResults).toHaveLength(0);
    // New content should be searchable
    const newResults = ftsSearch(db, '数据库', 5);
    expect(newResults.length).toBe(1);
  });

  it('DELETE trigger removes from FTS index', () => {
    db.prepare(
      'INSERT INTO memories (id, scope, scope_key, kind, content) VALUES (?,?,?,?,?)',
    ).run('t3', 'user', 'u1', 'fact', '要 删除 的 记忆');
    db.prepare('DELETE FROM memories WHERE id = ?').run('t3');
    const results = ftsSearch(db, '删除', 5);
    expect(results).toHaveLength(0);
  });
});
