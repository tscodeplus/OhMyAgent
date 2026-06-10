// ---------------------------------------------------------------------------
// Tests for file_write, file_edit, and grep v4 ToolDefinition tools
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFileWriteToolDefinition } from '../../../src/tools/builtins/files/write-definition';
import { createFileEditToolDefinition } from '../../../src/tools/builtins/files/edit-definition';
import { createGrepToolDefinition } from '../../../src/tools/builtins/files/grep-definition';
import type { ToolExecutionContext } from '../../../src/tools/platform/tool-context';
import { extractToolText, expectToolResultContains } from '../../helpers/tool-result';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal ToolExecutionContext for testing. */
function makeCtx(cwd: string): ToolExecutionContext {
  return {
    cwd,
    services: undefined as any,
    policyScope: {
      toolsProfile: 'standard',
      readRoots: [],
      writeRoots: [],
      deniedPatterns: [],
      shellExecMode: 'balanced',
      sessionApprovals: [],
      appApprovals: [],
      readOnly: false,
      computerUseEnabled: false,
    },
  };
}

/** Create a temporary directory that is cleaned up after the test. */
function createTempDir(): string {
  const dir = join(tmpdir(), `ohmyagent-file-tools-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// file_write
// ---------------------------------------------------------------------------

describe('file_write', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes a file and returns bytes written', async () => {
    const tool = createFileWriteToolDefinition();
    const filePath = join(tmpDir, 'hello.txt');
    const ctx = makeCtx(tmpDir);

    const result = await tool.execute({ filePath: 'hello.txt', content: 'Hello, World!' }, ctx);

    expect(result.isError).toBeFalsy();
    expectToolResultContains(result, 'Successfully wrote');
    expectToolResultContains(result, 'hello.txt');
    expect(readFileSync(filePath, 'utf-8')).toBe('Hello, World!');
  });

  it('creates parent directories automatically', async () => {
    const tool = createFileWriteToolDefinition();
    const nestedDir = join(tmpDir, 'a', 'b', 'c');
    const filePath = join(nestedDir, 'deep.txt');
    const ctx = makeCtx(tmpDir);

    const result = await tool.execute({ filePath: join('a', 'b', 'c', 'deep.txt'), content: 'nested' }, ctx);

    expect(result.isError).toBeFalsy();
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, 'utf-8')).toBe('nested');
  });

  it('writes to the canonical path approved by policy', async () => {
    const tool = createFileWriteToolDefinition();
    const approvedDir = join(tmpDir, 'approved');
    mkdirSync(approvedDir);
    const approvedPath = join(approvedDir, 'safe.txt');
    const ctx = { ...makeCtx(tmpDir), resolvedPath: approvedPath };

    const result = await tool.execute({ filePath: 'ignored.txt', content: 'approved' }, ctx);

    expect(result.isError).toBeFalsy();
    expect(readFileSync(approvedPath, 'utf-8')).toBe('approved');
    expect(existsSync(join(tmpDir, 'ignored.txt'))).toBe(false);
  });

  it('returns error for an invalid path (permission denied edge case)', async () => {
    const tool = createFileWriteToolDefinition();
    const ctx = makeCtx('/');

    const result = await tool.execute({ filePath: '/dev/null/test_write', content: 'should fail' }, ctx);

    expect(result.isError).toBe(true);
    expectToolResultContains(result, 'Failed to write file');
  });

  it('refuses to write through a symlink at the target (TOCTOU/path-escape)', async () => {
    const tool = createFileWriteToolDefinition();
    // Simulate an attacker planting a symlink at the approved target that
    // points outside the write root, after the policy check resolved the path.
    const outside = join(tmpDir, 'outside-secret.txt');
    writeFileSync(outside, 'ORIGINAL', 'utf-8');
    const target = join(tmpDir, 'link.txt');
    symlinkSync(outside, target);

    const ctx = { ...makeCtx(tmpDir), resolvedPath: target };
    const result = await tool.execute({ filePath: 'link.txt', content: 'HIJACKED' }, ctx);

    expect(result.isError).toBe(true);
    expectToolResultContains(result, 'symlink');
    // The symlink's destination must be untouched.
    expect(readFileSync(outside, 'utf-8')).toBe('ORIGINAL');
  });
});

// ---------------------------------------------------------------------------
// file_edit
// ---------------------------------------------------------------------------

describe('file_edit', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('replaces a single occurrence in a file', async () => {
    const filePath = join(tmpDir, 'test.txt');
    writeFileSync(filePath, 'Hello World', 'utf-8');
    const ctx = makeCtx(tmpDir);
    const tool = createFileEditToolDefinition();

    const result = await tool.execute(
      { filePath: 'test.txt', oldString: 'World', newString: 'There' },
      ctx,
    );

    expect(result.isError).toBeFalsy();
    expectToolResultContains(result, 'Successfully replaced');
    expect(readFileSync(filePath, 'utf-8')).toBe('Hello There');
  });

  it('returns error when oldString is not found', async () => {
    const filePath = join(tmpDir, 'test.txt');
    writeFileSync(filePath, 'Hello World', 'utf-8');
    const ctx = makeCtx(tmpDir);
    const tool = createFileEditToolDefinition();

    const result = await tool.execute(
      { filePath: 'test.txt', oldString: 'Nonexistent', newString: 'x' },
      ctx,
    );

    expect(result.isError).toBe(true);
    expectToolResultContains(result, 'was not found');
  });

  it('returns error when multiple occurrences exist and replaceAll is not set', async () => {
    const filePath = join(tmpDir, 'test.txt');
    writeFileSync(filePath, 'foo bar foo baz foo', 'utf-8');
    const ctx = makeCtx(tmpDir);
    const tool = createFileEditToolDefinition();

    const result = await tool.execute(
      { filePath: 'test.txt', oldString: 'foo', newString: 'qux' },
      ctx,
    );

    expect(result.isError).toBe(true);
    expectToolResultContains(result, 'appears 3 times');
    expectToolResultContains(result, 'replaceAll=true');
  });

  it('replaces all occurrences when replaceAll is true', async () => {
    const filePath = join(tmpDir, 'test.txt');
    writeFileSync(filePath, 'foo bar foo baz foo', 'utf-8');
    const ctx = makeCtx(tmpDir);
    const tool = createFileEditToolDefinition();

    const result = await tool.execute(
      { filePath: 'test.txt', oldString: 'foo', newString: 'qux', replaceAll: true },
      ctx,
    );

    expect(result.isError).toBeFalsy();
    expect(readFileSync(filePath, 'utf-8')).toBe('qux bar qux baz qux');
  });

  it('returns error when file does not exist', async () => {
    const ctx = makeCtx(tmpDir);
    const tool = createFileEditToolDefinition();

    const result = await tool.execute(
      { filePath: 'nonexistent.txt', oldString: 'x', newString: 'y' },
      ctx,
    );

    expect(result.isError).toBe(true);
    expectToolResultContains(result, 'not found');
  });
});

// ---------------------------------------------------------------------------
// grep
// ---------------------------------------------------------------------------

describe('grep', () => {
  let tmpDir: string;
  let ctx: ToolExecutionContext;

  beforeEach(() => {
    tmpDir = createTempDir();
    ctx = makeCtx(tmpDir);
    // Create some test files
    writeFileSync(join(tmpDir, 'file1.ts'), 'hello\nworld\nfoo\n', 'utf-8');
    writeFileSync(join(tmpDir, 'file2.js'), 'console.log("hello")\nconst x = 1;\n', 'utf-8');
    writeFileSync(join(tmpDir, 'file3.txt'), 'just some text\n', 'utf-8');
    mkdirSync(join(tmpDir, 'subdir'));
    writeFileSync(join(tmpDir, 'subdir', 'nested.ts'), 'world inside subdir\n', 'utf-8');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('finds matching lines in files', async () => {
    const tool = createGrepToolDefinition();

    const result = await tool.execute(
      { pattern: 'hello', path: tmpDir },
      { ...ctx, cwd: tmpDir },
    );

    expect(result.isError).toBeFalsy();
    const text = extractToolText(result);
    expect(text).toContain('file1.ts:1: hello');
    expect(text).toContain('file2.js:1: console.log("hello")');
  });

  it('returns empty result when no matches found', async () => {
    const tool = createGrepToolDefinition();

    const result = await tool.execute(
      { pattern: 'XYZZZZ_NONEXISTENT_12345', path: tmpDir },
      { ...ctx, cwd: tmpDir },
    );

    expect(result.isError).toBeFalsy();
    expectToolResultContains(result, 'No matches found');
  });

  it('returns error for invalid regex pattern', async () => {
    const tool = createGrepToolDefinition();

    const result = await tool.execute(
      { pattern: '[invalid', path: tmpDir },
      { ...ctx, cwd: tmpDir },
    );

    expect(result.isError).toBe(true);
    expectToolResultContains(result, 'Invalid regex pattern');
  });

  it('respects include glob filter', async () => {
    const tool = createGrepToolDefinition();

    const result = await tool.execute(
      { pattern: 'hello', include: '*.ts', path: tmpDir },
      { ...ctx, cwd: tmpDir },
    );

    expect(result.isError).toBeFalsy();
    const text = extractToolText(result);
    expect(text).toContain('file1.ts:1: hello');
    expect(text).not.toContain('file2.js');
  });

  it('respects maxResults cap', async () => {
    // Create a file with many matching lines
    const manyLines = Array.from({ length: 50 }, (_, i) => `match line ${i}`).join('\n');
    writeFileSync(join(tmpDir, 'big.txt'), manyLines, 'utf-8');

    const tool = createGrepToolDefinition();

    const result = await tool.execute(
      { pattern: 'match', maxResults: 10, path: tmpDir },
      { ...ctx, cwd: tmpDir },
    );

    expect(result.isError).toBeFalsy();
    const text = extractToolText(result);
    const lines = text.split('\n').filter(l => l.length > 0);
    expect(lines.length).toBe(10);
  });

  it('searches in a specified subdirectory', async () => {
    const tool = createGrepToolDefinition();

    const result = await tool.execute(
      { pattern: 'world', path: 'subdir' },
      { ...ctx, cwd: tmpDir },
    );

    expect(result.isError).toBeFalsy();
    const text = extractToolText(result);
    expect(text).toContain('nested.ts:1: world inside subdir');
    expect(text).not.toContain('file1.ts');
  });
});
