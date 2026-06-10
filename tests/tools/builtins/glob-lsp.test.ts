// ---------------------------------------------------------------------------
// Tests for glob and lsp built-in tools
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { createGlobToolDefinition } from '../../../src/tools/builtins/files/glob-definition';
import { createLspToolDefinition } from '../../../src/tools/builtins/files/lsp-definition';
import type { ToolExecutionContext } from '../../../src/tools/platform/tool-context';
import { extractToolText, expectToolResultContains } from '../../helpers/tool-result';

function testCtx(cwd: string): ToolExecutionContext {
  return {
    cwd,
    services: {} as any,
    policyScope: {} as any,
  };
}

// ---------------------------------------------------------------------------
// Glob tool tests
// ---------------------------------------------------------------------------

describe('glob tool', () => {
  let dir: string;
  let ctx: ToolExecutionContext;

  beforeEach(async () => {
    dir = join(tmpdir(), 'ohmyagent-glob-test-' + Date.now());
    await mkdir(join(dir, 'sub'), { recursive: true });
    await writeFile(join(dir, 'a.ts'), '');
    await writeFile(join(dir, 'b.js'), '');
    await writeFile(join(dir, 'sub', 'c.ts'), '');
    await writeFile(join(dir, 'sub', 'd.json'), '');
    ctx = testCtx(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('finds files matching *.ts in root', async () => {
    const tool = createGlobToolDefinition();
    const result = await tool.execute({ pattern: '*.ts' }, ctx);
    const text = extractToolText(result);
    expect(text).toContain('a.ts');
    expect(text).not.toContain('b.js');
    expect(text).not.toContain('d.json');
  });

  it('finds files matching **/* glob', async () => {
    const tool = createGlobToolDefinition();
    const result = await tool.execute({ pattern: '**/*.ts' }, ctx);
    const text = extractToolText(result);
    expect(text).toContain('a.ts');
    expect(text).toContain('c.ts');
    expect(text).not.toContain('d.json');
  });

  it('returns empty when no files match', async () => {
    const tool = createGlobToolDefinition();
    const result = await tool.execute({ pattern: '*.py' }, ctx);
    expectToolResultContains(result, 'No files matching');
    expect(result.isError).toBeFalsy();
  });

  it('respects maxResults limit', async () => {
    for (let i = 0; i < 10; i++) {
      await writeFile(join(dir, `file${i}.txt`), '');
    }
    const tool = createGlobToolDefinition();
    const result = await tool.execute({ pattern: '*.txt', maxResults: 3 }, ctx);
    const text = extractToolText(result);
    const lines = text.split('\n').filter((l) => l.trim().length > 0 && !l.includes('No files'));
    expect(lines.length).toBeLessThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// LSP tool tests
// ---------------------------------------------------------------------------

describe('lsp tool', () => {
  let dir: string;
  let ctx: ToolExecutionContext;

  const tsCode = [
    '',
    'function greet(name: string): string {',
    '  return "Hello, " + name;',
    '}',
    '',
    'class Calculator {',
    '  add(a: number, b: number): number {',
    '    return a + b;',
    '  }',
    '}',
    '',
    'const PI = 3.14159;',
    '',
    'interface User {',
    '  name: string;',
    '  age: number;',
    '}',
    '',
    'type Point = { x: number; y: number };',
    '',
    'export function formatUser(user: User): string {',
    '  return user.name;',
    '}',
  ].join('\n');

  beforeEach(async () => {
    dir = join(tmpdir(), 'ohmyagent-lsp-test-' + Date.now());
    await mkdir(dir, { recursive: true });
    ctx = testCtx(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('finds symbols in a TypeScript file', async () => {
    const filePath = join(dir, 'test.ts');
    await writeFile(filePath, tsCode);

    const tool = createLspToolDefinition();
    const result = await tool.execute({ action: 'symbols', filePath: 'test.ts', line: 0, column: 0 }, ctx);
    const text = extractToolText(result);

    expect(text).toContain('greet');
    expect(text).toContain('Calculator');
    expect(text).toContain('PI');
    expect(text).toContain('User');
    expect(text).toContain('Point');
    expect(text).toContain('formatUser');
  });

  it('returns hover context at a given position', async () => {
    const filePath = join(dir, 'test.ts');
    await writeFile(filePath, tsCode);

    const tool = createLspToolDefinition();
    // 'greet' is on line 1 (0-indexed), at column 9 (after "function ")
    const result = await tool.execute({ action: 'hover', filePath: 'test.ts', line: 1, column: 9 }, ctx);
    const text = extractToolText(result);

    expect(text).toContain('greet');
    expect(text).toContain('Symbol');
    expect(text).toContain('Context');
  });

  it('returns error for non-TS/JS file extensions', async () => {
    const filePath = join(dir, 'test.py');
    await writeFile(filePath, 'print("hello")');

    const tool = createLspToolDefinition();
    const result = await tool.execute({ action: 'symbols', filePath: 'test.py', line: 0, column: 0 }, ctx);
    const text = extractToolText(result);

    expect(text).toContain('only supports');
    expect(result.isError).toBe(true);
  });

  it('finds symbol references in a file', async () => {
    const filePath = join(dir, 'test.ts');
    await writeFile(filePath, tsCode);

    const tool = createLspToolDefinition();
    // 'name' appears in multiple places: parameters, return statements, interface fields
    // Position at line 1, column 13 is the 'name' parameter
    const result = await tool.execute({ action: 'references', filePath: 'test.ts', line: 1, column: 13 }, ctx);
    const text = extractToolText(result);

    expect(text).toContain('name');
    expect(text).toMatch(/Found \d+ reference/);
  });

  it('reports definition for a symbol in the file', async () => {
    const filePath = join(dir, 'test.ts');
    await writeFile(filePath, tsCode);

    const tool = createLspToolDefinition();
    // Line 11 has 'const PI = ...', column 6 is the start of 'PI'
    const result = await tool.execute({ action: 'definition', filePath: 'test.ts', line: 11, column: 6 }, ctx);
    const text = extractToolText(result);

    expect(text).toContain('PI');
    expect(text).toContain('variable');
  });
});
