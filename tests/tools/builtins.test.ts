import { describe, it, expect } from 'vitest';
import { createShellTool } from '../../src/tools/builtins/shell-tool';
import { createFileReadTool } from '../../src/tools/builtins/file-read-tool';
import { createFileSearchTool } from '../../src/tools/builtins/file-search-tool';
import { writeFile, mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { extractToolText, expectToolResultContains } from '../helpers/tool-result';

describe('shell-tool', () => {
  it('executes a simple command', async () => {
    const tool = createShellTool();
    const result = await tool.execute('call-1', { command: 'echo hello' });
    expectToolResultContains(result, 'hello');
  });

  it('returns error for failed command', async () => {
    const tool = createShellTool();
    const result = await tool.execute('call-1', { command: 'false' });
    expectToolResultContains(result, 'Error');
  });

  it('truncates long output', async () => {
    const tool = createShellTool({ maxOutputLength: 50 });
    const result = await tool.execute('call-1', { command: 'python3 -c "print(\'a\' * 200)" || perl -e "print \'a\' x 200" || echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
    expect(extractToolText(result).length).toBeLessThan(200);
    expectToolResultContains(result, 'truncated');
  });
});

describe('file-read-tool', () => {
  it('reads a file', async () => {
    const dir = join(tmpdir(), 'ohmyagent-test-' + Date.now());
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, 'test.txt');
    await writeFile(filePath, 'hello world');

    const tool = createFileReadTool({ allowedRoots: [dir, process.cwd()] });
    const result = await tool.execute('call-1', { path: filePath });
    expect(result.content).toEqual([{ type: 'text', text: 'hello world' }]);

    await rm(dir, { recursive: true });
  });

  it('returns error for missing file', async () => {
    const tool = createFileReadTool();
    const result = await tool.execute('call-1', { path: '__nonexistent_test_file__' });
    expectToolResultContains(result, 'File not found');
  });
});

describe('file-search-tool', () => {
  it('finds files matching pattern', async () => {
    const dir = join(tmpdir(), 'ohmyagent-search-' + Date.now());
    await mkdir(join(dir, 'sub'), { recursive: true });
    await writeFile(join(dir, 'a.ts'), '');
    await writeFile(join(dir, 'b.js'), '');
    await writeFile(join(dir, 'sub', 'c.ts'), '');

    const tool = createFileSearchTool({ allowedRoots: [dir] });
    const result = await tool.execute('call-1', { directory: dir, pattern: '*.ts' });
    expectToolResultContains(result, 'a.ts');
    expectToolResultContains(result, 'c.ts');
    expect(extractToolText(result)).not.toContain('b.js');

    await rm(dir, { recursive: true });
  });

  it('does not return files matching denied patterns', async () => {
    const dir = join(tmpdir(), 'ohmyagent-search-deny-' + Date.now());
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'safe.txt'), '');
    await writeFile(join(dir, '.env'), '');
    await writeFile(join(dir, 'private.pem'), '');

    const tool = createFileSearchTool({
      allowedRoots: [dir],
      deniedPatterns: ['.env', '*.pem'],
    });
    const result = await tool.execute('call-1', { directory: dir, pattern: '*' });
    const text = extractToolText(result);

    expect(text).toContain('safe.txt');
    expect(text).not.toContain('.env');
    expect(text).not.toContain('private.pem');

    await rm(dir, { recursive: true });
  });
});
