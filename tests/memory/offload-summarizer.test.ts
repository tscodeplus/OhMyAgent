import { describe, it, expect } from 'vitest';
import {
  summarizeToolResult,
  extractArgsSummary,
  normalizeResult,
} from '../../src/memory/offload-summarizer.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bytesOf(text: string): number {
  return new TextEncoder().encode(text).length;
}

// ---------------------------------------------------------------------------
// normalizeResult
// ---------------------------------------------------------------------------

describe('normalizeResult', () => {
  it('passes through a plain string', () => {
    expect(normalizeResult('hello')).toBe('hello');
  });

  it('extracts text from TextBlock array', () => {
    expect(normalizeResult([{ type: 'text', text: 'line1\nline2' }])).toBe('line1\nline2');
  });

  it('joins multiple TextBlock items', () => {
    const result = normalizeResult([
      { type: 'text', text: 'part1' },
      { type: 'text', text: 'part2' },
    ]);
    expect(result).toBe('part1\npart2');
  });

  it('handles string arrays', () => {
    expect(normalizeResult(['a', 'b', 'c'])).toBe('a\nb\nc');
  });

  it('handles mixed arrays (strings + objects)', () => {
    const result = normalizeResult([
      'plain string',
      { type: 'text', text: 'textblock' },
      { foo: 'bar' },
    ]);
    expect(result).toContain('plain string');
    expect(result).toContain('textblock');
  });

  it('returns empty string for null/undefined', () => {
    expect(normalizeResult(null)).toBe('');
    expect(normalizeResult(undefined)).toBe('');
  });

  it('stringifies unexpected object types', () => {
    const result = normalizeResult({ custom: 'value' });
    expect(result).toBe(JSON.stringify({ custom: 'value' }));
  });
});

// ---------------------------------------------------------------------------
// extractArgsSummary
// ---------------------------------------------------------------------------

describe('extractArgsSummary', () => {
  it('returns object as-is', () => {
    expect(extractArgsSummary({ command: 'ls' })).toEqual({ command: 'ls' });
  });

  it('parses JSON string args', () => {
    expect(extractArgsSummary('{"command":"ls"}')).toEqual({ command: 'ls' });
  });

  it('wraps invalid JSON string in raw', () => {
    const result = extractArgsSummary('not-json');
    expect(result).toEqual({ raw: 'not-json' });
  });

  it('returns empty object for non-object types', () => {
    expect(extractArgsSummary(null)).toEqual({});
    expect(extractArgsSummary(undefined)).toEqual({});
    expect(extractArgsSummary(42)).toEqual({});
    expect(extractArgsSummary(['a', 'b'])).toEqual({});
  });

  it('ignores JSON array strings', () => {
    const result = extractArgsSummary('["a","b"]');
    expect(result).toEqual({ raw: '["a","b"]' });
  });
});

// ---------------------------------------------------------------------------
// summarizeToolResult — error path
// ---------------------------------------------------------------------------

describe('summarizeToolResult — error path', () => {
  it('uses the unified error template', () => {
    const result = summarizeToolResult('shell', { command: 'rm -rf /' }, 'Permission denied', true);
    expect(result).toBe('❌ shell: 执行失败 — Permission denied');
  });

  it('extracts error message from JSON result', () => {
    const result = summarizeToolResult(
      'http_request',
      { url: 'https://example.com' },
      JSON.stringify({ error: 'Connection refused', statusCode: 503 }),
      true,
    );
    expect(result).toBe('❌ http_request: 执行失败 — Connection refused');
  });

  it('truncates long error messages to 80 chars', () => {
    const longError = 'x'.repeat(200);
    const result = summarizeToolResult('shell', {}, longError, true);
    expect(result.length).toBeLessThanOrEqual(200);
    expect(result).toContain('...');
  });

  it('handles TextBlock error result', () => {
    const result = summarizeToolResult(
      'shell',
      { command: 'ls' },
      [{ type: 'text', text: 'Command not found' }],
      true,
    );
    expect(result).toBe('❌ shell: 执行失败 — Command not found');
  });

  it('uses original tool name (not normalized) in error output', () => {
    const result = summarizeToolResult('file_read', {}, 'No such file', true);
    expect(result).toContain('❌ file_read:');
  });
});

// ---------------------------------------------------------------------------
// summarizeToolResult — shell / bash / exec
// ---------------------------------------------------------------------------

describe('summarizeToolResult — shell/bash/exec', () => {
  it('summarizes shell command output', () => {
    const result = summarizeToolResult('shell', { command: 'ls -la' }, 'file1\nfile2\nfile3\n');
    expect(result).toBe('执行 shell 命令 `ls -la`，输出 3 行');
  });

  it('supports alias names: bash, exec', () => {
    expect(summarizeToolResult('bash', { command: 'echo hi' }, 'hi\n')).toBe(
      '执行 shell 命令 `echo hi`，输出 1 行',
    );
    expect(summarizeToolResult('exec', { command: 'date' }, '2025\n')).toBe(
      '执行 shell 命令 `date`，输出 1 行',
    );
  });

  it('truncates command longer than 80 chars', () => {
    const longCmd = 'a'.repeat(100);
    const result = summarizeToolResult('shell', { command: longCmd }, 'ok');
    expect(result).toContain('...');
    expect(result.length).toBeLessThanOrEqual(200);
  });

  it('handles TextBlock array result', () => {
    const result = summarizeToolResult(
      'shell',
      { command: 'echo hello' },
      [{ type: 'text', text: 'hello\nworld\n' }],
    );
    expect(result).toBe('执行 shell 命令 `echo hello`，输出 2 行');
  });

  it('handles string args', () => {
    const result = summarizeToolResult('shell', JSON.stringify({ command: 'pwd' }), '/home\n');
    expect(result).toBe('执行 shell 命令 `pwd`，输出 1 行');
  });
});

// ---------------------------------------------------------------------------
// summarizeToolResult — file_read / read_file
// ---------------------------------------------------------------------------

describe('summarizeToolResult — file_read/read_file', () => {
  it('summarizes file read result', () => {
    const content = 'line1\nline2\nline3\n';
    const result = summarizeToolResult('file_read', { path: '/tmp/test.txt' }, content);
    expect(result).toBe(
      `读取文件 \`/tmp/test.txt\`，${bytesOf(content)} 字节，共 3 行`,
    );
  });

  it('supports read_file alias', () => {
    const content = 'data';
    const result = summarizeToolResult('read_file', { path: '/etc/hosts' }, content);
    expect(result).toBe(`读取文件 \`/etc/hosts\`，${bytesOf(content)} 字节，共 1 行`);
  });

  it('handles empty file', () => {
    const result = summarizeToolResult('file_read', { path: '/dev/null' }, '');
    expect(result).toBe('读取文件 `/dev/null`，0 字节，共 0 行');
  });
});

// ---------------------------------------------------------------------------
// summarizeToolResult — file_write / write_file
// ---------------------------------------------------------------------------

describe('summarizeToolResult — file_write/write_file', () => {
  it('summarizes file write result', () => {
    const content = 'written content';
    const result = summarizeToolResult('file_write', { filePath: '/tmp/output.txt' }, content);
    expect(result).toBe(`写入文件 \`/tmp/output.txt\`，${bytesOf(content)} 字节`);
  });

  it('supports write_file alias', () => {
    const content = 'data';
    const result = summarizeToolResult('write_file', { path: '/tmp/out.txt' }, content);
    expect(result).toBe(`写入文件 \`/tmp/out.txt\`，${bytesOf(content)} 字节`);
  });

  it('reads byte count from JSON result when available', () => {
    const result = summarizeToolResult(
      'file_write',
      { filePath: '/tmp/data.bin' },
      JSON.stringify({ bytes: 4096, path: '/tmp/data.bin' }),
    );
    expect(result).toBe('写入文件 `/tmp/data.bin`，4096 字节');
  });

  it('falls back to content byte count when result is not JSON', () => {
    const content = 'abc';
    const result = summarizeToolResult(
      'file_write',
      { path: '/tmp/f.txt' },
      content,
    );
    expect(result).toBe(`写入文件 \`/tmp/f.txt\`，${bytesOf(content)} 字节`);
  });
});

// ---------------------------------------------------------------------------
// summarizeToolResult — http_request / fetch / web_fetch
// ---------------------------------------------------------------------------

describe('summarizeToolResult — http_request/fetch/web_fetch', () => {
  it('summarizes HTTP request with JSON result', () => {
    const result = summarizeToolResult(
      'http_request',
      { method: 'POST', url: 'https://api.example.com/search' },
      JSON.stringify({ statusCode: 200, responseSize: 1024, body: '{"ok":true}' }),
    );
    expect(result).toBe('POST https://api.example.com/search → HTTP 200，1024 字节');
  });

  it('defaults method to GET', () => {
    const result = summarizeToolResult(
      'http_request',
      { url: 'https://example.com' },
      JSON.stringify({ statusCode: 200, responseSize: 512 }),
    );
    expect(result).toBe('GET https://example.com → HTTP 200，512 字节');
  });

  it('handles web_fetch alias', () => {
    const result = summarizeToolResult(
      'web_fetch',
      { url: 'https://example.com/page' },
      JSON.stringify({ statusCode: 200, responseSize: 256 }),
    );
    expect(result).toBe('GET https://example.com/page → HTTP 200，256 字节');
  });

  it('handles fetch alias', () => {
    const result = summarizeToolResult(
      'fetch',
      { url: 'https://example.com', method: 'GET' },
      JSON.stringify({ status: 404, responseSize: 128 }),
    );
    expect(result).toBe('GET https://example.com → HTTP 404，128 字节');
  });

  it('calculates responseSize from body when not directly provided', () => {
    const body = 'response body here';
    const result = summarizeToolResult(
      'http_request',
      { method: 'GET', url: 'https://example.com' },
      JSON.stringify({ statusCode: 200, body }),
    );
    expect(result).toBe(`GET https://example.com → HTTP 200，${bytesOf(body)} 字节`);
  });

  it('falls back to plain text byte count when no JSON', () => {
    const text = 'Hello World';
    const result = summarizeToolResult(
      'web_fetch',
      { url: 'https://example.com' },
      text,
    );
    expect(result).toBe(`GET https://example.com → HTTP ?，${bytesOf(text)} 字节`);
  });

  it('shows ? for unknown status code', () => {
    const result = summarizeToolResult(
      'http_request',
      { method: 'GET', url: 'https://example.com' },
      'plain text response',
    );
    expect(result).toContain('HTTP ?');
  });
});

// ---------------------------------------------------------------------------
// summarizeToolResult — web_search / search
// ---------------------------------------------------------------------------

describe('summarizeToolResult — web_search/search', () => {
  it('summarizes search with JSON results array', () => {
    const result = summarizeToolResult(
      'web_search',
      { query: 'today news' },
      JSON.stringify({ results: [{ title: 'a' }, { title: 'b' }, { title: 'c' }] }),
    );
    expect(result).toBe('搜索 "today news" → 3 条结果');
  });

  it('supports search alias', () => {
    const result = summarizeToolResult(
      'search',
      { query: 'weather' },
      JSON.stringify({ results: [{ title: 'a' }] }),
    );
    expect(result).toBe('搜索 "weather" → 1 条结果');
  });

  it('counts items array', () => {
    const result = summarizeToolResult(
      'web_search',
      { query: 'test' },
      JSON.stringify({ items: [{ title: 'x' }, { title: 'y' }] }),
    );
    expect(result).toBe('搜索 "test" → 2 条结果');
  });

  it('uses total field when available', () => {
    const result = summarizeToolResult(
      'web_search',
      { query: 'news' },
      JSON.stringify({ results: [], total: 42 }),
    );
    expect(result).toBe('搜索 "news" → 42 条结果');
  });

  it('counts lines in plain text result', () => {
    const result = summarizeToolResult(
      'web_search',
      { query: 'test' },
      'result 1\nresult 2\nresult 3\n',
    );
    expect(result).toBe('搜索 "test" → 3 条结果');
  });
});

// ---------------------------------------------------------------------------
// summarizeToolResult — memory-store / memory_store
// ---------------------------------------------------------------------------

describe('summarizeToolResult — memory-store/memory_store', () => {
  it('summarizes memory store with content preview', () => {
    const result = summarizeToolResult(
      'memory_store',
      { content: '用户喜欢喝咖啡，每天至少三杯，偏好美式无糖' },
      'ok',
    );
    // 21 chars, which is under 40 — full content shown
    expect(result).toBe('存储记忆: 用户喜欢喝咖啡，每天至少三杯，偏好美式无糖...');
  });

  it('supports memory-store (dash) alias', () => {
    const result = summarizeToolResult(
      'memory-store',
      { content: '重要信息' },
      'stored',
    );
    expect(result).toBe('存储记忆: 重要信息...');
  });

  it('truncates long content to 40 chars', () => {
    const longContent = 'a'.repeat(100);
    const result = summarizeToolResult('memory_store', { content: longContent }, 'ok');
    expect(result).toContain('...');
    // 40 chars of content + "存储记忆: ..." prefix/suffix
    expect(result.length).toBeLessThanOrEqual(200);
  });
});

// ---------------------------------------------------------------------------
// summarizeToolResult — memory-recall / memory_recall
// ---------------------------------------------------------------------------

describe('summarizeToolResult — memory-recall/memory_recall', () => {
  it('summarizes memory recall with query', () => {
    const result = summarizeToolResult('memory_recall', { query: '用户偏好' }, 'some memories');
    expect(result).toBe('记忆召回: 用户偏好');
  });

  it('supports memory-recall (dash) alias', () => {
    const result = summarizeToolResult('memory-recall', { query: 'config' }, 'results');
    expect(result).toBe('记忆召回: config');
  });
});

// ---------------------------------------------------------------------------
// summarizeToolResult — default (unknown tool)
// ---------------------------------------------------------------------------

describe('summarizeToolResult — default template', () => {
  it('formats unknown tool with name and result preview', () => {
    const result = summarizeToolResult('custom_tool', { foo: 'bar' }, 'Custom tool executed successfully');
    expect(result).toBe('custom_tool: Custom tool executed successfully');
  });

  it('truncates long result in default template to 100 chars', () => {
    const longResult = 'a'.repeat(200);
    const result = summarizeToolResult('unknown_tool', {}, longResult);
    expect(result.length).toBeLessThanOrEqual(200);
    expect(result).toContain('...');
  });
});

// ---------------------------------------------------------------------------
// summarizeToolResult — edge cases & truncation
// ---------------------------------------------------------------------------

describe('summarizeToolResult — edge cases & truncation', () => {
  it('limits final output to 200 characters', () => {
    const hugeResult = 'A'.repeat(10000);
    const result = summarizeToolResult('shell', { command: 'cat hugefile' }, hugeResult);
    expect(result.length).toBeLessThanOrEqual(200);
  });

  it('handles null result gracefully', () => {
    const result = summarizeToolResult('shell', { command: 'echo hi' }, null);
    expect(result).toBe('执行 shell 命令 `echo hi`，输出 0 行');
  });

  it('handles undefined result gracefully', () => {
    const result = summarizeToolResult('shell', { command: 'echo hi' }, undefined);
    expect(result).toBe('执行 shell 命令 `echo hi`，输出 0 行');
  });

  it('handles null/undefined args gracefully', () => {
    const result = summarizeToolResult('shell', null, 'output\n');
    expect(result).toBe('执行 shell 命令 ``，输出 1 行');
  });

  it('handles string array result', () => {
    const result = summarizeToolResult('shell', { command: 'ls' }, ['file1', 'file2', 'file3']);
    expect(result).toBe('执行 shell 命令 `ls`，输出 3 行');
  });

  it('preserves Chinese characters correctly', () => {
    const result = summarizeToolResult('shell', { command: 'echo 你好' }, '你好世界\n');
    expect(result).toBe('执行 shell 命令 `echo 你好`，输出 1 行');
  });

  it('handles tool names with unexpected casing', () => {
    const result = summarizeToolResult('SHELL', { command: 'ls' }, 'ok\n');
    expect(result).toBe('执行 shell 命令 `ls`，输出 1 行');
  });
});
