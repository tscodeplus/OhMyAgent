import { describe, it, expect } from 'vitest';
import { createFileReadTool } from '../../src/tools/builtins/file-read-tool';
import { writeFile, mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { extractToolText, expectToolResultContains } from '../helpers/tool-result';

describe('FileReadTool path security', () => {
  it('allows reading files under a custom allowed root', async () => {
    const dir = join(tmpdir(), 'ohmyagent-sec-test-' + Date.now());
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, 'safe.txt');
    await writeFile(filePath, 'safe content');

    const tool = createFileReadTool({ allowedRoots: [dir] });
    const result = await tool.execute('call-1', { path: filePath });
    expect(result.content[0].text).toBe('safe content');

    await rm(dir, { recursive: true });
  });

  it('rejects path traversal via allowed roots check', async () => {
    const tool = createFileReadTool();
    const result = await tool.execute('call-1', { path: '../../.env' });
    // path.resolve() normalizes .., then allowed roots check catches the escaped path
    expectToolResultContains(result, 'Access denied');
  });

  it('rejects /etc/passwd via denied pattern', async () => {
    const tool = createFileReadTool({ allowedRoots: ['/'], deniedPatterns: ['/etc/passwd'] });
    const result = await tool.execute('call-1', { path: '/etc/passwd' });
    expectToolResultContains(result, 'Access denied');
  });

  it('rejects home directory reference (~) via allowed roots check', async () => {
    const tool = createFileReadTool();
    // ~ is expanded to real home path, which is outside default allowed root (cwd)
    const result = await tool.execute('call-1', { path: '~/.ssh/id_rsa' });
    expectToolResultContains(result, 'Access denied');
  });

  it('allows home directory reference when home is in allowed roots', async () => {
    const homedir = require('os').homedir();
    const tool = createFileReadTool({ allowedRoots: [homedir] });
    // ~ is always expanded; allowed roots check passes because home dir is in the list
    const result = await tool.execute('call-1', { path: '~/.bashrc' });
    expect(extractToolText(result)).not.toContain('Access denied');
  });

  it('rejects .env file via denied pattern', async () => {
    const tool = createFileReadTool({ allowedRoots: [process.cwd()], deniedPatterns: ['.env'] });
    const result = await tool.execute('call-1', { path: '.env' });
    expectToolResultContains(result, 'Access denied');
  });

  it('rejects .pem file via denied pattern', async () => {
    const tool = createFileReadTool({ allowedRoots: [process.cwd()], deniedPatterns: ['*.pem'] });
    const result = await tool.execute('call-1', { path: 'private-key.pem' });
    expectToolResultContains(result, 'Access denied');
  });

  it('rejects path outside allowed roots', async () => {
    const tool = createFileReadTool({ allowedRoots: ['/tmp'] });
    const result = await tool.execute('call-1', { path: '/var/log/syslog' });
    expectToolResultContains(result, 'Access denied');
  });

  it('allows path traversal when resolved path is within allowed roots', async () => {
    const dir = join(tmpdir(), 'ohmyagent-traversal-test-' + Date.now());
    await mkdir(dir, { recursive: true });
    const subDir = join(dir, 'sub');
    await mkdir(subDir, { recursive: true });
    const filePath = join(dir, 'target.txt');
    await writeFile(filePath, 'traversal allowed');

    // path.resolve() normalizes the .. naturally, no separate flag needed
    const tool = createFileReadTool({ allowedRoots: [dir] });
    const result = await tool.execute('call-1', { path: join(subDir, '../target.txt') });
    expect(extractToolText(result)).toBe('traversal allowed');

    await rm(dir, { recursive: true });
  });

  it('does not leak server path in error messages', async () => {
    const tool = createFileReadTool({ allowedRoots: ['/tmp'], deniedPatterns: ['/etc/passwd'] });
    const result = await tool.execute('call-1', { path: '/etc/passwd' });
    const text = extractToolText(result);
    // Should not contain any actual filesystem paths
    expect(text).not.toContain('/etc/passwd');
    expect(text).not.toContain(process.cwd());
  });
});
